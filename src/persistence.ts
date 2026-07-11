import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, realpath, rename, rm, unlink } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { hostname } from "node:os"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import {
  GOAL_LIMITS,
  GoalContractError,
  assertArchiveEntries,
  assertPersistedGoals,
  codePointLength,
  validatePersistedGoal,
  validateArchiveEntry,
} from "./goal-contract.ts"
import { isRecord } from "./records.ts"
import { defaultGoalPolicy } from "./types.ts"
import type {
  GoalArchiveEntry,
  GoalArchiveStatus,
  GoalClock,
  GoalPolicy,
  PersistedGoalArchiveV1,
  PersistedStateV2,
  StoredGoal,
} from "./types.ts"

const LEGACY_VERSION = 1
const VERSION = 2
const LOCK_MAX_BYTES = 4 * 1024
const LOCK_TIMEOUT_MS = 10_000
const LOCK_RETRY_MS = 25
const LOCK_INITIALIZATION_GRACE_MS = 5_000
const LEDGER_READ_CHUNK_BYTES = 64 * 1024
const LEDGER_LINE_BYTES = GOAL_LIMITS.snapshotBytes
const LEDGER_COMPACTION_BYTES = 8 * 1024 * 1024
const LEDGER_COMPACTION_ACTIONS = 256
const LEDGER_CHECKPOINT_INTERVAL = 32
export const LEDGER_STREAM_MEMORY_BYTES = LEDGER_LINE_BYTES + LEDGER_READ_CHUNK_BYTES
export const TERMINAL_RETENTION_COUNT = 100
export const TERMINAL_RETENTION_SECONDS = 30 * 24 * 60 * 60

export type PersistenceLoadOutcome =
  | "missing"
  | "valid"
  | "migrated-v1"
  | "recovered-missing"
  | "recovered-corrupt"
  | "recovered-partial"
  | "replayed-ledger"

export type RecoveryDiagnostic = {
  code: string
  count?: number
  snapshotVersion?: number
  ledgerVersion?: number
  threadId?: string
  sequence?: number
  action?: "set" | "checkpoint" | "patch" | "checkpoint-set" | "clear"
}

export type LoadedGoals = {
  goals: StoredGoal[]
  archive: GoalArchiveEntry[]
  recoveredFromLedger: boolean
  recoveredThreadIds: string[]
  outcome: PersistenceLoadOutcome
  lastSequence: number
  diagnostics: RecoveryDiagnostic[]
}

export class UnsupportedPersistenceVersionError extends Error {
  readonly source: "snapshot" | "ledger" | "archive"
  readonly version: number

  constructor(source: "snapshot" | "ledger" | "archive", version: number) {
    super(`Unsupported future ${source} version ${version}; current version is ${VERSION}.`)
    this.name = "UnsupportedPersistenceVersionError"
    this.source = source
    this.version = version
  }
}

export class PersistenceRecoveryError extends Error {
  readonly diagnostics: RecoveryDiagnostic[]

  constructor(message: string, diagnostics: readonly RecoveryDiagnostic[]) {
    super(message)
    this.name = "PersistenceRecoveryError"
    this.diagnostics = [...diagnostics]
  }
}

export class PersistenceLockError extends Error {
  constructor(path: string, reason: string) {
    super(`Persistence lock "${path}" ${reason}.`)
    this.name = "PersistenceLockError"
  }
}

export type PersistenceFailpoint =
  | "before-ledger-append"
  | "after-ledger-append"
  | "after-snapshot-write"
  | "before-ledger-compaction-rename"
  | "after-ledger-compaction-rename"

export type PersistenceTestHooks = {
  failpoint?: (point: PersistenceFailpoint) => void | Promise<void>
  isProcessAlive?: (pid: number) => boolean
  hostname?: string
  nowMilliseconds?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  lockTimeoutMs?: number
  lockInitializationGraceMs?: number
  ledgerCompactionBytes?: number
  ledgerCompactionActions?: number
}

export type PersistencePathPolicy = {
  trustRoot: string
  projectLocal: boolean
}

type PreparedPaths = {
  state: string
  ledger: string
  archive: string
  lock: string
  parent: string
  canonicalRoot: string
  configuredRoot: string
  projectLocal: boolean
}

export type ArchiveMutation =
  | { action: "upsert"; entry: GoalArchiveEntry }
  | { action: "purge"; threadId: string }

type LoadedArchive = {
  entries: GoalArchiveEntry[]
  lastSequence: number
}

type LedgerEntry =
  | { action: "set" | "checkpoint" | "update"; goal: StoredGoal }
  | { action: "clear"; threadId: string }

type LedgerRecord =
  | {
      sequence: number
      timestamp: number
      action: "checkpoint"
      threadId: string
      goal: StoredGoal
      version: 1 | 2
    }
  | {
      sequence: number
      timestamp: number
      action: "patch"
      threadId: string
      changes: Record<string, unknown>
      version: 2
    }
  | {
      sequence: number
      timestamp: number
      action: "checkpoint-set"
      goals: StoredGoal[]
      version: 2
    }
  | {
      sequence: number
      timestamp: number
      action: "clear"
      threadId: string
      version: 1 | 2
    }

type LedgerAnalysis = {
  records: LedgerRecord[]
  maxSequence: number
  legacyCount: number
  diagnostics: RecoveryDiagnostic[]
  truncateBytes: number | undefined
  byteLength: number
  futureVersion: number | undefined
}

type LedgerStreamResult = {
  exists: boolean
  byteLength: number
  truncateBytes: number | undefined
}

type SnapshotAnalysis =
  | { kind: "missing"; diagnostics: RecoveryDiagnostic[] }
  | { kind: "corrupt"; diagnostics: RecoveryDiagnostic[] }
  | {
      kind: "valid"
      version: 1 | 2
      lastSequence: number
      goals: Map<string, StoredGoal>
      complete: boolean
      invalidThreadIds: Set<string>
      invalidUnknownCount: number
      policyMigrated: boolean
      diagnostics: RecoveryDiagnostic[]
    }

type InternalLoad = Omit<LoadedGoals, "archive"> & {
  rewriteNeeded: boolean
  ledgerTruncateBytes: number | undefined
  ledgerBytes: number
  ledgerActions: number
  ledgerFutureVersion: number | undefined
}

type LockLease = {
  path: string
  handle: FileHandle
  device: number
  inode: number
}

type LockOwner = {
  pid: number
  hostname: string
  nonce: string
  createdAt: number
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === "string" ? error.code : ""
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT"
}

function unsafePath(path: string, reason: string): Error {
  return new Error(`Unsafe persistence path "${path}": ${reason}.`)
}

