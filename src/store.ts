import { GOAL_LIMITS, truncateCodePoints } from "./goal-contract.ts"
import { GoalPersistence, archiveEntryForGoal, archiveEntryMatchesGoal, retainArchiveEntries, retainGoals } from "./persistence.ts"
import type { ArchiveMutation, PersistencePathPolicy, PersistenceTestHooks } from "./persistence.ts"
import { defaultGoalPolicy } from "./types.ts"
import type { GoalArchiveEntry, GoalArchiveStatus, GoalClock, GoalMode, GoalPolicy, StoredGoal, ThreadGoalStatus } from "./types.ts"

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export type GoalStatusListener = (goal: StoredGoal, previousStatus: ThreadGoalStatus | undefined) => void
export type GoalClearListener = (goal: StoredGoal) => void
export type GoalLifecycleFlush = (threadId: string) => Promise<void>

export type GoalRevision = Readonly<{
  generation: number
  revision: number
}>

export type GoalSnapshot = Readonly<{
  goal: StoredGoal
  revision: GoalRevision
}>

export type GoalMutation<T> = Readonly<{
  commit: boolean
  value: T
}>

export type GoalUpdateResult<T> =
  | { applied: true; snapshot: GoalSnapshot; value: T }
  | { applied: false; reason: "unchanged"; snapshot: GoalSnapshot; value: T }
  | { applied: false; reason: "missing" | "stale" }

export type GoalPurgeResult = {
  currentRemoved: boolean
  archiveRemoved: number
}

type GoalEntry = {
  goal: StoredGoal
  generation: number
  revision: number
}

function cloneGoal(goal: StoredGoal): StoredGoal {
  return structuredClone(goal)
}

function materializeGoal(goal: StoredGoal, clock: GoalClock): StoredGoal {
  const result = cloneGoal(goal)
  result.timeUsedSeconds = activeTimeSeconds(result, clock)
  return result
}

function snapshot(entry: GoalEntry, clock: GoalClock): GoalSnapshot {
  return {
    goal: materializeGoal(entry.goal, clock),
    revision: { generation: entry.generation, revision: entry.revision },
  }
}

function matches(entry: GoalEntry, revision: GoalRevision): boolean {
  return entry.generation === revision.generation && entry.revision === revision.revision
}

function terminalArchiveStatus(status: ThreadGoalStatus): GoalArchiveStatus | undefined {
  return status === "complete" || status === "blocked" || status === "budgetLimited" ? status : undefined
}

export class GoalStore {
  readonly #goals = new Map<string, GoalEntry>()
  #archive: GoalArchiveEntry[] = []
  readonly #queues = new Map<string, Promise<void>>()
  readonly #persistence: GoalPersistence | undefined
  readonly #onStatusChange: GoalStatusListener | undefined
  readonly #onClear: GoalClearListener | undefined
  readonly #clock: GoalClock
  #beforeLifecycleMutation: GoalLifecycleFlush | undefined
  #nextGeneration = 1

  constructor(
    path: string,
    persist: boolean,
    onStatusChange?: GoalStatusListener,
    onClear?: GoalClearListener,
    clock: GoalClock = nowSeconds,
    pathPolicy?: PersistencePathPolicy,
    persistenceHooks?: PersistenceTestHooks,
    policyDefaults: GoalPolicy = defaultGoalPolicy(),
  ) {
    this.#persistence = persist ? new GoalPersistence(path, clock, pathPolicy, persistenceHooks, policyDefaults) : undefined
    this.#onStatusChange = onStatusChange
    this.#onClear = onClear
    this.#clock = clock
  }

