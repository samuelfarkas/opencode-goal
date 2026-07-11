import assert from "node:assert/strict"
import { access, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { decideContinuation } from "../src/continuation.ts"
import { GOAL_LIMITS, validateArchiveEntry } from "../src/goal-contract.ts"
import { resolveOptions } from "../src/options.ts"
import { applyAssistantTokenTotal } from "../src/parts.ts"
import {
  GoalPersistence,
  LEDGER_STREAM_MEMORY_BYTES,
  PersistenceRecoveryError,
  TERMINAL_RETENTION_COUNT,
  TERMINAL_RETENTION_SECONDS,
  UnsupportedPersistenceVersionError,
} from "../src/persistence.ts"
import { createGoal, GoalStore, touchGoal } from "../src/store.ts"
import type { SessionMessage, StoredGoal } from "../src/types.ts"

function pathPolicy(options: ReturnType<typeof resolveOptions>) {
  return {
    trustRoot: options.stateFileTrustRoot,
    projectLocal: options.stateFileProjectLocal,
  }
}

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return ""
  return typeof error.code === "string" ? error.code : ""
}

async function createSymlink(
  t: TestContext,
  target: string,
  path: string,
  type: "file" | "dir",
): Promise<boolean> {
  try {
    await symlink(target, path, type)
    return true
  } catch (error) {
    if (["EACCES", "ENOSYS", "EPERM"].includes(errorCode(error))) {
      t.skip(`platform cannot create ${type} symlinks`)
      return false
    }
    throw error
  }
}

test("state paths resolve against the plugin directory and reject relative escape", async () => {
  const project = await mkdtemp(join(tmpdir(), "opencode-goal-options-project-"))
  assert.notEqual(project, process.cwd())

  const relative = resolveOptions({ stateFilePath: "var/goals.json" }, project)
  assert.equal(relative.stateFilePath, join(project, "var", "goals.json"))
  assert.equal(relative.stateFileTrustRoot, project)
  assert.equal(relative.stateFileProjectLocal, true)

  const defaults = resolveOptions({}, project)
  assert.equal(defaults.stateFilePath, join(project, ".opencode", "goals", "opencode-goal-state.json"))
  assert.throws(
    () => resolveOptions({ stateFilePath: "../outside.json" }, project),
    /Unsafe stateFilePath.*relative paths must stay within plugin directory/,
  )
})

test("safe explicit absolute state paths remain supported", async () => {
  const project = await mkdtemp(join(tmpdir(), "opencode-goal-options-base-"))
  const destination = await mkdtemp(join(tmpdir(), "opencode-goal-options-absolute-"))
  const absolute = join(destination, "state.json")
  const options = resolveOptions({ stateFilePath: absolute }, project)
  assert.equal(options.stateFilePath, absolute)
  assert.equal(options.stateFileProjectLocal, false)

  const store = new GoalStore(
    options.stateFilePath,
    true,
    undefined,
    undefined,
    undefined,
    pathPolicy(options),
  )
  await store.replace(createGoal("session-1", "persist explicitly", null))
  assert.match(await readFile(absolute, "utf8"), /persist explicitly/)
})

test("a symlinked project root is trusted after canonicalization", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "opencode-goal-real-project-"))
  const linkParent = await mkdtemp(join(tmpdir(), "opencode-goal-project-link-"))
  const linkedProject = join(linkParent, "project")
  if (!(await createSymlink(t, project, linkedProject, "dir"))) return
  const options = resolveOptions({ stateFilePath: "state/goal.json" }, linkedProject)
  const store = new GoalStore(
    options.stateFilePath,
    true,
    undefined,
    undefined,
    undefined,
    pathPolicy(options),
  )

  await store.replace(createGoal("session-1", "allow linked workspace root", null))
  assert.match(await readFile(join(project, "state", "goal.json"), "utf8"), /allow linked workspace root/)
})

test("project-local directory symlinks fail closed without an outside write", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "opencode-goal-project-symlink-"))
  const outside = await mkdtemp(join(tmpdir(), "opencode-goal-project-outside-"))
  if (!(await createSymlink(t, outside, join(project, "redirected"), "dir"))) return
  const options = resolveOptions({ stateFilePath: "redirected/state.json" }, project)
  const store = new GoalStore(
    options.stateFilePath,
    true,
    undefined,
    undefined,
    undefined,
    pathPolicy(options),
  )

  await assert.rejects(
    store.replace(createGoal("session-1", "must stay local", null)),
    /Unsafe persistence path.*redirected.*directory component is a symbolic link/,
  )
  await assert.rejects(access(join(outside, "state.json")))
})

test("state and ledger leaf symlinks are rejected without changing their targets", async (t) => {
  for (const leaf of ["state", "ledger"] as const) {
    const project = await mkdtemp(join(tmpdir(), `opencode-goal-${leaf}-symlink-`))
    const goals = join(project, "goals")
    await mkdir(goals)
    const outside = join(project, `${leaf}-outside.txt`)
    await writeFile(outside, `${leaf} sentinel`)
    const state = join(goals, "state.json")
    const redirected = leaf === "state" ? state : `${state}.ledger.jsonl`
    if (!(await createSymlink(t, outside, redirected, "file"))) return
    const options = resolveOptions({ stateFilePath: "goals/state.json" }, project)
    const store = new GoalStore(
      options.stateFilePath,
      true,
      undefined,
      undefined,
      undefined,
      pathPolicy(options),
    )

    await assert.rejects(
      store.replace(createGoal("session-1", `reject ${leaf} redirection`, null)),
      new RegExp(`Unsafe persistence path.*${leaf === "state" ? "state file" : "ledger file"} is a symbolic link`),
    )
    assert.equal(await readFile(outside, "utf8"), `${leaf} sentinel`)
    if (leaf === "ledger") await assert.rejects(access(state))
  }
})

test("archive leaf symlinks are rejected before clear changes durable goal state", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "opencode-goal-archive-symlink-"))
  const goals = join(project, "goals")
  await mkdir(goals)
  const state = join(goals, "state.json")
  const options = resolveOptions({ stateFilePath: "goals/state.json" }, project)
  const store = new GoalStore(options.stateFilePath, true, undefined, undefined, undefined, pathPolicy(options))
  await store.replace(createGoal("session-1", "reject archive redirection", null))
  const outside = join(project, "archive-outside.txt")
  await writeFile(outside, "archive sentinel")
  if (!(await createSymlink(t, outside, `${state}.archive.json`, "file"))) return

  await assert.rejects(
    store.clear("session-1"),
    /Unsafe persistence path.*archive file is a symbolic link/,
  )
  assert.equal(await readFile(outside, "utf8"), "archive sentinel")
  await rm(`${state}.archive.json`)
  const restarted = new GoalStore(state, true)
  await restarted.load()
  assert.equal(restarted.read("session-1")?.goal.objective, "reject archive redirection")
})