async function pathStats(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

async function requireDirectory(path: string): Promise<void> {
  const stats = await pathStats(path)
  if (!stats) throw unsafePath(path, "trusted directory does not exist")
  if (stats.isSymbolicLink()) throw unsafePath(path, "directory component is a symbolic link")
  if (!stats.isDirectory()) throw unsafePath(path, "directory component is not a directory")
}

async function ensureDirectory(path: string): Promise<void> {
  let stats = await pathStats(path)
  if (!stats) {
    try {
      await mkdir(path, { mode: 0o700 })
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
    }
    stats = await pathStats(path)
  }
  if (!stats) throw unsafePath(path, "directory component could not be created")
  if (stats.isSymbolicLink()) throw unsafePath(path, "directory component is a symbolic link")
  if (!stats.isDirectory()) throw unsafePath(path, "directory component is not a directory")
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

function safeThreadId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined
  if (codePointLength(value) > GOAL_LIMITS.identifierCodePoints) return undefined
  return value
}

function applyLedgerRecord(
  goals: Map<string, StoredGoal>,
  record: LedgerRecord,
  loadedAtSeconds: number,
  policyDefaults: GoalPolicy,
): void {
  if (record.action === "checkpoint-set") {
    goals.clear()
    for (const goal of record.goals) goals.set(goal.threadId, structuredClone(goal))
    return
  }
  if (record.action === "clear") {
    goals.delete(record.threadId)
    return
  }
  if (record.action === "checkpoint") {
    goals.set(record.threadId, structuredClone(record.goal))
    return
  }
  const previous = goals.get(record.threadId)
  if (!previous) {
    throw new PersistenceRecoveryError("Goal patch has no earlier checkpoint.", [
      { code: "patch-without-checkpoint", threadId: record.threadId, sequence: record.sequence, action: "patch" },
    ])
  }
  if (Object.hasOwn(record.changes, "threadId")) {
    throw new PersistenceRecoveryError("Goal patch attempts to change its thread identifier.", [
      { code: "patch-thread-id", threadId: record.threadId, sequence: record.sequence, action: "patch" },
    ])
  }
  const result = validatePersistedGoal(
    { ...previous, ...record.changes },
    loadedAtSeconds,
    `ledger[${record.sequence}]`,
    [],
    policyDefaults,
  )
  if (!result.ok || result.value.threadId !== record.threadId) {
    throw new GoalContractError("Invalid goal ledger patch", result.ok
      ? [{ path: "threadId", code: "identity", message: "must match the patch target" }]
      : result.issues)
  }
  goals.set(record.threadId, result.value)
}

function cloneGoals(goals: ReadonlyMap<string, StoredGoal>): Map<string, StoredGoal> {
  return new Map([...goals].map(([threadId, goal]) => [threadId, structuredClone(goal)]))
}

export type RecoveryTransform = (goal: StoredGoal) => StoredGoal

export function archiveEntryForGoal(
  goal: StoredGoal,
  status: GoalArchiveStatus,
  terminalAt: number,
): GoalArchiveEntry {
  return {
    id: randomUUID(),
    threadId: goal.threadId,
    objective: goal.objective,
    status,
    terminalAt,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    continuationCount: goal.continuationCount,
    lastEvidence: goal.lastEvidence,
    blockedReason: goal.blockedReason,
    checks: goal.checks.map((check) => ({ id: check.id, status: check.status })),
  }
}

export function archiveEntryMatchesGoal(
  entry: GoalArchiveEntry,
  goal: StoredGoal,
  status: GoalArchiveStatus,
  terminalAt: number,
): boolean {
  return entry.threadId === goal.threadId &&
    entry.objective === goal.objective &&
    entry.status === status &&
    entry.terminalAt === terminalAt &&
    entry.tokensUsed === goal.tokensUsed &&
    entry.timeUsedSeconds === goal.timeUsedSeconds &&
    entry.continuationCount === goal.continuationCount &&
    entry.lastEvidence === goal.lastEvidence &&
    entry.blockedReason === goal.blockedReason &&
    entry.checks.length === goal.checks.length &&
    entry.checks.every((check, index) => {
      const goalCheck = goal.checks[index]
      return check.id === goalCheck?.id && check.status === goalCheck.status
    })
}

export function retainArchiveEntries(
  entries: readonly GoalArchiveEntry[],
  nowSecondsValue: number,
): GoalArchiveEntry[] {
  return entries
    .filter((entry) => entry.terminalAt >= nowSecondsValue - TERMINAL_RETENTION_SECONDS)
    .sort((left, right) => {
      const timestampOrder = right.terminalAt - left.terminalAt
      if (timestampOrder !== 0) return timestampOrder
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    })
    .slice(0, GOAL_LIMITS.archiveEntries)
    .map((entry) => structuredClone(entry))
}

function applyArchiveMutation(
  entries: readonly GoalArchiveEntry[],
  mutation: ArchiveMutation,
): GoalArchiveEntry[] {
  if (mutation.action === "purge") return entries.filter((entry) => entry.threadId !== mutation.threadId)
  const next = entries.filter((entry) => entry.id !== mutation.entry.id)
  next.push(structuredClone(mutation.entry))
  return next
}

export function retainGoals(
  goals: readonly StoredGoal[],
  nowSecondsValue: number,
): { goals: StoredGoal[]; prunedThreadIds: string[] } {
  const durable: StoredGoal[] = []
  const terminal = goals
    .filter((goal) => goal.status === "blocked" || goal.status === "budgetLimited" || goal.status === "complete")
    .filter((goal) => goal.updatedAt >= nowSecondsValue - TERMINAL_RETENTION_SECONDS)
    .sort((left, right) => {
      const timestampOrder = right.updatedAt - left.updatedAt
      if (timestampOrder !== 0) return timestampOrder
      return left.threadId < right.threadId ? -1 : left.threadId > right.threadId ? 1 : 0
    })
    .slice(0, TERMINAL_RETENTION_COUNT)
  const retainedTerminal = new Set(terminal.map((goal) => goal.threadId))
  const prunedThreadIds: string[] = []
  for (const goal of goals) {
    const isTerminal = goal.status === "blocked" || goal.status === "budgetLimited" || goal.status === "complete"
    if (!isTerminal || retainedTerminal.has(goal.threadId)) durable.push(goal)
    else prunedThreadIds.push(goal.threadId)
  }
  return { goals: durable, prunedThreadIds }
}


export class GoalPersistence {
  readonly #configuredPath: string
  readonly #pathPolicy: PersistencePathPolicy
  readonly #clock: GoalClock
  readonly #hooks: PersistenceTestHooks
  readonly #policyDefaults: GoalPolicy
  #writeQueue: Promise<void> = Promise.resolve()
  #saveCounter = 0
  #prepared: PreparedPaths | undefined
  #recoveryTransform: RecoveryTransform | undefined

  constructor(
    path: string,
    clock: GoalClock = nowSeconds,
    pathPolicy?: PersistencePathPolicy,
    hooks: PersistenceTestHooks = {},
    policyDefaults: GoalPolicy = defaultGoalPolicy(),
  ) {
    this.#configuredPath = resolve(path)
    this.#pathPolicy = pathPolicy ?? {
      trustRoot: dirname(this.#configuredPath),
      projectLocal: false,
    }
    this.#clock = clock
    this.#hooks = hooks
    this.#policyDefaults = structuredClone(policyDefaults)
  }

  async load(transformRecovered?: RecoveryTransform): Promise<LoadedGoals> {
    if (transformRecovered) this.#recoveryTransform = transformRecovered
    return this.#withWriteQueue(async () =>
      this.#withLock(async () => {
        const loaded = await this.#loadInternal()
        const persistedArchive = await this.#loadArchive()
        const retention = retainGoals(loaded.goals, this.#clock())
        if (loaded.ledgerFutureVersion !== undefined) {
          if (loaded.rewriteNeeded || retention.prunedThreadIds.length > 0) {
            throw new UnsupportedPersistenceVersionError("ledger", loaded.ledgerFutureVersion)
          }
          return this.#publicLoad(loaded, persistedArchive.entries)
        }
        loaded.goals = retention.goals
        if (retention.prunedThreadIds.length > 0) loaded.rewriteNeeded = true
        await this.#applyRecoveryTransform(loaded)
        let archive = retainArchiveEntries(persistedArchive.entries, this.#clock())
        for (const goal of loaded.goals) {
          if (goal.status !== "complete" && goal.status !== "blocked" && goal.status !== "budgetLimited") continue
          const status = goal.status
          if (archive.some((entry) => archiveEntryMatchesGoal(entry, goal, status, goal.updatedAt))) continue
          archive = applyArchiveMutation(archive, {
            action: "upsert",
            entry: archiveEntryForGoal(goal, status, goal.updatedAt),
          })
        }
        archive = retainArchiveEntries(archive, this.#clock())
        const archiveChanged = JSON.stringify(archive) !== JSON.stringify(persistedArchive.entries)
        if (loaded.rewriteNeeded) await this.#writeSnapshot(loaded.goals, loaded.lastSequence)
        if (archiveChanged) await this.#writeArchive(archive, loaded.lastSequence)
        if (
          loaded.lastSequence > 0 &&
          (retention.prunedThreadIds.length > 0 || this.#compactionThresholdReached(loaded.ledgerActions, loaded.ledgerBytes))
        ) {
          await this.#compactLedger(loaded.goals, loaded.lastSequence)
        }
        return this.#publicLoad(loaded, archive)
      }),
    )
  }

  async persist(
    goals: readonly StoredGoal[],
    ledgerEntry?: LedgerEntry,
    archiveMutation?: ArchiveMutation,
    archiveFirst = false,
  ): Promise<void> {
    await this.#withWriteQueue(async () => {
      assertPersistedGoals(goals, this.#clock(), "Invalid goal state")
      await this.#withLock(async () => {
        const loaded = await this.#loadInternal()
        const persistedArchive = await this.#loadArchive()
        if (loaded.ledgerFutureVersion !== undefined) {
          throw new UnsupportedPersistenceVersionError("ledger", loaded.ledgerFutureVersion)
        }
        await this.#applyRecoveryTransform(loaded)
        let archive = persistedArchive.entries
        if (archiveMutation) {
          if (archiveMutation.action === "upsert") {
            assertArchiveEntries([archiveMutation.entry], this.#clock(), "Invalid archive mutation")
          }
          archive = retainArchiveEntries(applyArchiveMutation(archive, archiveMutation), this.#clock())
        }
        if (!ledgerEntry) {
          await this.#writeSnapshot(goals, loaded.lastSequence)
          if (archiveMutation) await this.#writeArchive(archive, loaded.lastSequence)
          return
        }

        if (ledgerEntry.action !== "clear") {
          assertPersistedGoals([ledgerEntry.goal], this.#clock(), "Invalid goal ledger entry")
        } else if (!safeThreadId(ledgerEntry.threadId)) {
          throw new GoalContractError("Invalid goal ledger entry", [
            { path: "threadId", code: "identifier", message: "must be a bounded non-empty identifier" },
          ])
        }

        const sequence = loaded.lastSequence + 1
        if (!Number.isSafeInteger(sequence)) {
          throw new PersistenceRecoveryError("Persistence sequence is exhausted.", [
            { code: "sequence-exhausted", sequence: loaded.lastSequence },
          ])
        }
        let ledgerBytes = loaded.ledgerTruncateBytes ?? loaded.ledgerBytes
        if (loaded.ledgerTruncateBytes !== undefined) {
          await this.#truncateLedger(loaded.ledgerTruncateBytes)
        }
        const durable = new Map(loaded.goals.map((goal) => [goal.threadId, structuredClone(goal)]))
        const record = this.#recordFromEntry(ledgerEntry, sequence, durable)
        if (!record) {
          if (loaded.rewriteNeeded) await this.#writeSnapshot(loaded.goals, loaded.lastSequence)
          if (archiveMutation) await this.#writeArchive(archive, loaded.lastSequence)
          return
        }
        const encoded = this.#encodeLedgerRecord(record)
        if (archiveMutation && archiveFirst) await this.#writeArchive(archive, sequence)
        if (ledgerBytes + Buffer.byteLength(encoded) > GOAL_LIMITS.ledgerBytes && loaded.lastSequence > 0) {
          ledgerBytes = await this.#compactLedger([...durable.values()], loaded.lastSequence)
        }
        await this.#runFailpoint("before-ledger-append")
        await this.#appendLedger(encoded)
        await this.#runFailpoint("after-ledger-append")
        applyLedgerRecord(durable, record, this.#clock(), this.#policyDefaults)
        const retention = retainGoals([...durable.values()], this.#clock())
        await this.#writeSnapshot(retention.goals, sequence)
        await this.#runFailpoint("after-snapshot-write")
        if (archiveMutation && !archiveFirst) await this.#writeArchive(archive, sequence)
        const actionCount = loaded.ledgerActions + 1
        const currentLedgerBytes = ledgerBytes + Buffer.byteLength(encoded)
        if (
          ledgerEntry.action === "clear" ||
          retention.prunedThreadIds.length > 0 ||
          this.#compactionThresholdReached(actionCount, currentLedgerBytes)
        ) {
          await this.#compactLedger(retention.goals, sequence)
        }
      })
    })
  }

  async purge(threadId: string): Promise<{ currentRemoved: boolean; archiveRemoved: boolean }> {
    if (!safeThreadId(threadId)) {
      throw new GoalContractError("Invalid archive purge", [
        { path: "threadId", code: "identifier", message: "must be a bounded non-empty identifier" },
      ])
    }
    return this.#withWriteQueue(async () =>
      this.#withLock(async () => {
        const loaded = await this.#loadInternal()
        if (loaded.ledgerFutureVersion !== undefined) {
          throw new UnsupportedPersistenceVersionError("ledger", loaded.ledgerFutureVersion)
        }
        const persistedArchive = await this.#loadArchive()
        const archive = persistedArchive.entries.filter((entry) => entry.threadId !== threadId)
        const archiveRemoved = archive.length !== persistedArchive.entries.length
        const durable = new Map(loaded.goals.map((goal) => [goal.threadId, structuredClone(goal)]))
        const currentRemoved = durable.delete(threadId)
        const sequence = currentRemoved ? loaded.lastSequence + 1 : loaded.lastSequence
        if (!Number.isSafeInteger(sequence)) {
          throw new PersistenceRecoveryError("Persistence sequence is exhausted.", [
            { code: "sequence-exhausted", sequence: loaded.lastSequence },
          ])
        }
        if (archiveRemoved) await this.#writeArchive(archive, sequence)
        if (!currentRemoved) {
          if (loaded.rewriteNeeded) await this.#writeSnapshot([...durable.values()], loaded.lastSequence)
          return { currentRemoved, archiveRemoved }
        }
        if (loaded.ledgerTruncateBytes !== undefined) await this.#truncateLedger(loaded.ledgerTruncateBytes)
        const record: LedgerRecord = {
          version: VERSION,
          sequence,
          timestamp: Date.now(),
          action: "clear",
          threadId,
        }
        await this.#appendLedger(this.#encodeLedgerRecord(record))
        await this.#writeSnapshot([...durable.values()], sequence)
        await this.#compactLedger([...durable.values()], sequence)
        return { currentRemoved, archiveRemoved }
      }),
    )
  }

  async #withWriteQueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#writeQueue.then(task, task)
    this.#writeQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  #publicLoad(loaded: InternalLoad, archive: readonly GoalArchiveEntry[]): LoadedGoals {
    return {
      goals: loaded.goals.map((goal) => structuredClone(goal)),
      archive: archive.map((entry) => structuredClone(entry)),
      recoveredFromLedger: loaded.recoveredFromLedger,
      recoveredThreadIds: [...loaded.recoveredThreadIds],
      outcome: loaded.outcome,
      lastSequence: loaded.lastSequence,
      diagnostics: [...loaded.diagnostics],
    }
  }

  async #applyRecoveryTransform(loaded: InternalLoad): Promise<void> {
    if (!this.#recoveryTransform || loaded.recoveredThreadIds.length === 0) return
    const recovered = new Set(loaded.recoveredThreadIds)
    loaded.goals = loaded.goals.map((goal) => {
      if (!recovered.has(goal.threadId)) return goal
      return this.#recoveryTransform?.(structuredClone(goal)) ?? goal
    })
    assertPersistedGoals(loaded.goals, this.#clock(), "Invalid recovered goal state")
    loaded.rewriteNeeded = true
  }

  async #loadInternal(): Promise<InternalLoad> {
    const snapshot = await this.#analyzeSnapshot()
    const ledger = await this.#analyzeLedger(snapshot)
    const diagnostics = [...snapshot.diagnostics, ...ledger.diagnostics]

    if (snapshot.kind === "missing" || snapshot.kind === "corrupt") {
      if (ledger.records.length === 0) {
        if (snapshot.kind === "missing") {
          return {
            goals: [],
            recoveredFromLedger: false,
            recoveredThreadIds: [],
            outcome: "missing",
            lastSequence: ledger.maxSequence,
            diagnostics,
            rewriteNeeded: false,
            ledgerTruncateBytes: ledger.truncateBytes,
            ledgerBytes: ledger.byteLength,
            ledgerActions: ledger.records.length,
            ledgerFutureVersion: ledger.futureVersion,
          }
        }
        throw new PersistenceRecoveryError("Corrupt persistence snapshot has no recoverable ledger records.", diagnostics)
      }
      const recovered = new Map<string, StoredGoal>()
      for (const record of ledger.records) applyLedgerRecord(recovered, record, this.#clock(), this.#policyDefaults)
      this.#assertRecoveredGoalCount(recovered, diagnostics)
      return {
        goals: [...recovered.values()],
        recoveredFromLedger: true,
        recoveredThreadIds: [...recovered.keys()],
        outcome: snapshot.kind === "missing" ? "recovered-missing" : "recovered-corrupt",
        lastSequence: ledger.maxSequence,
        diagnostics,
        rewriteNeeded: true,
        ledgerTruncateBytes: ledger.truncateBytes,
        ledgerBytes: ledger.byteLength,
        ledgerActions: ledger.records.length,
        ledgerFutureVersion: ledger.futureVersion,
      }
    }

    const baseSequence = snapshot.version === 1 ? ledger.legacyCount : snapshot.lastSequence
    const goals = cloneGoals(snapshot.goals)
    const recoveredThreadIds = new Set<string>()

    if (!snapshot.complete) {
      const ledgerAtSnapshot = new Map<string, StoredGoal>()
      for (const record of ledger.records) {
        if (record.sequence > baseSequence) break
        applyLedgerRecord(ledgerAtSnapshot, record, this.#clock(), this.#policyDefaults)
      }
      for (const threadId of snapshot.invalidThreadIds) {
        const recovered = ledgerAtSnapshot.get(threadId)
        if (!recovered) continue
        goals.set(threadId, recovered)
        recoveredThreadIds.add(threadId)
      }
      if (snapshot.invalidUnknownCount > 0) {
        for (const [threadId, goal] of ledgerAtSnapshot) {
          if (goals.has(threadId)) continue
          goals.set(threadId, goal)
          recoveredThreadIds.add(threadId)
        }
      }
      if (goals.size === 0) {
        throw new PersistenceRecoveryError("Partially invalid persistence snapshot has no recoverable goals.", diagnostics)
      }
    }

    let replayed = false
    for (const record of ledger.records) {
      if (record.sequence <= baseSequence) continue
      applyLedgerRecord(goals, record, this.#clock(), this.#policyDefaults)
      replayed = true
      if (record.action === "checkpoint-set") {
        recoveredThreadIds.clear()
        for (const goal of record.goals) recoveredThreadIds.add(goal.threadId)
      } else if (record.action === "clear") {
        recoveredThreadIds.delete(record.threadId)
      } else {
        recoveredThreadIds.add(record.threadId)
      }
    }
    this.#assertRecoveredGoalCount(goals, diagnostics)
    const lastSequence = Math.max(baseSequence, ledger.maxSequence)
    const partial = !snapshot.complete
    return {
      goals: [...goals.values()],
      recoveredFromLedger: recoveredThreadIds.size > 0,
      recoveredThreadIds: [...recoveredThreadIds],
      outcome: partial
        ? "recovered-partial"
        : snapshot.version === 1
          ? "migrated-v1"
          : replayed
            ? "replayed-ledger"
            : "valid",
      lastSequence,
      diagnostics,
      rewriteNeeded: partial || snapshot.version === 1 || snapshot.policyMigrated || replayed,
      ledgerTruncateBytes: ledger.truncateBytes,
      ledgerBytes: ledger.byteLength,
      ledgerActions: ledger.records.length,
      ledgerFutureVersion: ledger.futureVersion,
    }
  }

  #assertRecoveredGoalCount(goals: ReadonlyMap<string, StoredGoal>, diagnostics: RecoveryDiagnostic[]): void {
    if (goals.size <= GOAL_LIMITS.goalsPerSnapshot) return
    throw new PersistenceRecoveryError("Recovered goal count exceeds the persistence contract.", [
      ...diagnostics,
      { code: "goal-count", count: goals.size },
    ])
  }

  async #analyzeSnapshot(): Promise<SnapshotAnalysis> {
    const paths = await this.#paths()
    const raw = await this.#readRegularFile(paths.state, "state file", GOAL_LIMITS.snapshotBytes)
    if (raw === undefined) return { kind: "missing", diagnostics: [{ code: "snapshot-missing" }] }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { kind: "corrupt", diagnostics: [{ code: "snapshot-json" }] }
    }
    if (!isRecord(parsed)) return { kind: "corrupt", diagnostics: [{ code: "snapshot-type" }] }
    if (typeof parsed.version === "number" && Number.isSafeInteger(parsed.version) && parsed.version > VERSION) {
      throw new UnsupportedPersistenceVersionError("snapshot", parsed.version)
    }
    if (parsed.version !== LEGACY_VERSION && parsed.version !== VERSION) {
      return { kind: "corrupt", diagnostics: [{ code: "snapshot-version" }] }
    }
    const version = parsed.version
    const allowed = version === LEGACY_VERSION ? ["version", "goals"] : ["version", "lastSequence", "goals"]
    if (Object.keys(parsed).some((key) => !allowed.includes(key)) || !Array.isArray(parsed.goals)) {
      return { kind: "corrupt", diagnostics: [{ code: "snapshot-schema", snapshotVersion: version }] }
    }
    if (
      version === VERSION &&
      (!Number.isSafeInteger(parsed.lastSequence) || (parsed.lastSequence as number) < 0)
    ) {
      return { kind: "corrupt", diagnostics: [{ code: "snapshot-sequence", snapshotVersion: version }] }
    }
    if (parsed.goals.length > GOAL_LIMITS.goalsPerSnapshot) {
      throw new GoalContractError("Invalid state snapshot", [
        { path: "goals", code: "count", message: `exceeds ${GOAL_LIMITS.goalsPerSnapshot} goals` },
      ])
    }

    const goals = new Map<string, StoredGoal>()
    const invalidThreadIds = new Set<string>()
    let invalidUnknownCount = 0
    let policyMigrated = false
    const diagnostics: RecoveryDiagnostic[] = []
    for (const [index, rawGoal] of parsed.goals.entries()) {
      if (isRecord(rawGoal) && !Object.hasOwn(rawGoal, "policy")) policyMigrated = true
      const result = validatePersistedGoal(rawGoal, this.#clock(), `goals[${index}]`, [], this.#policyDefaults)
      const threadId = isRecord(rawGoal) ? safeThreadId(rawGoal.threadId) : undefined
      if (!result.ok) {
        if (threadId) invalidThreadIds.add(threadId)
        else invalidUnknownCount += 1
        continue
      }
      if (goals.has(result.value.threadId)) {
        invalidUnknownCount += 1
        continue
      }
      goals.set(result.value.threadId, result.value)
    }
    const invalidCount = invalidThreadIds.size + invalidUnknownCount
    if (invalidCount > 0) diagnostics.push({ code: "snapshot-invalid-goals", count: invalidCount, snapshotVersion: version })
    return {
      kind: "valid",
      version,
      lastSequence: version === VERSION ? (parsed.lastSequence as number) : 0,
      goals,
      complete: invalidCount === 0,
      invalidThreadIds,
      invalidUnknownCount,
      policyMigrated,
      diagnostics,
    }
  }

  async #analyzeLedger(snapshot: SnapshotAnalysis): Promise<LedgerAnalysis> {
    const records: LedgerRecord[] = []
    const diagnostics: RecoveryDiagnostic[] = []
    let legacyCount = 0
    let maxSequence = 0
    let sawSequenced = false
    let futureVersion: number | undefined
    const stream = await this.#readLedgerLines((line, lineNumber) => {
      if (!line.trim()) return
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new GoalContractError("Invalid goal ledger", [
          { path: `lines[${lineNumber}]`, code: "json", message: "contains invalid JSON" },
        ])
      }
      if (!isRecord(parsed) || !Number.isSafeInteger(parsed.version)) {
        throw new GoalContractError("Invalid goal ledger", [
          { path: `lines[${lineNumber}]`, code: "schema", message: "contains an invalid version" },
        ])
      }
      if ((parsed.version as number) > VERSION) {
        const sequence = parsed.sequence
        if (
          snapshot.kind === "valid" &&
          snapshot.version === VERSION &&
          snapshot.complete &&
          Number.isSafeInteger(sequence) &&
          (sequence as number) > maxSequence &&
          (sequence as number) <= snapshot.lastSequence
        ) {
          maxSequence = sequence as number
          sawSequenced = true
          futureVersion = Math.max(futureVersion ?? 0, parsed.version as number)
          diagnostics.push({ code: "ledger-future-covered", ledgerVersion: parsed.version as number, sequence: maxSequence })
          return
        }
        throw new UnsupportedPersistenceVersionError("ledger", parsed.version as number)
      }
      if (parsed.version !== LEGACY_VERSION && parsed.version !== VERSION) {
        throw new GoalContractError("Invalid goal ledger", [
          { path: `lines[${lineNumber}]`, code: "schema", message: "contains an unsupported version" },
        ])
      }
      let sequence: number
      if (parsed.version === LEGACY_VERSION) {
        if (sawSequenced) {
          throw new GoalContractError("Invalid goal ledger", [
            { path: `lines[${lineNumber}]`, code: "order", message: "legacy records must precede sequenced records" },
          ])
        }
        legacyCount += 1
        sequence = legacyCount
      } else {
        sawSequenced = true
        if (!Number.isSafeInteger(parsed.sequence) || (parsed.sequence as number) <= maxSequence) {
          throw new GoalContractError("Invalid goal ledger", [
            { path: `lines[${lineNumber}].sequence`, code: "sequence", message: "must increase monotonically" },
          ])
        }
        sequence = parsed.sequence as number
      }
      if (!Number.isSafeInteger(parsed.timestamp) || (parsed.timestamp as number) < 0) {
        throw new GoalContractError("Invalid goal ledger", [
          { path: `lines[${lineNumber}].timestamp`, code: "integer", message: "must be a non-negative safe integer" },
        ])
      }
      if (parsed.action === "clear") {
        const allowed = parsed.version === LEGACY_VERSION
          ? ["version", "timestamp", "action", "threadId"]
          : ["version", "sequence", "timestamp", "action", "threadId"]
        const threadId = safeThreadId(parsed.threadId)
        if (!threadId || Object.keys(parsed).some((key) => !allowed.includes(key))) {
          throw new GoalContractError("Invalid goal ledger", [
            { path: `lines[${lineNumber}]`, code: "schema", message: "contains an invalid clear entry" },
          ])
        }
        records.push({ version: parsed.version, sequence, timestamp: parsed.timestamp as number, action: "clear", threadId })
      } else if (parsed.action === "set" && parsed.version === LEGACY_VERSION) {
        const allowedMetadata = parsed.version === LEGACY_VERSION
          ? ["version", "timestamp", "action"]
          : ["version", "sequence", "timestamp", "action"]
        const result = validatePersistedGoal(parsed, this.#clock(), `lines[${lineNumber}]`, allowedMetadata, this.#policyDefaults)
        if (!result.ok) throw new GoalContractError("Invalid goal ledger", result.issues)
        records.push({
          version: parsed.version,
          sequence,
          timestamp: parsed.timestamp as number,
          action: "checkpoint",
          threadId: result.value.threadId,
          goal: result.value,
        })
      } else if (parsed.action === "set" && parsed.version === VERSION) {
        const result = validatePersistedGoal(
          parsed,
          this.#clock(),
          `lines[${lineNumber}]`,
          ["version", "sequence", "timestamp", "action"],
          this.#policyDefaults,
        )
        if (!result.ok) throw new GoalContractError("Invalid goal ledger", result.issues)
        records.push({ version: VERSION, sequence, timestamp: parsed.timestamp as number, action: "checkpoint", threadId: result.value.threadId, goal: result.value })
      } else if (parsed.action === "checkpoint" && parsed.version === VERSION) {
        const allowed = ["version", "sequence", "timestamp", "action", "threadId", "goal"]
        const threadId = safeThreadId(parsed.threadId)
        const result = validatePersistedGoal(parsed.goal, this.#clock(), `lines[${lineNumber}].goal`, [], this.#policyDefaults)
        if (!threadId || Object.keys(parsed).some((key) => !allowed.includes(key)) || !result.ok || result.value.threadId !== threadId) {
          throw new GoalContractError("Invalid goal ledger", result.ok
            ? [{ path: `lines[${lineNumber}]`, code: "schema", message: "contains an invalid checkpoint" }]
            : result.issues)
        }
        records.push({ version: VERSION, sequence, timestamp: parsed.timestamp as number, action: "checkpoint", threadId, goal: result.value })
      } else if (parsed.action === "patch" && parsed.version === VERSION) {
        const allowed = ["version", "sequence", "timestamp", "action", "threadId", "changes"]
        const threadId = safeThreadId(parsed.threadId)
        if (!threadId || !isRecord(parsed.changes) || Object.keys(parsed).some((key) => !allowed.includes(key))) {
          throw new GoalContractError("Invalid goal ledger", [
            { path: `lines[${lineNumber}]`, code: "schema", message: "contains an invalid patch" },
          ])
        }
        records.push({ version: VERSION, sequence, timestamp: parsed.timestamp as number, action: "patch", threadId, changes: parsed.changes })
      } else if (parsed.action === "checkpoint-set" && parsed.version === VERSION) {
        const allowed = ["version", "sequence", "timestamp", "action", "goals"]
        if (!Array.isArray(parsed.goals) || Object.keys(parsed).some((key) => !allowed.includes(key))) {
          throw new GoalContractError("Invalid goal ledger", [
            { path: `lines[${lineNumber}]`, code: "schema", message: "contains an invalid checkpoint set" },
          ])
        }
        if (parsed.goals.length > GOAL_LIMITS.goalsPerSnapshot) {
          throw new GoalContractError("Invalid goal ledger", [
            { path: `lines[${lineNumber}].goals`, code: "count", message: `exceeds ${GOAL_LIMITS.goalsPerSnapshot} goals` },
          ])
        }
        const goals: StoredGoal[] = []
        const threadIds = new Set<string>()
        for (const [goalIndex, rawGoal] of parsed.goals.entries()) {
          const result = validatePersistedGoal(
            rawGoal,
            this.#clock(),
            `lines[${lineNumber}].goals[${goalIndex}]`,
            [],
            this.#policyDefaults,
          )
          if (!result.ok) throw new GoalContractError("Invalid goal ledger", result.issues)
          if (threadIds.has(result.value.threadId)) {
            throw new GoalContractError("Invalid goal ledger", [
              { path: `lines[${lineNumber}].goals[${goalIndex}].threadId`, code: "duplicate", message: "must be unique" },
            ])
          }
          threadIds.add(result.value.threadId)
          goals.push(result.value)
        }
        records.push({ version: VERSION, sequence, timestamp: parsed.timestamp as number, action: "checkpoint-set", goals })
      } else {
        throw new GoalContractError("Invalid goal ledger", [
          { path: `lines[${lineNumber}].action`, code: "action", message: "contains an invalid action for its version" },
        ])
      }
      maxSequence = Math.max(maxSequence, sequence)
    })
    if (!stream.exists) {
      return {
        records: [],
        maxSequence: 0,
        legacyCount: 0,
        diagnostics: [],
        truncateBytes: undefined,
        byteLength: 0,
        futureVersion: undefined,
      }
    }
    if (stream.truncateBytes !== undefined) diagnostics.push({ code: "ledger-incomplete-tail" })
    return {
      records,
      maxSequence,
      legacyCount,
      diagnostics,
      truncateBytes: stream.truncateBytes,
      byteLength: stream.byteLength,
      futureVersion,
    }
  }

  #recordFromEntry(
    entry: LedgerEntry,
    sequence: number,
    durable: ReadonlyMap<string, StoredGoal>,
  ): LedgerRecord | undefined {
    if (entry.action === "clear") {
      return { version: VERSION, sequence, timestamp: Date.now(), action: "clear", threadId: entry.threadId }
    }
    const checkpoint: LedgerRecord = {
      version: VERSION,
      sequence,
      timestamp: Date.now(),
      action: "checkpoint",
      threadId: entry.goal.threadId,
      goal: structuredClone(entry.goal),
    }
    if (entry.action !== "update" || sequence % LEDGER_CHECKPOINT_INTERVAL === 0) return checkpoint
    const previous = durable.get(entry.goal.threadId)
    if (!previous) return checkpoint
    const changes: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(entry.goal)) {
      if (key === "threadId") continue
      const previousValue = previous[key as keyof StoredGoal]
      if (JSON.stringify(previousValue) !== JSON.stringify(value)) changes[key] = structuredClone(value)
    }
    if (Object.keys(changes).length === 0) return undefined
    const patch: LedgerRecord = {
      version: VERSION,
      sequence,
      timestamp: Date.now(),
      action: "patch",
      threadId: entry.goal.threadId,
      changes,
    }
    return Buffer.byteLength(this.#encodeLedgerRecord(patch)) < Buffer.byteLength(this.#encodeLedgerRecord(checkpoint))
      ? patch
      : checkpoint
  }

  #encodeLedgerRecord(record: LedgerRecord): string {
    return `${JSON.stringify(record)}\n`
  }

  #compactionThresholdReached(actions: number, bytes: number): boolean {
    return (
      actions >= (this.#hooks.ledgerCompactionActions ?? LEDGER_COMPACTION_ACTIONS) ||
      bytes >= (this.#hooks.ledgerCompactionBytes ?? LEDGER_COMPACTION_BYTES)
    )
  }

  async #loadArchive(): Promise<LoadedArchive> {
    const paths = await this.#paths()
    const raw = await this.#readRegularFile(paths.archive, "archive file", GOAL_LIMITS.archiveBytes)
    if (raw === undefined) return { entries: [], lastSequence: 0 }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new GoalContractError("Invalid goal archive", [
        { path: paths.archive, code: "json", message: "contains invalid JSON" },
      ])
    }
    if (!isRecord(parsed)) {
      throw new GoalContractError("Invalid goal archive", [
        { path: paths.archive, code: "type", message: "must contain an object" },
      ])
    }
    if (typeof parsed.version === "number" && Number.isSafeInteger(parsed.version) && parsed.version > 1) {
      throw new UnsupportedPersistenceVersionError("archive", parsed.version)
    }
    const unknown = Object.keys(parsed).filter((key) => !["version", "lastSequence", "entries"].includes(key))
    if (
      parsed.version !== 1 ||
      !Number.isSafeInteger(parsed.lastSequence) ||
      (parsed.lastSequence as number) < 0 ||
      !Array.isArray(parsed.entries) ||
      unknown.length > 0
    ) {
      throw new GoalContractError("Invalid goal archive", [
        { path: paths.archive, code: "schema", message: "must be a version 1 archive" },
      ])
    }
    if (parsed.entries.length > GOAL_LIMITS.archiveEntries) {
      throw new GoalContractError("Invalid goal archive", [
        { path: "entries", code: "count", message: `exceeds ${GOAL_LIMITS.archiveEntries} entries` },
      ])
    }
    const entries: GoalArchiveEntry[] = []
    const ids = new Set<string>()
    for (const [index, rawEntry] of parsed.entries.entries()) {
      const result = validateArchiveEntry(rawEntry, this.#clock(), `entries[${index}]`)
      if (!result.ok) throw new GoalContractError("Invalid goal archive", result.issues)
      if (ids.has(result.value.id)) {
        throw new GoalContractError("Invalid goal archive", [
          { path: `entries[${index}].id`, code: "duplicate", message: "must be unique" },
        ])
      }
      ids.add(result.value.id)
      entries.push(result.value)
    }
    return { entries, lastSequence: parsed.lastSequence as number }
  }

  async #writeArchive(entries: readonly GoalArchiveEntry[], lastSequence: number): Promise<void> {
    assertArchiveEntries(entries, this.#clock(), "Invalid goal archive")
    const state: PersistedGoalArchiveV1 = { version: 1, lastSequence, entries: [...entries] }
    const encoded = `${JSON.stringify(state, null, 2)}\n`
    const paths = await this.#paths()
    if (Buffer.byteLength(encoded) > GOAL_LIMITS.archiveBytes) {
      throw unsafePath(paths.archive, `archive file would exceed ${GOAL_LIMITS.archiveBytes} bytes`)
    }
    await this.#validateLeaf(paths.archive, "archive file")
    this.#saveCounter += 1
    const temp = `${paths.archive}.${process.pid}.${Date.now()}.${this.#saveCounter}.tmp`
    try {
      const handle = await open(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600,
      )
      try {
        const stats = await handle.stat()
        if (!stats.isFile() || stats.nlink !== 1) throw unsafePath(temp, "temporary archive is not a private regular file")
        await this.#revalidate(paths)
        await handle.writeFile(encoded, "utf8")
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.#revalidate(paths)
      await this.#validateLeaf(paths.archive, "archive file")
      await rename(temp, paths.archive)
      await this.#validateLeaf(paths.archive, "archive file")
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async #writeSnapshot(goals: readonly StoredGoal[], lastSequence: number): Promise<void> {
    const state: PersistedStateV2 = { version: VERSION, lastSequence, goals: [...goals] }
    const encoded = `${JSON.stringify(state, null, 2)}\n`
    const paths = await this.#paths()
    const bytes = Buffer.byteLength(encoded)
    if (bytes > GOAL_LIMITS.snapshotBytes) {
      throw unsafePath(paths.state, `state file would exceed ${GOAL_LIMITS.snapshotBytes} bytes`)
    }
    await this.#validateLeaf(paths.state, "state file")
    this.#saveCounter += 1
    const temp = `${paths.state}.${process.pid}.${Date.now()}.${this.#saveCounter}.tmp`
    try {
      const handle = await open(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600,
      )
      try {
        const stats = await handle.stat()
        if (!stats.isFile()) throw unsafePath(temp, "temporary snapshot is not a regular file")
        if (stats.nlink !== 1) throw unsafePath(temp, "temporary snapshot has multiple hard links")
        await this.#revalidate(paths)
        await handle.writeFile(encoded, "utf8")
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.#revalidate(paths)
      await this.#validateLeaf(paths.state, "state file")
      await rename(temp, paths.state)
      await this.#validateLeaf(paths.state, "state file")
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async #appendLedger(encoded: string): Promise<void> {
    const paths = await this.#paths()
    await this.#validateLeaf(paths.ledger, "ledger file")
    const encodedBytes = Buffer.byteLength(encoded)
    let handle
    try {
      handle = await open(
        paths.ledger,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600,
      )
    } catch (error) {
      if (errorCode(error) === "ELOOP") throw unsafePath(paths.ledger, "ledger file is a symbolic link")
      throw error
    }
    try {
      const stats = await handle.stat()
      if (!stats.isFile()) throw unsafePath(paths.ledger, "ledger file is not a regular file")
      if (stats.nlink !== 1) throw unsafePath(paths.ledger, "ledger file has multiple hard links")
      if (stats.size + encodedBytes > GOAL_LIMITS.ledgerBytes) {
        throw unsafePath(paths.ledger, `ledger file would exceed ${GOAL_LIMITS.ledgerBytes} bytes`)
      }
      await this.#revalidate(paths)
      await handle.writeFile(encoded, "utf8")
      await handle.sync()
      await this.#revalidate(paths)
    } finally {
      await handle.close()
    }
  }

  async #compactLedger(goals: readonly StoredGoal[], lastSequence: number): Promise<number> {
    assertPersistedGoals(goals, this.#clock(), "Invalid compacted goal state")
    const paths = await this.#paths()
    const record: LedgerRecord = {
      version: VERSION,
      sequence: lastSequence,
      timestamp: Date.now(),
      action: "checkpoint-set",
      goals: goals.map((goal) => structuredClone(goal)),
    }
    const encoded = this.#encodeLedgerRecord(record)
    const bytes = Buffer.byteLength(encoded)
    if (bytes > LEDGER_LINE_BYTES || bytes > GOAL_LIMITS.ledgerBytes) {
      throw unsafePath(paths.ledger, `compacted ledger checkpoint would exceed ${LEDGER_LINE_BYTES} bytes`)
    }
    await this.#validateLeaf(paths.ledger, "ledger file")
    this.#saveCounter += 1
    const temp = `${paths.ledger}.${process.pid}.${Date.now()}.${this.#saveCounter}.tmp`
    try {
      const handle = await open(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600,
      )
      try {
        const stats = await handle.stat()
        if (!stats.isFile() || stats.nlink !== 1) throw unsafePath(temp, "temporary ledger is not a private regular file")
        await this.#revalidate(paths)
        await handle.writeFile(encoded, "utf8")
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.#runFailpoint("before-ledger-compaction-rename")
      await this.#revalidate(paths)
      await this.#validateLeaf(paths.ledger, "ledger file")
      await rename(temp, paths.ledger)
      await this.#validateLeaf(paths.ledger, "ledger file")
      await this.#runFailpoint("after-ledger-compaction-rename")
      return bytes
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async #truncateLedger(bytes: number): Promise<void> {
    const paths = await this.#paths()
    await this.#validateLeaf(paths.ledger, "ledger file")
    let handle
    try {
      handle = await open(paths.ledger, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch (error) {
      if (errorCode(error) === "ELOOP") throw unsafePath(paths.ledger, "ledger file is a symbolic link")
      throw error
    }
    try {
      const stats = await handle.stat()
      if (!stats.isFile() || stats.nlink !== 1) throw unsafePath(paths.ledger, "ledger file is not a private regular file")
      if (bytes < 0 || bytes > stats.size) throw new PersistenceRecoveryError("Invalid ledger repair boundary.", [{ code: "ledger-repair" }])
      await this.#revalidate(paths)
      await handle.truncate(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async #runFailpoint(point: PersistenceFailpoint): Promise<void> {
    await this.#hooks.failpoint?.(point)
  }

  async #withLock<T>(task: () => Promise<T>): Promise<T> {
    const lease = await this.#acquireLock()
    try {
      return await task()
    } finally {
      await this.#releaseLock(lease)
    }
  }

  async #acquireLock(): Promise<LockLease> {
    const paths = await this.#paths()
    const startedAt = this.#nowMilliseconds()
    const timeout = this.#hooks.lockTimeoutMs ?? LOCK_TIMEOUT_MS
    while (true) {
      await this.#revalidate(paths)
      await this.#validateLeaf(paths.lock, "lock file")
      try {
        const handle = await open(
          paths.lock,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          0o600,
        )
        const stats = await handle.stat()
        try {
          if (!stats.isFile() || stats.nlink !== 1) throw new PersistenceLockError(paths.lock, "is not a private regular file")
          const owner: LockOwner = {
            pid: process.pid,
            hostname: this.#hooks.hostname ?? hostname(),
            nonce: randomUUID(),
            createdAt: this.#nowMilliseconds(),
          }
          await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8")
          await handle.sync()
          return { path: paths.lock, handle, device: stats.dev, inode: stats.ino }
        } catch (error) {
          await handle.close().catch(() => undefined)
          await this.#unlinkIfSame(paths.lock, stats.dev, stats.ino).catch(() => undefined)
          throw error
        }
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          if (errorCode(error) === "ELOOP") throw unsafePath(paths.lock, "lock file is a symbolic link")
          throw error
        }
      }

      const reclaimed = await this.#reclaimStaleLock(paths.lock)
      if (reclaimed) continue
      if (this.#nowMilliseconds() - startedAt >= timeout) {
        throw new PersistenceLockError(paths.lock, "could not be acquired before timeout")
      }
      await (this.#hooks.sleep ?? defaultSleep)(LOCK_RETRY_MS)
    }
  }

  async #reclaimStaleLock(path: string): Promise<boolean> {
    const stats = await pathStats(path)
    if (!stats) return true
    if (stats.isSymbolicLink()) throw unsafePath(path, "lock file is a symbolic link")
    if (!stats.isFile() || stats.nlink !== 1) throw new PersistenceLockError(path, "is not a private regular file")
    if (stats.size > LOCK_MAX_BYTES) throw new PersistenceLockError(path, "exceeds its metadata limit")
    let raw: string
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const opened = await handle.stat()
        if (opened.dev !== stats.dev || opened.ino !== stats.ino) return true
        raw = await handle.readFile("utf8")
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (isMissing(error)) return true
      throw error
    }
    let owner: unknown
    try {
      owner = JSON.parse(raw)
    } catch {
      owner = undefined
    }
    if (!this.#isLockOwner(owner)) {
      const grace = this.#hooks.lockInitializationGraceMs ?? LOCK_INITIALIZATION_GRACE_MS
      if (this.#nowMilliseconds() - Number(stats.mtimeMs) < grace) return false
      return this.#unlinkIfSame(path, stats.dev, stats.ino)
    }
    if (owner.hostname !== (this.#hooks.hostname ?? hostname())) return false
    if (this.#isProcessAlive(owner.pid)) return false
    return this.#unlinkIfSame(path, stats.dev, stats.ino)
  }

  #isLockOwner(value: unknown): value is LockOwner {
    return Boolean(
      isRecord(value) &&
      Number.isSafeInteger(value.pid) &&
      (value.pid as number) > 0 &&
      typeof value.hostname === "string" &&
      value.hostname.length > 0 &&
      typeof value.nonce === "string" &&
      value.nonce.length > 0 &&
      Number.isFinite(value.createdAt),
    )
  }

  #isProcessAlive(pid: number): boolean {
    if (this.#hooks.isProcessAlive) return this.#hooks.isProcessAlive(pid)
    const processWithKill = process as typeof process & { kill?: (target: number, signal: number) => boolean }
    if (!processWithKill.kill) return true
    try {
      processWithKill.kill(pid, 0)
      return true
    } catch (error) {
      return errorCode(error) !== "ESRCH"
    }
  }

  #nowMilliseconds(): number {
    return this.#hooks.nowMilliseconds?.() ?? Date.now()
  }

  async #releaseLock(lease: LockLease): Promise<void> {
    await lease.handle.close().catch(() => undefined)
    await this.#unlinkIfSame(lease.path, lease.device, lease.inode)
  }

  async #unlinkIfSame(path: string, device?: number, inode?: number): Promise<boolean> {
    const stats = await pathStats(path)
    if (!stats) return true
    if (device !== undefined && inode !== undefined && (stats.dev !== device || stats.ino !== inode)) return false
    try {
      await unlink(path)
      return true
    } catch (error) {
      if (isMissing(error)) return true
      throw error
    }
  }

  async #paths(): Promise<PreparedPaths> {
    if (!this.#prepared) this.#prepared = await this.#preparePaths()
    await this.#revalidate(this.#prepared)
    return this.#prepared
  }

  async #preparePaths(): Promise<PreparedPaths> {
    if (!constants.O_NOFOLLOW) {
      throw unsafePath(this.#configuredPath, "platform does not support no-follow file opens")
    }
    const configuredRoot = resolve(this.#pathPolicy.trustRoot)
    if (!this.#pathPolicy.projectLocal) {
      try {
        await mkdir(configuredRoot, { recursive: true, mode: 0o700 })
      } catch (error) {
        if (["EEXIST", "ENOTDIR"].includes(errorCode(error))) {
          throw unsafePath(configuredRoot, "configured parent is not a directory")
        }
        throw error
      }
      const canonicalRoot = await realpath(configuredRoot)
      await requireDirectory(canonicalRoot)
      const state = join(canonicalRoot, basename(this.#configuredPath))
      return {
        state,
        ledger: `${state}.ledger.jsonl`,
        archive: `${state}.archive.json`,
        lock: `${state}.lock`,
        parent: canonicalRoot,
        canonicalRoot,
        configuredRoot,
        projectLocal: false,
      }
    }

    let canonicalRoot: string
    try {
      canonicalRoot = await realpath(configuredRoot)
    } catch {
      throw unsafePath(configuredRoot, "trusted project directory does not exist or cannot be resolved")
    }
    const rootStats = await lstat(canonicalRoot)
    if (!rootStats.isDirectory()) throw unsafePath(configuredRoot, "trusted project path is not a directory")

    const configuredRelative = relative(configuredRoot, this.#configuredPath)
    if (
      configuredRelative === ".." ||
      configuredRelative.startsWith(`..${sep}`) ||
      configuredRelative.startsWith(sep)
    ) {
      throw unsafePath(this.#configuredPath, "project-local path escapes its trusted root")
    }
    const state = resolve(canonicalRoot, configuredRelative)
    const parent = dirname(state)
    const parentRelative = relative(canonicalRoot, parent)
    let current = canonicalRoot
    for (const component of parentRelative.split(sep).filter(Boolean)) {
      current = join(current, component)
      await ensureDirectory(current)
    }
    return {
      state,
      ledger: `${state}.ledger.jsonl`,
      archive: `${state}.archive.json`,
      lock: `${state}.lock`,
      parent,
      canonicalRoot,
      configuredRoot,
      projectLocal: true,
    }
  }

  async #revalidate(paths: PreparedPaths): Promise<void> {
    let currentRoot: string
    try {
      currentRoot = await realpath(paths.configuredRoot)
    } catch {
      throw unsafePath(paths.configuredRoot, "trusted directory cannot be resolved")
    }
    if (currentRoot !== paths.canonicalRoot) {
      throw unsafePath(paths.configuredRoot, "trusted directory changed after validation")
    }
    await requireDirectory(paths.canonicalRoot)
    if (paths.projectLocal) {
      const parentRelative = relative(paths.canonicalRoot, paths.parent)
      let current = paths.canonicalRoot
      for (const component of parentRelative.split(sep).filter(Boolean)) {
        current = join(current, component)
        await requireDirectory(current)
      }
    } else {
      await requireDirectory(paths.parent)
    }
    let currentParent: string
    try {
      currentParent = await realpath(paths.parent)
    } catch {
      throw unsafePath(paths.parent, "persistence parent cannot be resolved")
    }
    if (currentParent !== paths.parent) {
      throw unsafePath(paths.parent, "persistence parent changed after validation")
    }
  }

  async #validateLeaf(path: string, label: string): Promise<void> {
    const stats = await pathStats(path)
    if (!stats) return
    if (stats.isSymbolicLink()) throw unsafePath(path, `${label} is a symbolic link`)
    if (!stats.isFile()) throw unsafePath(path, `${label} is not a regular file`)
    if (stats.nlink !== 1) throw unsafePath(path, `${label} has multiple hard links`)
  }

  async #readLedgerLines(visit: (line: string, lineNumber: number) => void): Promise<LedgerStreamResult> {
    const paths = await this.#paths()
    await this.#revalidate(paths)
    await this.#validateLeaf(paths.ledger, "ledger file")
    let handle
    try {
      handle = await open(paths.ledger, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch (error) {
      if (isMissing(error)) return { exists: false, byteLength: 0, truncateBytes: undefined }
      if (errorCode(error) === "ELOOP") throw unsafePath(paths.ledger, "ledger file is a symbolic link")
      throw error
    }
    try {
      const stats = await handle.stat()
      if (!stats.isFile()) throw unsafePath(paths.ledger, "ledger file is not a regular file")
      if (stats.nlink !== 1) throw unsafePath(paths.ledger, "ledger file has multiple hard links")
      const byteLength = Number(stats.size)
      if (byteLength > GOAL_LIMITS.ledgerBytes) {
        throw unsafePath(paths.ledger, `ledger file exceeds ${GOAL_LIMITS.ledgerBytes} bytes`)
      }
      await this.#revalidate(paths)
      let carry = Buffer.alloc(0)
      let lineNumber = 0
      while (true) {
        const chunk = Buffer.allocUnsafe(LEDGER_READ_CHUNK_BYTES)
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        if (bytesRead === 0) break
        const combined = carry.length === 0
          ? chunk.subarray(0, bytesRead)
          : Buffer.concat([carry, chunk.subarray(0, bytesRead)])
        let start = 0
        let newline = combined.indexOf(0x0a, start)
        while (newline >= 0) {
          const line = combined.subarray(start, newline)
          if (line.length > LEDGER_LINE_BYTES) {
            throw new GoalContractError("Invalid goal ledger", [
              { path: `lines[${lineNumber + 1}]`, code: "bytes", message: `exceeds ${LEDGER_LINE_BYTES} bytes` },
            ])
          }
          lineNumber += 1
          visit(line.toString("utf8"), lineNumber)
          start = newline + 1
          newline = combined.indexOf(0x0a, start)
        }
        carry = Buffer.from(combined.subarray(start))
        if (carry.length > LEDGER_LINE_BYTES) {
          throw new GoalContractError("Invalid goal ledger", [
            { path: `lines[${lineNumber + 1}]`, code: "bytes", message: `exceeds ${LEDGER_LINE_BYTES} bytes` },
          ])
        }
      }
      return {
        exists: true,
        byteLength,
        truncateBytes: carry.length > 0 ? byteLength - carry.length : undefined,
      }
    } finally {
      await handle.close()
    }
  }

  async #readRegularFile(path: string, label: string, maximumBytes: number): Promise<string | undefined> {
    const paths = await this.#paths()
    await this.#revalidate(paths)
    await this.#validateLeaf(path, label)
    let handle
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch (error) {
      if (isMissing(error)) return undefined
      if (errorCode(error) === "ELOOP") throw unsafePath(path, `${label} is a symbolic link`)
      throw error
    }
    try {
      const stats = await handle.stat()
      if (!stats.isFile()) throw unsafePath(path, `${label} is not a regular file`)
      if (stats.nlink !== 1) throw unsafePath(path, `${label} has multiple hard links`)
      if (stats.size > maximumBytes) throw unsafePath(path, `${label} exceeds ${maximumBytes} bytes`)
      await this.#revalidate(paths)
      const contents = await handle.readFile("utf8")
      if (Buffer.byteLength(contents) > maximumBytes) throw unsafePath(path, `${label} exceeds ${maximumBytes} bytes`)
      return contents
    } finally {
      await handle.close()
    }
  }
}