  async load(): Promise<void> {
    if (!this.#persistence) return
    const loaded = await this.#persistence.load((goal) => {
      if (goal.status !== "active") return goal
      goal.status = "paused"
      touchGoal(goal, "recovered", "Recovered from append-only ledger; paused until user resumes.", this.#clock)
      return goal
    })
    this.#goals.clear()
    this.#archive = loaded.archive.map((entry) => structuredClone(entry))
    for (const goal of loaded.goals) {
      this.#goals.set(goal.threadId, {
        goal: cloneGoal(goal),
        generation: this.#nextGeneration,
        revision: 0,
      })
      this.#nextGeneration += 1
    }
  }

  setLifecycleFlush(flush: GoalLifecycleFlush | undefined): void {
    this.#beforeLifecycleMutation = flush
  }

  async #persist(
    action?: "checkpoint" | "update" | "clear",
    threadId?: string,
    goal?: StoredGoal,
    archiveMutation?: ArchiveMutation,
    archiveFirst = false,
  ): Promise<void> {
    if (!this.#persistence) return
    const goals = this.list()
    if ((action === "checkpoint" || action === "update") && goal) {
      await this.#persistence.persist(goals, { action, goal: materializeGoal(goal, this.#clock) }, archiveMutation, archiveFirst)
      return
    }
    if (action === "clear" && threadId) {
      await this.#persistence.persist(goals, { action, threadId }, archiveMutation, archiveFirst)
      return
    }
    await this.#persistence.persist(goals, undefined, archiveMutation, archiveFirst)
  }

  #upsertArchive(entry: GoalArchiveEntry): void {
    this.#archive = retainArchiveEntries(
      [...this.#archive.filter((existing) => existing.id !== entry.id), structuredClone(entry)],
      this.#clock(),
    )
  }

  #pruneTerminalGoals(): void {
    const retained = retainGoals(this.list(), this.#clock())
    if (retained.prunedThreadIds.length === 0) return
    for (const threadId of retained.prunedThreadIds) this.#goals.delete(threadId)
  }

  #enqueue<T>(threadId: string, transition: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(threadId) ?? Promise.resolve()
    const next = previous.then(transition, transition)
    const tail = next.then(
      () => undefined,
      () => undefined,
    )
    this.#queues.set(threadId, tail)
    void tail.then(() => {
      if (this.#queues.get(threadId) === tail) this.#queues.delete(threadId)
    })
    return next
  }

  read(threadId: string): GoalSnapshot | undefined {
    const entry = this.#goals.get(threadId)
    return entry ? snapshot(entry, this.#clock) : undefined
  }

  list(): StoredGoal[] {
    return [...this.#goals.values()].map((entry) => materializeGoal(entry.goal, this.#clock))
  }

  archive(threadId?: string): GoalArchiveEntry[] {
    return this.#archive
      .filter((entry) => threadId === undefined || entry.threadId === threadId)
      .map((entry) => structuredClone(entry))
  }

  async replace(goal: StoredGoal): Promise<GoalSnapshot> {
    const replacement = cloneGoal(goal)
    await this.#beforeLifecycleMutation?.(replacement.threadId)
    return this.#enqueue(replacement.threadId, async () => {
      synchronizeActiveTime(replacement, this.#clock)
      const previousStatus = this.#goals.get(replacement.threadId)?.goal.status
      const committed: GoalEntry = {
        goal: cloneGoal(replacement),
        generation: this.#nextGeneration,
        revision: 0,
      }
      this.#nextGeneration += 1
      this.#goals.set(replacement.threadId, committed)
      const replacementArchiveStatus = terminalArchiveStatus(committed.goal.status)
      const archiveEntry = replacementArchiveStatus
        ? archiveEntryForGoal(materializeGoal(committed.goal, this.#clock), replacementArchiveStatus, committed.goal.updatedAt)
        : undefined
      if (archiveEntry) this.#upsertArchive(archiveEntry)
      await this.#persist(
        "checkpoint",
        replacement.threadId,
        committed.goal,
        archiveEntry ? { action: "upsert", entry: archiveEntry } : undefined,
      )
      this.#pruneTerminalGoals()
      const result = snapshot(committed, this.#clock)
      if (this.#onStatusChange && previousStatus !== committed.goal.status) {
        this.#notify(() => this.#onStatusChange?.(cloneGoal(committed.goal), previousStatus))
      }
      return result
    })
  }

  update<T>(
    threadId: string,
    expected: GoalRevision,
    transition: (draft: StoredGoal) => GoalMutation<T>,
  ): Promise<GoalUpdateResult<T>> {
    return this.#enqueue(threadId, async () => {
      const current = this.#goals.get(threadId)
      if (!current) return { applied: false, reason: "missing" }
      if (!matches(current, expected)) return { applied: false, reason: "stale" }

      const draft = cloneGoal(current.goal)
      const mutation = transition(draft)
      if (!mutation.commit) {
        return { applied: false, reason: "unchanged", snapshot: snapshot(current, this.#clock), value: mutation.value }
      }

      const previousStatus = current.goal.status
      synchronizeActiveTime(draft, this.#clock)
      const committed: GoalEntry = {
        goal: cloneGoal(draft),
        generation: current.generation,
        revision: current.revision + 1,
      }
      this.#goals.set(threadId, committed)
      const previousArchiveStatus = terminalArchiveStatus(previousStatus)
      const committedArchiveStatus = terminalArchiveStatus(committed.goal.status)
      const archiveEntry = !previousArchiveStatus && committedArchiveStatus
        ? archiveEntryForGoal(materializeGoal(committed.goal, this.#clock), committedArchiveStatus, committed.goal.updatedAt)
        : undefined
      if (archiveEntry) this.#upsertArchive(archiveEntry)
      await this.#persist(
        "update",
        threadId,
        committed.goal,
        archiveEntry ? { action: "upsert", entry: archiveEntry } : undefined,
      )
      this.#pruneTerminalGoals()
      const result = snapshot(committed, this.#clock)
      if (this.#onStatusChange && previousStatus !== committed.goal.status) {
        this.#notify(() => this.#onStatusChange?.(cloneGoal(committed.goal), previousStatus))
      }
      return { applied: true, snapshot: result, value: mutation.value }
    })
  }

  async clear(threadId: string, notify = true): Promise<boolean> {
    await this.#beforeLifecycleMutation?.(threadId)
    return this.#enqueue(threadId, async () => {
      const entry = this.#goals.get(threadId)
      if (!entry) return false
      const archivedGoal = materializeGoal(entry.goal, this.#clock)
      const archiveStatus: GoalArchiveStatus = terminalArchiveStatus(archivedGoal.status) ?? "cleared"
      const terminalAt = archiveStatus === "cleared" ? this.#clock() : archivedGoal.updatedAt
      const existingArchive = archiveStatus === "cleared"
        ? undefined
        : this.#archive.find((item) => archiveEntryMatchesGoal(item, archivedGoal, archiveStatus, terminalAt))
      const archiveEntry = existingArchive ?? archiveEntryForGoal(archivedGoal, archiveStatus, terminalAt)
      if (!existingArchive) this.#upsertArchive(archiveEntry)
      this.#goals.delete(threadId)
      await this.#persist(
        "clear",
        threadId,
        undefined,
        existingArchive ? undefined : { action: "upsert", entry: archiveEntry },
        !existingArchive,
      )
      if (notify && this.#onClear) this.#notify(() => this.#onClear?.(cloneGoal(entry.goal)))
      return true
    })
  }

  async purge(threadId: string): Promise<GoalPurgeResult> {
    await this.#beforeLifecycleMutation?.(threadId)
    return this.#enqueue(threadId, async () => {
      const entry = this.#goals.get(threadId)
      const archiveRemoved = this.#archive.filter((item) => item.threadId === threadId).length
      this.#goals.delete(threadId)
      this.#archive = this.#archive.filter((item) => item.threadId !== threadId)
      const persisted = await this.#persistence?.purge(threadId)
      if (entry && this.#onClear) this.#notify(() => this.#onClear?.(cloneGoal(entry.goal)))
      return {
        currentRemoved: persisted?.currentRemoved ?? Boolean(entry),
        archiveRemoved: persisted?.archiveRemoved ? Math.max(archiveRemoved, 1) : archiveRemoved,
      }
    })
  }

  // Listeners are best-effort observers (toasts, session title). A throwing
  // listener must never break persistence or the goal loop.
  #notify(run: () => void): void {
    try {
      run()
    } catch {
      // Intentionally swallowed: notification side effects are non-critical.
    }
  }
}

export function createGoal(
  threadId: string,
  objective: string,
  tokenBudget: number | null,
  mode: GoalMode = "standard",
  checks: readonly string[] = [],
  clock: GoalClock = nowSeconds,
  policy?: GoalPolicy,
): StoredGoal {
  const seconds = clock()
  return {
    threadId,
    objective,
    status: "active",
    mode,
    checks: checks.map((text, index) => ({
      id: `C${index + 1}`,
      text,
      status: "pending",
      evidence: "",
      updatedAt: Date.now(),
    })),
    policy: policy ? structuredClone(policy) : defaultGoalPolicy(tokenBudget),
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: seconds,
    updatedAt: seconds,
    continuationCount: 0,
    activeStartedAtSeconds: seconds,
    lastContinueAt: 0,
    lastProgressAt: seconds,
    usageLimitedUntil: 0,
    usageLimitedReason: "",
    promptFailureCount: 0,
    noProgressTurns: 0,
    noToolCallTurns: 0,
    budgetWrapupSent: false,
    evaluatorFeedback: "",
    completionRejectedCount: 0,
    lastAssistantText: "",
    lastAssistantTextLength: 0,
    lastAssistantMessageId: "",
    lastEvidence: "",
    blockedReason: "",
    history: [{ timestamp: seconds * 1000, type: "created", detail: "Goal created." }],
  }
}

export function activeTimeSeconds(goal: StoredGoal, clock: GoalClock = nowSeconds): number {
  const accumulated = Math.max(0, goal.timeUsedSeconds)
  if (goal.activeStartedAtSeconds === null) return accumulated
  return accumulated + Math.max(0, clock() - goal.activeStartedAtSeconds)
}

export function accrueActiveTime(goal: StoredGoal, clock: GoalClock = nowSeconds): number {
  const now = clock()
  if (goal.activeStartedAtSeconds !== null) {
    goal.timeUsedSeconds = Math.max(0, goal.timeUsedSeconds) + Math.max(0, now - goal.activeStartedAtSeconds)
    goal.activeStartedAtSeconds = now
  }
  return goal.timeUsedSeconds
}

export function stopActiveTime(goal: StoredGoal, clock: GoalClock = nowSeconds): number {
  const result = accrueActiveTime(goal, clock)
  goal.activeStartedAtSeconds = null
  return result
}

export function startActiveTime(goal: StoredGoal, clock: GoalClock = nowSeconds): void {
  if (goal.activeStartedAtSeconds === null) goal.activeStartedAtSeconds = clock()
}

function isChargeable(goal: StoredGoal): boolean {
  return goal.status === "active" && goal.usageLimitedUntil === 0 && !goal.usageLimitedReason
}

function synchronizeActiveTime(goal: StoredGoal, clock: GoalClock): void {
  const now = clock()
  accrueActiveTime(goal, () => now)
  goal.activeStartedAtSeconds = isChargeable(goal) ? now : null
}

export function touchGoal(
  goal: StoredGoal,
  type: string,
  detail: string,
  clock: GoalClock = nowSeconds,
): StoredGoal {
  const now = clock()
  synchronizeActiveTime(goal, () => now)
  goal.updatedAt = now
  goal.history = [
    ...goal.history,
    {
      timestamp: now * 1000,
      type: truncateCodePoints(type, GOAL_LIMITS.historyTypeCodePoints),
      detail: truncateCodePoints(detail, GOAL_LIMITS.detailCodePoints),
    },
  ].slice(-GOAL_LIMITS.historyEntries)
  return goal
}