test("a hard-linked ledger is rejected before either durable target changes", async () => {
  const project = await mkdtemp(join(tmpdir(), "opencode-goal-ledger-hardlink-"))
  const goals = join(project, "goals")
  await mkdir(goals)
  const outside = join(project, "outside.txt")
  await writeFile(outside, "hard-link sentinel")
  const state = join(goals, "state.json")
  await link(outside, `${state}.ledger.jsonl`)
  const options = resolveOptions({ stateFilePath: "goals/state.json" }, project)
  const store = new GoalStore(
    options.stateFilePath,
    true,
    undefined,
    undefined,
    undefined,
    pathPolicy(options),
  )

  await assert.rejects(
    store.replace(createGoal("session-1", "reject ledger hard link", null)),
    /Unsafe persistence path.*ledger file has multiple hard links/,
  )
  assert.equal(await readFile(outside, "utf8"), "hard-link sentinel")
  await assert.rejects(access(state))
})

test("non-regular state destinations are rejected with an actionable path error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-nonregular-"))
  const state = join(directory, "state.json")
  await mkdir(state)
  const store = new GoalStore(state, true)

  await assert.rejects(
    store.replace(createGoal("session-1", "reject directory leaf", null)),
    /Unsafe persistence path.*state\.json.*state file is not a regular file/,
  )
})

test("invalid persisted scalar, identifier, and string contracts fail closed without rewriting", async () => {
  const cases: Array<{
    name: string
    mutate: (goal: Record<string, unknown>) => void
  }> = [
    { name: "negative counter", mutate: (goal) => { goal.tokensUsed = -1 } },
    { name: "unsafe number", mutate: (goal) => { goal.continuationCount = Number.MAX_SAFE_INTEGER + 1 } },
    {
      name: "zero budget",
      mutate: (goal) => { (goal.policy as Record<string, unknown>).tokenBudget = 0 },
    },
    {
      name: "zero policy turns",
      mutate: (goal) => { (goal.policy as Record<string, unknown>).maxTurns = 0 },
    },
    {
      name: "too many constraints",
      mutate: (goal) => {
        (goal.policy as Record<string, unknown>).constraints = Array.from({ length: GOAL_LIMITS.constraints + 1 }, () => "bounded")
      },
    },
    {
      name: "duplicate check ids",
      mutate: (goal) => {
        goal.checks = [
          { id: "C1", text: "first", status: "pending", evidence: "", updatedAt: Date.now() },
          { id: "C1", text: "second", status: "pending", evidence: "", updatedAt: Date.now() },
        ]
      },
    },
    {
      name: "future active anchor",
      mutate: (goal) => { goal.activeStartedAtSeconds = Math.floor(Date.now() / 1000) + 60 },
    },
    {
      name: "oversized detail",
      mutate: (goal) => { goal.lastEvidence = "x".repeat(GOAL_LIMITS.detailCodePoints + 1) },
    },
    { name: "unknown field", mutate: (goal) => { goal.unboundedFutureField = "value" } },
  ]

  for (const item of cases) {
    const directory = await mkdtemp(join(tmpdir(), `opencode-goal-invalid-${item.name.replaceAll(" ", "-")}-`))
    const file = join(directory, "state.json")
    const goal: Record<string, unknown> = { ...createGoal("session-1", "validate persisted state", null) }
    item.mutate(goal)
    const raw = `${JSON.stringify({ version: 1, goals: [goal] })}\n`
    await writeFile(file, raw)

    const store = new GoalStore(file, true)
    await assert.rejects(store.load(), PersistenceRecoveryError)
    assert.equal(await readFile(file, "utf8"), raw, item.name)
  }
})

test("snapshot goal count and pre-read file byte caps fail closed", async () => {
  const countDirectory = await mkdtemp(join(tmpdir(), "opencode-goal-count-cap-"))
  const countFile = join(countDirectory, "state.json")
  const goal = createGoal("session-1", "bounded", null)
  await writeFile(
    countFile,
    `${JSON.stringify({ version: 1, goals: Array.from({ length: GOAL_LIMITS.goalsPerSnapshot + 1 }, () => goal) })}\n`,
  )
  const countBefore = await readFile(countFile, "utf8")
  await assert.rejects(new GoalStore(countFile, true).load(), /exceeds 1000 goals/)
  assert.equal(await readFile(countFile, "utf8"), countBefore)

  const snapshotDirectory = await mkdtemp(join(tmpdir(), "opencode-goal-snapshot-cap-"))
  const snapshotFile = join(snapshotDirectory, "state.json")
  await writeFile(snapshotFile, "")
  await truncate(snapshotFile, GOAL_LIMITS.snapshotBytes + 1)
  await assert.rejects(new GoalStore(snapshotFile, true).load(), /state file exceeds 8388608 bytes/)
  assert.equal((await stat(snapshotFile)).size, GOAL_LIMITS.snapshotBytes + 1)

  const ledgerDirectory = await mkdtemp(join(tmpdir(), "opencode-goal-ledger-cap-"))
  const ledgerFile = join(ledgerDirectory, "state.json.ledger.jsonl")
  await writeFile(ledgerFile, "")
  await truncate(ledgerFile, GOAL_LIMITS.ledgerBytes + 1)
  await assert.rejects(new GoalStore(join(ledgerDirectory, "state.json"), true).load(), /ledger file exceeds 67108864 bytes/)
  assert.equal((await stat(ledgerFile)).size, GOAL_LIMITS.ledgerBytes + 1)
})

test("invalid outbound state is rejected before a durable file is created", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-invalid-outbound-"))
  const file = join(directory, "state.json")
  const goal = createGoal("session-1", "reject invalid outbound", null)
  goal.tokensUsed = -1
  const store = new GoalStore(file, true)

  await assert.rejects(store.replace(goal), /Invalid goal state.*tokensUsed must be non-negative/)
  await assert.rejects(access(file))
})

test("oversized outbound snapshots are rejected before the atomic write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-outbound-cap-"))
  const file = join(directory, "state.json")
  const now = Math.floor(Date.now() / 1000)
  const goals = Array.from({ length: 60 }, (_, index) => {
    const goal = createGoal(`session-${index}`, "bounded outbound", null, "standard", [], () => now)
    goal.history = Array.from({ length: GOAL_LIMITS.historyEntries }, (_, historyIndex) => ({
      timestamp: now * 1000,
      type: `entry-${historyIndex}`,
      detail: "x".repeat(GOAL_LIMITS.detailCodePoints),
    }))
    return goal
  })
  const persistence = new GoalPersistence(file, () => now)

  await assert.rejects(
    persistence.persist(goals),
    /state file would exceed 8388608 bytes/,
  )
  await assert.rejects(access(file))
})

test("GoalStore persists durable goals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-goal-store-"))
  const file = join(dir, "state.json")
  const store = new GoalStore(file, true)
  await store.replace(createGoal("session-1", "ship the parser", 1234))

  const raw = JSON.parse(await readFile(file, "utf8")) as {
    goals: Array<{ threadId: string; policy: { tokenBudget: number } }>
  }
  assert.equal(raw.goals[0]?.threadId, "session-1")
  assert.equal(raw.goals[0]?.policy.tokenBudget, 1234)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal((await stat(`${file}.ledger.jsonl`)).mode & 0o777, 0o600)

  const next = new GoalStore(file, true)
  await next.load()
  assert.equal(next.read("session-1")?.goal.objective, "ship the parser")
})

test("legacy token budgets migrate once into resolved policy and ignore later config changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-policy-migration-"))
  const file = join(directory, "state.json")
  const legacy = createGoal("session-1", "migrate policy", 123)
  const rawLegacy = structuredClone(legacy) as unknown as Record<string, unknown>
  delete rawLegacy.policy
  rawLegacy.tokenBudget = 123
  await writeFile(file, `${JSON.stringify({ version: 2, lastSequence: 0, goals: [rawLegacy] })}\n`)

  const firstDefaults = { maxTurns: 3, maxDurationSeconds: 600, tokenBudget: 999, constraints: [] }
  const first = new GoalStore(file, true, undefined, undefined, undefined, undefined, undefined, firstDefaults)
  await first.load()
  assert.deepEqual(first.read("session-1")?.goal.policy, {
    maxTurns: 3,
    maxDurationSeconds: 600,
    tokenBudget: 123,
    constraints: [],
  })
  const migrated = JSON.parse(await readFile(file, "utf8")) as { goals: Array<Record<string, unknown>> }
  assert.equal(Object.hasOwn(migrated.goals[0] ?? {}, "tokenBudget"), false)
  assert.deepEqual(migrated.goals[0]?.policy, first.read("session-1")?.goal.policy)

  const changedDefaults = { maxTurns: 90, maxDurationSeconds: 9_000, tokenBudget: 9_999, constraints: [] }
  const restarted = new GoalStore(file, true, undefined, undefined, undefined, undefined, undefined, changedDefaults)
  await restarted.load()
  assert.deepEqual(restarted.read("session-1")?.goal.policy, first.read("session-1")?.goal.policy)
})

test("separate persistence instances serialize mutations without losing either session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-cross-process-"))
  const file = join(directory, "state.json")
  const first = new GoalStore(file, true)
  const second = new GoalStore(file, true)

  await Promise.all([
    first.replace(createGoal("session-a", "first writer", null)),
    second.replace(createGoal("session-b", "second writer", null)),
  ])

  const restarted = new GoalStore(file, true)
  await restarted.load()
  assert.equal(restarted.read("session-a")?.goal.objective, "first writer")
  assert.equal(restarted.read("session-b")?.goal.objective, "second writer")
  const ledger = (await readFile(`${file}.ledger.jsonl`, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { sequence: number })
  assert.deepEqual(ledger.map((entry) => entry.sequence), [1, 2])
  await assert.rejects(access(`${file}.lock`))
})

test("ledger-first failpoints preserve the exact durable set and clear outcomes", async () => {
  for (const point of ["before-ledger-append", "after-ledger-append", "after-snapshot-write"] as const) {
    const directory = await mkdtemp(join(tmpdir(), `opencode-goal-failpoint-${point}-`))
    const file = join(directory, "state.json")
    const goal = createGoal("session-1", `crash at ${point}`, null)
    const persistence = new GoalPersistence(file, undefined, undefined, {
      failpoint: (current) => {
        if (current === point) throw new Error(`simulated ${point}`)
      },
    })

    await assert.rejects(
      persistence.persist([goal], { action: "set", goal }),
      new RegExp(`simulated ${point}`),
    )
    await assert.rejects(access(`${file}.lock`))
    const restarted = new GoalStore(file, true)
    await restarted.load()
    if (point === "before-ledger-append") {
      assert.equal(restarted.read("session-1"), undefined)
      continue
    }
    assert.equal(restarted.read("session-1")?.goal.objective, `crash at ${point}`)
    assert.equal(
      restarted.read("session-1")?.goal.status,
      point === "after-ledger-append" ? "paused" : "active",
    )
  }

  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-clear-failpoint-"))
  const file = join(directory, "state.json")
  const seeded = new GoalStore(file, true)
  await seeded.replace(createGoal("session-1", "clear durably", null))
  let failClear = false
  const clearing = new GoalStore(file, true, undefined, undefined, undefined, undefined, {
    failpoint: (point) => {
      if (failClear && point === "after-ledger-append") throw new Error("simulated clear crash")
    },
  })
  await clearing.load()
  failClear = true
  await assert.rejects(clearing.clear("session-1"), /simulated clear crash/)
  const restarted = new GoalStore(file, true)
  await restarted.load()
  assert.equal(restarted.read("session-1"), undefined)
})

test("v1 migration preserves valid emptiness and snapshot sequence positions", async () => {
  const emptyDirectory = await mkdtemp(join(tmpdir(), "opencode-goal-empty-v1-"))
  const emptyFile = join(emptyDirectory, "state.json")
  const legacyGoal = createGoal("old-session", "must remain cleared", null)
  await writeFile(emptyFile, `${JSON.stringify({ version: 1, goals: [] })}\n`)
  await writeFile(
    `${emptyFile}.ledger.jsonl`,
    `${JSON.stringify({ version: 1, timestamp: Date.now(), action: "set", ...legacyGoal })}\n`,
  )
  const empty = await new GoalPersistence(emptyFile).load()
  assert.equal(empty.outcome, "migrated-v1")
  assert.deepEqual(empty.goals, [])
  assert.equal(empty.lastSequence, 1)
  const migratedEmpty = JSON.parse(await readFile(emptyFile, "utf8")) as { version: number; lastSequence: number; goals: unknown[] }
  assert.deepEqual(migratedEmpty, { version: 2, lastSequence: 1, goals: [] })

  const sequenceDirectory = await mkdtemp(join(tmpdir(), "opencode-goal-sequence-position-"))
  const sequenceFile = join(sequenceDirectory, "state.json")
  const goal = createGoal("session-1", "snapshot ahead", null)
  const persistence = new GoalPersistence(sequenceFile)
  await persistence.persist([goal], { action: "set", goal })
  const snapshot = JSON.parse(await readFile(sequenceFile, "utf8")) as { version: 2; lastSequence: number; goals: unknown[] }
  snapshot.lastSequence = 2
  await writeFile(sequenceFile, `${JSON.stringify(snapshot)}\n`)
  const ahead = await new GoalPersistence(sequenceFile).load()
  assert.equal(ahead.outcome, "valid")
  assert.equal(ahead.lastSequence, 2)
  const updated = createGoal("session-2", "sequence after gap", null)
  await new GoalPersistence(sequenceFile).persist([goal, updated], { action: "set", goal: updated })
  const sequences = (await readFile(`${sequenceFile}.ledger.jsonl`, "utf8"))
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { sequence: number }).sequence)
  assert.deepEqual(sequences, [1, 3])
})

test("partial snapshots recover invalid targets without overwriting valid goals or leaking content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-partial-recovery-"))
  const file = join(directory, "state.json")
  const persistence = new GoalPersistence(file)
  const valid = createGoal("valid-session", "ledger version must not win", null)
  const recoverable = createGoal("recover-session", "ledger recovery secret", null)
  const unidentified = createGoal("unknown-session", "unidentified recovery secret", null)
  await persistence.persist([valid], { action: "set", goal: valid })
  await persistence.persist([valid, recoverable], { action: "set", goal: recoverable })
  await persistence.persist([valid, recoverable, unidentified], { action: "set", goal: unidentified })
  const snapshot = JSON.parse(await readFile(file, "utf8")) as {
    version: 2
    lastSequence: number
    goals: Array<Record<string, unknown>>
  }
  snapshot.goals[0]!.objective = "snapshot authoritative secret"
  snapshot.goals[1]!.tokensUsed = -1
  delete snapshot.goals[2]!.threadId
  await writeFile(file, `${JSON.stringify(snapshot)}\n`)

  const loaded = await new GoalPersistence(file).load((goal) => {
    if (goal.status === "active") {
      goal.status = "paused"
      touchGoal(goal, "recovered", "Recovered from append-only ledger; paused until user resumes.")
    }
    return goal
  })
  assert.equal(loaded.outcome, "recovered-partial")
  assert.equal(loaded.goals.find((goal) => goal.threadId === "valid-session")?.objective, "snapshot authoritative secret")
  assert.equal(loaded.goals.find((goal) => goal.threadId === "valid-session")?.status, "active")
  assert.equal(loaded.goals.find((goal) => goal.threadId === "recover-session")?.status, "paused")
  assert.equal(loaded.goals.find((goal) => goal.threadId === "unknown-session")?.status, "paused")
  const diagnostics = JSON.stringify(loaded.diagnostics)
  assert.doesNotMatch(diagnostics, /snapshot authoritative secret|ledger recovery secret|unidentified recovery secret/)
  assert.match(diagnostics, /snapshot-invalid-goals/)
})

test("an incomplete ledger tail is ignored once and truncated before the next intent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-ledger-tail-"))
  const file = join(directory, "state.json")
  const first = createGoal("session-1", "before partial tail", null)
  const persistence = new GoalPersistence(file)
  await persistence.persist([first], { action: "set", goal: first })
  const ledgerPath = `${file}.ledger.jsonl`
  const completeLedger = await readFile(ledgerPath, "utf8")
  await writeFile(ledgerPath, `${completeLedger}{"version":2,"sequence":2`)

  const observed = await new GoalPersistence(file).load()
  assert.deepEqual(observed.diagnostics, [{ code: "ledger-incomplete-tail" }])
  assert.equal(observed.lastSequence, 1)

  const second = createGoal("session-2", "after partial tail", null)
  await new GoalPersistence(file).persist([first, second], { action: "set", goal: second })
  const restarted = await new GoalPersistence(file).load()
  assert.deepEqual(restarted.goals.map((goal) => goal.threadId).sort(), ["session-1", "session-2"])
  const lines = (await readFile(ledgerPath, "utf8")).trim().split("\n")
  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map((line) => (JSON.parse(line) as { sequence: number }).sequence), [1, 2])
})

test("dead same-host locks are reclaimed while foreign-host ownership fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-stale-lock-"))
  const file = join(directory, "state.json")
  const lock = `${file}.lock`
  await writeFile(lock, `${JSON.stringify({ pid: 424242, hostname: "test-host", nonce: "stale", createdAt: 1 })}\n`)
  const reclaimed = await new GoalPersistence(file, undefined, undefined, {
    hostname: "test-host",
    isProcessAlive: () => false,
  }).load()
  assert.equal(reclaimed.outcome, "missing")
  await assert.rejects(access(lock))

  let now = 0
  await writeFile(lock, `${JSON.stringify({ pid: 424242, hostname: "other-host", nonce: "foreign", createdAt: 1 })}\n`)
  const foreign = new GoalPersistence(file, undefined, undefined, {
    hostname: "test-host",
    nowMilliseconds: () => now,
    sleep: async (milliseconds) => { now += milliseconds },
    lockTimeoutMs: 50,
  })
  await assert.rejects(foreign.load(), /could not be acquired before timeout/)
  assert.match(await readFile(lock, "utf8"), /other-host/)
})

test("future snapshot and ledger versions fail closed unless a complete snapshot covers the ledger", async () => {
  const futureDirectory = await mkdtemp(join(tmpdir(), "opencode-goal-future-snapshot-"))
  const futureFile = join(futureDirectory, "state.json")
  const futureBytes = `${JSON.stringify({ version: 3, lastSequence: 9, goals: [] })}\n`
  await writeFile(futureFile, futureBytes)
  await assert.rejects(new GoalPersistence(futureFile).load(), UnsupportedPersistenceVersionError)
  assert.equal(await readFile(futureFile, "utf8"), futureBytes)
  assert.deepEqual(await readdir(futureDirectory), ["state.json"])

  const mixedDirectory = await mkdtemp(join(tmpdir(), "opencode-goal-future-ledger-"))
  const mixedFile = join(mixedDirectory, "state.json")
  const goal = createGoal("session-1", "covered future record", null)
  await new GoalPersistence(mixedFile).persist([goal], { action: "set", goal })
  const ledgerPath = `${mixedFile}.ledger.jsonl`
  const futureLedger = `${JSON.stringify({ version: 3, sequence: 1, timestamp: Date.now(), action: "opaque" })}\n`
  await writeFile(ledgerPath, futureLedger)
  const covered = await new GoalPersistence(mixedFile).load()
  assert.equal(covered.outcome, "valid")
  assert.deepEqual(covered.diagnostics, [{ code: "ledger-future-covered", ledgerVersion: 3, sequence: 1 }])
  assert.equal(await readFile(ledgerPath, "utf8"), futureLedger)
  const coveredSnapshot = await readFile(mixedFile, "utf8")
  await assert.rejects(
    new GoalPersistence(mixedFile).persist([goal], { action: "update", goal }),
    UnsupportedPersistenceVersionError,
  )
  assert.equal(await readFile(mixedFile, "utf8"), coveredSnapshot)
  assert.equal(await readFile(ledgerPath, "utf8"), futureLedger)

  const behind = JSON.parse(await readFile(mixedFile, "utf8")) as { lastSequence: number }
  behind.lastSequence = 0
  const behindBytes = `${JSON.stringify(behind)}\n`
  await writeFile(mixedFile, behindBytes)
  await assert.rejects(new GoalPersistence(mixedFile).load(), UnsupportedPersistenceVersionError)
  assert.equal(await readFile(mixedFile, "utf8"), behindBytes)
  assert.equal(await readFile(ledgerPath, "utf8"), futureLedger)
  await assert.rejects(access(`${mixedFile}.lock`))
})

test("semantic patches replay to the exact checkpointed goal state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-delta-replay-"))
  const file = join(directory, "state.json")
  const store = new GoalStore(file, true)
  await store.replace(createGoal("session-1", "delta replay", null))

  let current = store.read("session-1")
  if (!current) throw new Error("missing delta goal")
  await store.update("session-1", current.revision, (draft) => {
    draft.tokensUsed = 42
    draft.assistantTokenTotals = [{ messageId: "a1", total: 42 }]
    touchGoal(draft, "tokens", "accounted")
    return { commit: true, value: undefined }
  })
  current = store.read("session-1")
  if (!current) throw new Error("missing delta goal")
  await store.update("session-1", current.revision, (draft) => {
    draft.checks = [{ id: "C1", text: "verify", status: "satisfied", evidence: "passed", updatedAt: Date.now() }]
    draft.lastEvidence = "passed"
    draft.usageLimitedUntil = draft.updatedAt + 60
    draft.usageLimitedReason = "provider wait"
    touchGoal(draft, "check", "passed")
    return { commit: true, value: undefined }
  })
  current = store.read("session-1")
  if (!current) throw new Error("missing delta goal")
  await store.update("session-1", current.revision, (draft) => {
    draft.status = "paused"
    draft.activeStartedAtSeconds = null
    touchGoal(draft, "paused", "semantic transition")
    return { commit: true, value: undefined }
  })

  const durable = JSON.parse(await readFile(file, "utf8")) as { goals: StoredGoal[] }
  const actions = (await readFile(`${file}.ledger.jsonl`, "utf8"))
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { action: string }).action)
  assert.equal(actions[0], "checkpoint")
  assert.ok(actions.slice(1).every((action) => action === "patch"))
  await rm(file)
  const replayed = await new GoalPersistence(file).load()
  assert.deepEqual(replayed.goals, durable.goals)
})

test("threshold and clear compaction preserve sequence and remove live sensitive bytes", async () => {
  const thresholdDirectory = await mkdtemp(join(tmpdir(), "opencode-goal-threshold-compact-"))
  const thresholdFile = join(thresholdDirectory, "state.json")
  const thresholdStore = new GoalStore(thresholdFile, true, undefined, undefined, undefined, undefined, {
    ledgerCompactionActions: 3,
  })
  let current = await thresholdStore.replace(createGoal("session-1", "compact by threshold", null))
  for (const tokens of [1, 2]) {
    const updated = await thresholdStore.update("session-1", current.revision, (draft) => {
      draft.tokensUsed = tokens
      return { commit: true, value: undefined }
    })
    if (!updated.applied) throw new Error(`threshold update was ${updated.reason}`)
    current = updated.snapshot
  }
  const compacted = (await readFile(`${thresholdFile}.ledger.jsonl`, "utf8")).trim().split("\n")
  assert.equal(compacted.length, 1)
  const thresholdCheckpoint = JSON.parse(compacted[0]!) as { action: string; sequence: number }
  assert.equal(thresholdCheckpoint.action, "checkpoint-set")
  assert.equal(thresholdCheckpoint.sequence, 3)

  const clearDirectory = await mkdtemp(join(tmpdir(), "opencode-goal-clear-compact-"))
  const clearFile = join(clearDirectory, "state.json")
  const sensitive = createGoal("session-1", "sensitive objective to remove", null)
  sensitive.lastEvidence = "sensitive evidence to remove"
  const clearStore = new GoalStore(clearFile, true)
  await clearStore.replace(sensitive)
  await clearStore.clear("session-1")
  const liveLedger = await readFile(`${clearFile}.ledger.jsonl`, "utf8")
  assert.doesNotMatch(liveLedger, /sensitive objective to remove|sensitive evidence to remove/)
  const clearCheckpoint = JSON.parse(liveLedger) as { action: string; sequence: number; goals: unknown[] }
  assert.deepEqual({ action: clearCheckpoint.action, sequence: clearCheckpoint.sequence, goals: clearCheckpoint.goals }, {
    action: "checkpoint-set",
    sequence: 2,
    goals: [],
  })
})

test("compaction crash windows leave either the old or new ledger recoverable", async () => {
  for (const point of ["before-ledger-compaction-rename", "after-ledger-compaction-rename"] as const) {
    const directory = await mkdtemp(join(tmpdir(), `opencode-goal-compaction-${point}-`))
    const file = join(directory, "state.json")
    const seeded = new GoalStore(file, true)
    await seeded.replace(createGoal("session-1", `sensitive ${point}`, null))
    const crashing = new GoalStore(file, true, undefined, undefined, undefined, undefined, {
      failpoint: (currentPoint) => {
        if (currentPoint === point) throw new Error(`simulated ${point}`)
      },
    })
    await crashing.load()
    await assert.rejects(crashing.clear("session-1"), new RegExp(`simulated ${point}`))
    const restarted = new GoalStore(file, true)
    await restarted.load()
    assert.equal(restarted.read("session-1"), undefined)
    await assert.rejects(access(`${file}.lock`))
    assert.equal((await readdir(directory)).some((entry) => entry.endsWith(".tmp")), false)
  }
})

test("terminal retention keeps the newest hundred plus every active and paused goal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-terminal-retention-"))
  const file = join(directory, "state.json")
  const now = 2_000_000_000
  const store = new GoalStore(file, true, undefined, undefined, () => now)
  for (let index = 0; index < TERMINAL_RETENTION_COUNT + 5; index += 1) {
    const timestamp = now - index
    const goal = createGoal(`terminal-${index}`, `terminal ${index}`, null, "standard", [], () => timestamp)
    goal.status = "complete"
    goal.activeStartedAtSeconds = null
    await store.replace(goal)
  }
  const oldTimestamp = now - TERMINAL_RETENTION_SECONDS - 1
  const expired = createGoal("expired-terminal", "expired", null, "standard", [], () => oldTimestamp)
  expired.status = "blocked"
  expired.activeStartedAtSeconds = null
  await store.replace(expired)
  const active = createGoal("old-active", "always retained", null, "standard", [], () => oldTimestamp)
  await store.replace(active)
  const paused = createGoal("old-paused", "also retained", null, "standard", [], () => oldTimestamp)
  paused.status = "paused"
  paused.activeStartedAtSeconds = null
  await store.replace(paused)

  assert.equal(store.list().filter((goal) => goal.status === "complete").length, TERMINAL_RETENTION_COUNT)
  assert.equal(store.read("terminal-100"), undefined)
  assert.equal(store.read("expired-terminal"), undefined)
  assert.equal(store.read("old-active")?.goal.status, "active")
  assert.equal(store.read("old-paused")?.goal.status, "paused")
  const restarted = new GoalStore(file, true, undefined, undefined, () => now)
  await restarted.load()
  assert.equal(restarted.list().length, TERMINAL_RETENTION_COUNT + 2)
})

test("terminal archive entries are minimal, bounded, and exclude recovery-only details", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-archive-schema-"))
  const file = join(directory, "state.json")
  const now = 2_000_000_000
  const store = new GoalStore(file, true, undefined, undefined, () => now)
  const goal = createGoal("session-1", "publish bounded result", null, "standard", ["tests pass"], () => now)
  goal.lastAssistantText = "PRIVATE ASSISTANT CHECKPOINT"
  goal.lastAssistantTextLength = goal.lastAssistantText.length
  goal.usageLimitedUntil = now + 60
  goal.usageLimitedReason = "PRIVATE PROVIDER ERROR"
  goal.history.push({ timestamp: now * 1000, type: "provider", detail: "PRIVATE FULL HISTORY" })
  await store.replace(goal)
  const current = store.read("session-1")
  if (!current) throw new Error("missing goal")
  await store.update("session-1", current.revision, (draft) => {
    draft.status = "complete"
    draft.usageLimitedUntil = 0
    draft.usageLimitedReason = ""
    draft.tokensUsed = 321
    draft.continuationCount = 4
    draft.lastEvidence = "focused and release checks passed"
    draft.checks[0]!.status = "satisfied"
    draft.checks[0]!.evidence = "bun test passed"
    touchGoal(draft, "completed", "PRIVATE TERMINAL HISTORY", () => now)
    return { commit: true, value: undefined }
  })

  const [entry] = store.archive("session-1")
  if (!entry) throw new Error("missing archive entry")
  assert.deepEqual(Object.keys(entry).sort(), [
    "blockedReason", "checks", "continuationCount", "id", "lastEvidence", "objective",
    "status", "terminalAt", "threadId", "timeUsedSeconds", "tokensUsed",
  ])
  assert.deepEqual(entry.checks, [{ id: "C1", status: "satisfied" }])
  assert.equal(entry.status, "complete")
  assert.equal(entry.tokensUsed, 321)
  const serialized = await readFile(`${file}.archive.json`, "utf8")
  assert.doesNotMatch(serialized, /PRIVATE ASSISTANT CHECKPOINT|PRIVATE PROVIDER ERROR|PRIVATE FULL HISTORY|PRIVATE TERMINAL HISTORY/)

  const oversized = validateArchiveEntry({
    ...entry,
    objective: "x".repeat(GOAL_LIMITS.objectiveCodePoints + 1),
  }, now)
  assert.equal(oversized.ok, false)
  const unknown = validateArchiveEntry({ ...entry, providerError: "must not persist" }, now)
  assert.equal(unknown.ok, false)
})

test("terminal and clear transitions archive exactly once across duplicates and restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-archive-transitions-"))
  const file = join(directory, "state.json")
  const now = 2_000_000_000
  const store = new GoalStore(file, true, undefined, undefined, () => now)

  for (const status of ["complete", "blocked", "budgetLimited"] as const) {
    const threadId = `terminal-${status}`
    await store.replace(createGoal(threadId, `finish as ${status}`, null, "standard", [], () => now))
    const current = store.read(threadId)
    if (!current) throw new Error("missing goal")
    const terminal = await store.update(threadId, current.revision, (draft) => {
      draft.status = status
      draft.lastEvidence = status === "complete" ? "verified" : ""
      draft.blockedReason = status === "blocked" ? "external dependency" : ""
      touchGoal(draft, status, `became ${status}`, () => now)
      return { commit: true, value: undefined }
    })
    if (!terminal.applied) throw new Error("terminal transition failed")
    await store.update(threadId, terminal.snapshot.revision, (draft) => {
      touchGoal(draft, "duplicate", "duplicate terminal event", () => now)
      return { commit: true, value: undefined }
    })
    assert.equal(store.archive(threadId).length, 1)
    await store.clear(threadId)
    assert.equal(store.archive(threadId).length, 1)
    assert.equal(store.archive(threadId)[0]?.status, status)
  }

  await store.replace(createGoal("active-clear", "clear active", null, "standard", [], () => now))
  await store.clear("active-clear")
  assert.equal(store.archive("active-clear")[0]?.status, "cleared")
  await store.replace(createGoal("paused-clear", "clear paused", null, "standard", [], () => now))
  const paused = store.read("paused-clear")
  if (!paused) throw new Error("missing goal")
  await store.update("paused-clear", paused.revision, (draft) => {
    draft.status = "paused"
    touchGoal(draft, "paused", "paused", () => now)
    return { commit: true, value: undefined }
  })
  await store.clear("paused-clear")
  assert.equal(store.archive("paused-clear")[0]?.status, "cleared")

  for (let index = 0; index < 2; index += 1) {
    await store.replace(createGoal("repeat", "same goal in same second", null, "standard", [], () => now))
    await store.clear("repeat")
  }
  assert.equal(store.archive("repeat").length, 2)
  assert.equal(new Set(store.archive("repeat").map((entry) => entry.id)).size, 2)

  const beforeRestart = store.archive().map((entry) => entry.id)
  const restarted = new GoalStore(file, true, undefined, undefined, () => now)
  await restarted.load()
  assert.deepEqual(restarted.archive().map((entry) => entry.id), beforeRestart)
})

test("archive survives active recovery corruption without becoming current work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-archive-recovery-"))
  const file = join(directory, "state.json")
  const store = new GoalStore(file, true)
  await store.replace(createGoal("session-1", "archived result survives", null))
  await store.clear("session-1")
  const archiveBefore = await readFile(`${file}.archive.json`, "utf8")
  await writeFile(file, "{broken active snapshot")

  const restarted = new GoalStore(file, true)
  await restarted.load()
  assert.deepEqual(restarted.list(), [])
  assert.equal(restarted.archive("session-1").length, 1)
  assert.equal(restarted.archive("session-1")[0]?.objective, "archived result survives")
  assert.equal(await readFile(`${file}.archive.json`, "utf8"), archiveBefore)
})

test("archive retention prunes by exact age and newest-first count without affecting active goals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-archive-retention-"))
  const file = join(directory, "state.json")
  let now = 2_000_000_000
  const store = new GoalStore(file, true, undefined, undefined, () => now)
  for (let index = 0; index < GOAL_LIMITS.archiveEntries + 5; index += 1) {
    now += 1
    const threadId = `archive-${index}`
    await store.replace(createGoal(threadId, `archive ${index}`, null, "standard", [], () => now))
    await store.clear(threadId)
  }
  await store.replace(createGoal("active", "active remains current", null, "standard", [], () => now))
  assert.equal(store.archive().length, GOAL_LIMITS.archiveEntries)
  assert.equal(store.archive().some((entry) => entry.threadId === "archive-0"), false)
  assert.equal(store.archive()[0]?.threadId, `archive-${GOAL_LIMITS.archiveEntries + 4}`)
  assert.equal(store.read("active")?.goal.status, "active")

  const boundaryDirectory = await mkdtemp(join(tmpdir(), "opencode-goal-archive-age-"))
  const boundaryFile = join(boundaryDirectory, "state.json")
  now = 1_000_000_000
  const boundaryStore = new GoalStore(boundaryFile, true, undefined, undefined, () => now)
  await boundaryStore.replace(createGoal("boundary", "exact retention boundary", null, "standard", [], () => now))
  await boundaryStore.clear("boundary")
  now += TERMINAL_RETENTION_SECONDS
  const included = new GoalStore(boundaryFile, true, undefined, undefined, () => now)
  await included.load()
  assert.equal(included.archive("boundary").length, 1)
  now += 1
  const expired = new GoalStore(boundaryFile, true, undefined, undefined, () => now)
  await expired.load()
  assert.equal(expired.archive("boundary").length, 0)
  assert.doesNotMatch(await readFile(`${boundaryFile}.archive.json`, "utf8"), /exact retention boundary/)
})

test("purge removes one session from current archive and compacted recovery bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-archive-purge-"))
  const file = join(directory, "state.json")
  const store = new GoalStore(file, true)
  await store.replace(createGoal("s1", "PRIVATE ARCHIVED ALPHA", null))
  await store.clear("s1")
  await store.replace(createGoal("s2", "retained beta", null))
  await store.clear("s2")
  await store.replace(createGoal("s1", "PRIVATE CURRENT ALPHA", null))

  const result = await store.purge("s1")
  assert.deepEqual(result, { currentRemoved: true, archiveRemoved: 1 })
  assert.equal(store.read("s1"), undefined)
  assert.deepEqual(store.archive("s1"), [])
  assert.equal(store.archive("s2").length, 1)
  for (const path of [file, `${file}.ledger.jsonl`, `${file}.archive.json`]) {
    assert.doesNotMatch(await readFile(path, "utf8"), /PRIVATE (?:ARCHIVED|CURRENT) ALPHA/)
  }
})

test("ledger recovery streams large inputs within its documented line buffer and rejects oversized records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-stream-ledger-"))
  const file = join(directory, "state.json")
  const goal = createGoal("session-1", "stream a large ledger", null)
  const lines = Array.from({ length: 600 }, (_, index) => JSON.stringify({
    version: 1,
    timestamp: Date.now() + index,
    action: "set",
    ...goal,
    tokensUsed: index,
  }))
  await writeFile(`${file}.ledger.jsonl`, `${lines.join("\n")}\n`)
  const loaded = await new GoalPersistence(file).load()
  assert.equal(loaded.goals[0]?.tokensUsed, 599)
  assert.equal((await readFile(`${file}.ledger.jsonl`, "utf8")).trim().split("\n").length, 1)
  assert.equal(LEDGER_STREAM_MEMORY_BYTES, GOAL_LIMITS.snapshotBytes + 64 * 1024)

  const oversizedDirectory = await mkdtemp(join(tmpdir(), "opencode-goal-oversized-line-"))
  const oversizedFile = join(oversizedDirectory, "state.json")
  await writeFile(`${oversizedFile}.ledger.jsonl`, `${"x".repeat(GOAL_LIMITS.snapshotBytes + 1)}\n`)
  await assert.rejects(
    new GoalPersistence(oversizedFile).load(),
    /lines\[1\].*exceeds 8388608 bytes/,
  )
  await assert.rejects(access(oversizedFile))
})

test("GoalStore serializes conflicting updates and commits one expected revision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-goal-store-race-"))
  const file = join(dir, "state.json")
  const store = new GoalStore(file, true)
  await store.replace(createGoal("session-1", "ship the parser", 1234))

  const goal = store.read("session-1")
  if (!goal) throw new Error("missing goal")
  const results = await Promise.all([
    store.update("session-1", goal.revision, (draft) => {
      draft.tokensUsed = 10
      return { commit: true, value: "first" }
    }),
    store.update("session-1", goal.revision, (draft) => {
      draft.tokensUsed = 20
      return { commit: true, value: "second" }
    }),
    store.update("session-1", goal.revision, (draft) => {
      draft.tokensUsed = 30
      return { commit: true, value: "third" }
    }),
  ])

  const raw = JSON.parse(await readFile(file, "utf8")) as { goals: Array<{ tokensUsed: number }> }
  assert.equal(raw.goals[0]?.tokensUsed, 10)
  assert.equal(results.filter((result) => result.applied).length, 1)
  assert.deepEqual(results.filter((result) => !result.applied).map((result) => result.reason), ["stale", "stale"])
})

test("GoalStore reads isolated snapshots and rejects stale revisions", async () => {
  const store = new GoalStore("", false)
  const source = createGoal("session-1", "ship the parser", 1234)
  const replacing = store.replace(source)
  source.objective = "mutated input"
  const original = await replacing
  original.goal.objective = "mutated snapshot"
  original.goal.checks.push({ id: "C1", text: "leak", status: "pending", evidence: "", updatedAt: 0 })

  assert.equal(store.read("session-1")?.goal.objective, "ship the parser")
  assert.deepEqual(store.read("session-1")?.goal.checks, [])

  const updated = await store.update("session-1", original.revision, (draft) => {
    draft.tokensUsed = 10
    return { commit: true, value: undefined }
  })
  assert.equal(updated.applied, true)
  const stale = await store.update("session-1", original.revision, (draft) => {
    draft.tokensUsed = 20
    return { commit: true, value: undefined }
  })
  assert.deepEqual(stale, { applied: false, reason: "stale" })
  assert.equal(store.read("session-1")?.goal.tokensUsed, 10)
})

test("GoalStore migrates persisted usageLimited status back to active wait state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-goal-store-usage-limited-"))
  const file = join(dir, "state.json")
  const goal = createGoal("session-1", "wait for usage reset", 1234)
  goal.tokensUsed = 30
  goal.lastAssistantMessageId = "a1"
  const usageLimitedUntil = Math.floor(Date.now() / 1000) + 60
  const legacyGoal: Record<string, unknown> = {
    ...goal,
    status: "usageLimited",
    usageLimitedUntil,
    usageLimitedReason: "rate limit",
  }
  delete legacyGoal.lastStallEvaluatedAssistantMessageId
  delete legacyGoal.lastStallEvaluatedAssistantFingerprint
  delete legacyGoal.assistantTokenTotals
  delete legacyGoal.budgetWrapupPending
  delete legacyGoal.budgetWrapupLimitReason
  delete legacyGoal.budgetWrapupBaselineAssistantMessageId
  delete legacyGoal.activeStartedAtSeconds
  await writeFile(
    file,
    `${JSON.stringify({
      version: 1,
      goals: [legacyGoal],
    })}\n`,
    { encoding: "utf8" },
  )

  const store = new GoalStore(file, true)
  await store.load()

  const loaded = store.read("session-1")?.goal
  assert.equal(loaded?.status, "active")
  assert.equal(loaded?.usageLimitedReason, "rate limit")
  assert.equal(loaded?.usageLimitedUntil, usageLimitedUntil)
  assert.equal(loaded?.activeStartedAtSeconds, null)
  assert.equal(loaded?.lastStallEvaluatedAssistantMessageId, "")
  assert.equal(loaded?.lastStallEvaluatedAssistantFingerprint, "")
  assert.deepEqual(loaded?.assistantTokenTotals, [{ messageId: "a1", total: 30 }])
  assert.equal(loaded?.budgetWrapupPending, false)
  assert.equal(loaded?.budgetWrapupLimitReason, "")
  assert.equal(loaded?.budgetWrapupBaselineAssistantMessageId, "")
})

test("syntax-corrupt snapshots recover from the valid ledger and pause active work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-goal-store-ledger-"))
  const file = join(dir, "state.json")
  const store = new GoalStore(file, true)
  await store.replace(createGoal("session-1", "ship the parser", 1234))
  const ledgerBefore = await readFile(`${file}.ledger.jsonl`, "utf8")
  await writeFile(file, "{ broken json", { encoding: "utf8" })

  const recovered = new GoalStore(file, true)
  await recovered.load()
  assert.equal(recovered.read("session-1")?.goal.status, "paused")
  assert.equal(recovered.read("session-1")?.goal.history.at(-1)?.type, "recovered")
  const rewritten = JSON.parse(await readFile(file, "utf8")) as { version: number; lastSequence: number }
  assert.deepEqual(rewritten, { ...rewritten, version: 2, lastSequence: 1 })
  assert.equal(await readFile(`${file}.ledger.jsonl`, "utf8"), ledgerBefore)
})

test("unsafe ledger stops loading without skipping or rewriting the bad entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-invalid-ledger-"))
  const file = join(directory, "state.json")
  const ledger = `${file}.ledger.jsonl`
  const raw = `${JSON.stringify({ version: 1, timestamp: Date.now(), action: "set", ...createGoal("s1", "valid", null) })}\n{bad\n`
  await writeFile(ledger, raw)

  await assert.rejects(new GoalStore(file, true).load(), /Invalid goal ledger.*contains invalid JSON/)
  assert.equal(await readFile(ledger, "utf8"), raw)
  await assert.rejects(access(file))
})

test("persistence failure advances the revision so a stale writer cannot overwrite it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-goal-store-persist-failure-"))
  const file = join(dir, "state.json")
  const store = new GoalStore(file, true)
  const original = await store.replace(createGoal("session-1", "ship the parser", 1234))
  await rename(file, join(dir, "state-backup.json"))
  await mkdir(file)

  await assert.rejects(
    store.update("session-1", original.revision, (draft) => {
      draft.tokensUsed = 10
      return { commit: true, value: undefined }
    }),
  )
  const stale = await store.update("session-1", original.revision, (draft) => {
    draft.tokensUsed = 20
    return { commit: true, value: undefined }
  })

  assert.deepEqual(stale, { applied: false, reason: "stale" })
  assert.equal(store.read("session-1")?.goal.tokensUsed, 10)
})

test("a scored assistant checkpoint survives restart and is not counted twice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-goal-store-stall-checkpoint-"))
  const file = join(dir, "state.json")
  const options = resolveOptions({ noProgressTurnsBeforePause: 3 }, dir)
  const assistant: SessionMessage = {
    info: { id: "a1", role: "assistant", sessionID: "session-1", tokens: { output: 1 } },
    parts: [{ type: "text", text: "ok" }],
  }
  const goal = createGoal("session-1", "ship the parser", 1234)
  goal.continuationCount = 1
  decideContinuation({ goal, assistant, observation: "unchanged", options, canPrompt: true })

  const store = new GoalStore(file, true)
  await store.replace(goal)
  const restarted = new GoalStore(file, true)
  await restarted.load()
  const loaded = restarted.read("session-1")?.goal
  if (!loaded) throw new Error("missing restarted goal")
  decideContinuation({ goal: loaded, assistant, observation: "changed", options, canPrompt: true })

  assert.equal(loaded.noProgressTurns, 1)
  assert.equal(loaded.lastStallEvaluatedAssistantMessageId, "a1")
})

test("assistant token checkpoints survive restart and preserve positive deltas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-goal-store-token-checkpoint-"))
  const file = join(dir, "state.json")
  const first: SessionMessage = {
    info: { id: "a1", role: "assistant", sessionID: "session-1", tokens: { input: 10, output: 20 } },
  }
  const second: SessionMessage = {
    info: { id: "a2", role: "assistant", sessionID: "session-1", tokens: { input: 10, output: 30 } },
  }
  const goal = createGoal("session-1", "ship the parser", 1234)
  applyAssistantTokenTotal(goal, first, 50)

  const store = new GoalStore(file, true)
  await store.replace(goal)
  const restarted = new GoalStore(file, true)
  await restarted.load()
  const loaded = restarted.read("session-1")?.goal
  if (!loaded) throw new Error("missing restarted goal")

  assert.deepEqual(applyAssistantTokenTotal(loaded, first, 50), { changed: false, delta: 0 })
  assert.deepEqual(applyAssistantTokenTotal(loaded, second, 50), { changed: true, delta: 40 })
  assert.equal(loaded.tokensUsed, 70)
})

test("legacy active-time migration preserves accumulated time and excludes offline time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-goal-store-active-time-"))
  const file = join(dir, "state.json")
  let now = 1_000
  const clock = () => now
  const active: Record<string, unknown> = {
    ...createGoal("active", "ship", null, "standard", [], () => 100),
    timeUsedSeconds: 300,
  }
  const paused: Record<string, unknown> = {
    ...createGoal("paused", "wait", null, "standard", [], () => 100),
    status: "paused",
    timeUsedSeconds: 200,
  }
  delete active.activeStartedAtSeconds
  delete paused.activeStartedAtSeconds
  await writeFile(file, `${JSON.stringify({ version: 1, goals: [active, paused] })}\n`)

  const store = new GoalStore(file, true, undefined, undefined, clock)
  await store.load()
  assert.equal(store.read("active")?.goal.timeUsedSeconds, 300)
  assert.equal(store.read("active")?.goal.activeStartedAtSeconds, 1_000)
  assert.equal(store.read("paused")?.goal.timeUsedSeconds, 200)
  assert.equal(store.read("paused")?.goal.activeStartedAtSeconds, null)

  now = 1_100
  const current = store.read("active")
  if (!current) throw new Error("missing active goal")
  const touched = await store.update("active", current.revision, (draft) => {
    touchGoal(draft, "checkpoint", "persist active time", clock)
    return { commit: true, value: undefined }
  })
  assert.equal(touched.applied, true)
  assert.equal(store.read("active")?.goal.timeUsedSeconds, 400)

  now = 5_000
  const restarted = new GoalStore(file, true, undefined, undefined, clock)
  await restarted.load()
  assert.equal(restarted.read("active")?.goal.timeUsedSeconds, 400)
  assert.equal(restarted.read("active")?.goal.activeStartedAtSeconds, 5_000)
  assert.equal(restarted.read("paused")?.goal.timeUsedSeconds, 200)
  assert.equal(restarted.read("paused")?.goal.activeStartedAtSeconds, null)
})
