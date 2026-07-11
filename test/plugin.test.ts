import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { OpenCodeGoalPlugin } from "../src/index.ts"
import { partText } from "../src/parts.ts"
import type { MessagePart, OpencodeClient, SessionMessage } from "../src/types.ts"

function text(parts: MessagePart[]): string {
  return partText(parts)
}

async function tempState() {
  const dir = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-"))
  return join(dir, "state.json")
}

async function readGoals(stateFilePath: string) {
  const state = JSON.parse(await readFile(stateFilePath, "utf8")) as {
    goals: Array<{
      status: string
      objective: string
      mode: string
      continuationCount: number
      promptFailureCount: number
      usageLimitedUntil: number
      usageLimitedReason: string
      noProgressTurns: number
      budgetWrapupSent: boolean
      lastEvidence: string
      evaluatorFeedback: string
      checks: Array<{ id: string; status: string; text: string; evidence: string }>
      tokensUsed: number
      completionRejectedCount: number
      lastAssistantTextLength: number
      policy: {
        maxTurns: number
        maxDurationSeconds: number
        tokenBudget: number | null
        constraints: string[]
      }
    }>
  }
  return state.goals
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test("plugin registers its command through the config hook without overriding user config", async () => {
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath: await tempState() })
  const configure = hooks.config
  if (!configure) throw new Error("missing config hook")

  const config: Parameters<typeof configure>[0] = {}
  await configure(config)
  assert.deepEqual(config.command?.goal, {
    description: "Set a durable session goal.",
    template: "$ARGUMENTS",
  })

  const custom = {
    command: {
      goal: {
        description: "Keep my command.",
        template: "custom $ARGUMENTS",
      },
    },
  }
  await configure(custom)
  assert.deepEqual(custom.command.goal, {
    description: "Keep my command.",
    template: "custom $ARGUMENTS",
  })
})

test("/goal creates, reports, pauses, resumes, and clears a goal", async () => {
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath: await tempState() })
  const command = hooks["command.execute.before"]
  if (!command) throw new Error("missing command hook")

  const parts: MessagePart[] = []
  await command({ command: "goal", sessionID: "s1", arguments: "build the thing" }, { parts })
  assert.match(text(parts), /New active goal: build the thing/)

  await command({ command: "goal", sessionID: "s1", arguments: "status" }, { parts })
  assert.match(text(parts), /Status: active/)

  await command({ command: "goal", sessionID: "s1", arguments: "pause" }, { parts })
  assert.match(text(parts), /Status: paused/)

  await command({ command: "goal", sessionID: "s1", arguments: "resume" }, { parts })
  assert.match(text(parts), /Status: active/)

  await command({ command: "goal", sessionID: "s1", arguments: "clear" }, { parts })
  assert.equal(text(parts), "Goal cleared.")
})

test("/goal history is session-scoped after clear and purge removes current bytes", async () => {
  const stateFilePath = await tempState()
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath })
  const command = hooks["command.execute.before"]
  if (!command) throw new Error("missing command hook")
  const parts: MessagePart[] = []

  await command({ command: "goal", sessionID: "s1", arguments: "PRIVATE ARCHIVED ALPHA" }, { parts })
  await command({ command: "goal", sessionID: "s1", arguments: "history" }, { parts })
  assert.match(text(parts), /Current goal history: PRIVATE ARCHIVED ALPHA/)
  await command({ command: "goal", sessionID: "s1", arguments: "clear" }, { parts })
  await command({ command: "goal", sessionID: "s1", arguments: "history" }, { parts })
  assert.match(text(parts), /Recent archived results:[\s\S]*PRIVATE ARCHIVED ALPHA/)

  await command({ command: "goal", sessionID: "s2", arguments: "retained beta" }, { parts })
  await command({ command: "goal", sessionID: "s2", arguments: "clear" }, { parts })
  await command({ command: "goal", sessionID: "s1", arguments: "history" }, { parts })
  assert.doesNotMatch(text(parts), /retained beta/)
  await command({ command: "goal", sessionID: "s1", arguments: "PRIVATE CURRENT ALPHA" }, { parts })
  await command({ command: "goal", sessionID: "s1", arguments: "purge" }, { parts })
  assert.match(text(parts), /Goal data purged from current files \(1 archived result\)/)
  assert.match(text(parts), /logical deletion, not forensic secure erasure/)
  await command({ command: "goal", sessionID: "s1", arguments: "history" }, { parts })
  assert.equal(text(parts), "No goal history.")
  await command({ command: "goal", sessionID: "s2", arguments: "history" }, { parts })
  assert.match(text(parts), /retained beta/)

  for (const path of [stateFilePath, `${stateFilePath}.ledger.jsonl`, `${stateFilePath}.archive.json`]) {
    assert.doesNotMatch(await readFile(path, "utf8"), /PRIVATE (?:ARCHIVED|CURRENT) ALPHA/)
  }
})

test("/goal enforces shared check and evidence bounds without mutating on rejection", async () => {
  const stateFilePath = await tempState()
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath })
  const command = hooks["command.execute.before"]
  if (!command) throw new Error("missing command hook")
  const exactCheck = "😀".repeat(1_000)
  const parts: MessagePart[] = []

  await command(
    { command: "goal", sessionID: "s1", arguments: `--check "${exactCheck}" bounded goal` },
    { parts },
  )
  assert.match(text(parts), /Checklist mode enabled/)

  await command(
    { command: "goal", sessionID: "s1", arguments: `add "${exactCheck}😀"` },
    { parts },
  )
  assert.match(text(parts), /Check text is too long \(1001\/1000 characters\)/)
  let goals = await readGoals(stateFilePath)
  assert.equal(goals[0]?.checks.length, 1)

  await command(
    { command: "goal", sessionID: "s1", arguments: `done C1 "${"e".repeat(4_001)}"` },
    { parts },
  )
  assert.match(text(parts), /Evidence is too long \(4001\/4000 characters\)/)
  goals = await readGoals(stateFilePath)
  assert.equal(goals[0]?.checks[0]?.status, "pending")
  assert.equal(goals[0]?.checks[0]?.evidence, "")

  const tooManyChecks = Array.from({ length: 51 }, (_, index) => `--check "check ${index}"`).join(" ")
  await command(
    { command: "goal", sessionID: "s2", arguments: `${tooManyChecks} another goal` },
    { parts },
  )
  assert.match(text(parts), /Too many checks \(51\/50\)/)
  await command(
    { command: "goal", sessionID: "s2", arguments: "status" },
    { parts },
  )
  assert.match(text(parts), /No active goal/)
})

test("/goal commands use persisted state when transcript reconciliation is unavailable", async () => {
  const cases = [
    { command: "status", output: /Status: active/, status: "active", objective: "original goal" },
    { command: "pause", output: /Status: paused/, status: "paused", objective: "original goal" },
    { command: "clear", output: /Goal cleared/, status: undefined, objective: undefined },
    { command: "replacement goal", output: /New active goal: replacement goal/, status: "active", objective: "replacement goal" },
  ] as const

  for (const item of cases) {
    const stateFilePath = await tempState()
    let messageCalls = 0
    let logCalls = 0
    const client: OpencodeClient = {
      session: {
        messages: async () => {
          messageCalls += 1
          throw new Error("transcript offline")
        },
      },
      app: {
        log: async () => {
          logCalls += 1
          throw new Error("logger offline")
        },
      },
    }
    const hooks = await OpenCodeGoalPlugin({ client }, { stateFilePath })
    const command = hooks["command.execute.before"]
    if (!command) throw new Error("missing command hook")

    await command(
      { command: "goal", sessionID: "s1", arguments: "original goal" },
      { parts: [] },
    )
    const parts: MessagePart[] = []
    await command(
      { command: "goal", sessionID: "s1", arguments: item.command },
      { parts },
    )

    assert.match(text(parts), item.output, item.command)
    const goals = await readGoals(stateFilePath)
    assert.equal(goals[0]?.status, item.status, item.command)
    assert.equal(goals[0]?.objective, item.objective, item.command)
    assert.equal(messageCalls, 1, item.command)
    assert.equal(logCalls, 1, item.command)
  }
})

test("/goal still rejects when its authoritative persistence mutation fails", async () => {
  const stateFilePath = await tempState()
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath })
  const command = hooks["command.execute.before"]
  if (!command) throw new Error("missing command hook")
  await mkdir(stateFilePath)

  await assert.rejects(
    command(
      { command: "goal", sessionID: "s1", arguments: "must persist" },
      { parts: [] },
    ),
  )
})

test("/goal does not allow manually setting provider-wait status", async () => {
  const stateFilePath = await tempState()
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath })
  const command = hooks["command.execute.before"]
  if (!command) throw new Error("missing command hook")
  const parts: MessagePart[] = []

  await command({ command: "goal", sessionID: "s1", arguments: "build the thing" }, { parts })
  await command({ command: "goal", sessionID: "s1", arguments: "status usageLimited" }, { parts })

  assert.match(text(parts), /Provider usage waits are tracked automatically/)
  const goals = await readGoals(stateFilePath)
  assert.equal(goals[0]?.status, "active")
})

test("/goal strips one wrapper quote pair from non-interactive command args", async () => {
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath: await tempState() })
  const command = hooks["command.execute.before"]
  if (!command) throw new Error("missing command hook")
  const parts: MessagePart[] = []

  await command({ command: "goal", sessionID: "s1", arguments: '"quoted objective"' }, { parts })
  assert.match(text(parts), /New active goal: quoted objective/)
})

test("/goal --check creates checklist checks", async () => {
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath: await tempState() })
  const command = hooks["command.execute.before"]
  if (!command) throw new Error("missing command hook")
  const parts: MessagePart[] = []

  await command(
    { command: "goal", sessionID: "s1", arguments: '--check "tests pass" --checks "docs updated; manual smoke passes" ship it' },
    { parts },
  )

  const statusParts: MessagePart[] = []
  await command({ command: "goal", sessionID: "s1", arguments: "status" }, { parts: statusParts })
  assert.match(text(parts), /Checklist mode enabled/)
  assert.match(text(statusParts), /Mode: checklist/)
  assert.match(text(statusParts), /C1 \[pending\] tests pass/)
  assert.match(text(statusParts), /C2 \[pending\] docs updated/)
  assert.match(text(statusParts), /C3 \[pending\] manual smoke passes/)
})

test("/goal --check works when opencode run wraps command args in quotes", async () => {
  const stateFilePath = await tempState()
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath })
  const command = hooks["command.execute.before"]
  if (!command) throw new Error("missing command hook")
  const parts: MessagePart[] = []

  await command(
    { command: "goal", sessionID: "s1", arguments: '"--check \'smoke passes\' ship it"' },
    { parts },
  )

  const goals = await readGoals(stateFilePath)
  assert.equal(goals[0]?.objective, "ship it")
  assert.equal(goals[0]?.mode, "checklist")
  assert.equal(goals[0]?.checks[0]?.text, "smoke passes")
})

test("/goal canonical policy flags persist resolved limits and bounded constraints", async () => {
  const stateFilePath = await tempState()
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath })
  const command = hooks["command.execute.before"]
  if (!command) throw new Error("missing command hook")
  const parts: MessagePart[] = []

  await command({
    command: "goal",
    sessionID: "policy",
    arguments: 'ship safely --constraint "do not change the public API" --max-tokens 12000 --max-minutes 1.5 --constraint "--literal boundary" --max-turns 6',
  }, { parts })
  assert.match(text(parts), /New active goal: ship safely/)
  assert.match(text(parts), /Policy overrides: max turns 6, max minutes 1.5, max tokens 12000/)
  assert.match(text(parts), /Constraints:\n- do not change the public API\n- --literal boundary/)
  let goals = await readGoals(stateFilePath)
  assert.deepEqual(goals[0]?.policy, {
    maxTurns: 6,
    maxDurationSeconds: 90,
    tokenBudget: 12000,
    constraints: ["do not change the public API", "--literal boundary"],
  })

  await command({ command: "goal", sessionID: "policy", arguments: "status" }, { parts })
  assert.match(text(parts), /Policy overrides: max turns 6, max minutes 1.5, max tokens 12000/)

  await command({ command: "goal", sessionID: "plain", arguments: "ordinary objective" }, { parts })
  assert.doesNotMatch(text(parts), /Policy overrides|Constraints:/)
  goals = await readGoals(stateFilePath)
  assert.deepEqual(goals.find((goal) => goal.objective === "ordinary objective")?.policy, {
    maxTurns: 0,
    maxDurationSeconds: 0,
    tokenBudget: null,
    constraints: [],
  })

  await command({ command: "goal", sessionID: "literal", arguments: "-- --max-turns 2 is objective text" }, { parts })
  assert.match(text(parts), /New active goal: --max-turns 2 is objective text/)
})

test("plain /goal creation snapshots configured policy defaults without extra feedback", async () => {
  const stateFilePath = await tempState()
  const hooks = await OpenCodeGoalPlugin({}, {
    stateFilePath,
    maxTurns: 7,
    maxDurationSeconds: 1_200,
    tokenBudget: 5_000,
  })
  const command = hooks["command.execute.before"]
  if (!command) throw new Error("missing command hook")
  const parts: MessagePart[] = []
  await command({ command: "goal", sessionID: "defaults", arguments: "plain configured goal" }, { parts })
  assert.doesNotMatch(text(parts), /Policy overrides|Constraints:/)
  assert.deepEqual((await readGoals(stateFilePath))[0]?.policy, {
    maxTurns: 7,
    maxDurationSeconds: 1_200,
    tokenBudget: 5_000,
    constraints: [],
  })
})

test("/goal policy flags reject missing, duplicate, malformed, and oversized values", async () => {
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath: await tempState() })
  const command = hooks["command.execute.before"]
  if (!command) throw new Error("missing command hook")
  const parts: MessagePart[] = []
  const cases = [
    { args: "--max-turns", expected: /Missing value for --max-turns/ },
    { args: "--max-minutes", expected: /Missing value for --max-minutes/ },
    { args: "--max-tokens", expected: /Missing value for --max-tokens/ },
    { args: "--max-turns objective", expected: /--max-turns requires a positive integer/ },
    { args: "--max-turns 0 objective", expected: /positive safe integer/ },
    { args: "--max-turns 2 --max-turns 3 objective", expected: /Duplicate flag: --max-turns/ },
    { args: "--max-tokens 1.5 objective", expected: /positive integer/ },
    { args: "--max-minutes 1.25 objective", expected: /at most one decimal place/ },
    { args: "--constraint --max-turns 2 objective", expected: /Missing value for --constraint/ },
    {
      args: `${Array.from({ length: 21 }, (_, index) => `--constraint "constraint ${index}"`).join(" ")} objective`,
      expected: /Too many constraints \(21\/20\)/,
    },
    { args: `--constraint "${"x".repeat(1001)}" objective`, expected: /Constraint is too long/ },
    {
      args: `${Array.from({ length: 9 }, () => `--constraint "${"x".repeat(1_000)}"`).join(" ")} objective`,
      expected: /Constraint text is too long in aggregate/,
    },
  ]
  for (const [index, item] of cases.entries()) {
    await command({ command: "goal", sessionID: `invalid-${index}`, arguments: item.args }, { parts })
    assert.match(text(parts), item.expected)
  }
})

test("/goal rejects unsupported flags instead of preserving old command shapes", async () => {
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath: await tempState() })
  const command = hooks["command.execute.before"]
  if (!command) throw new Error("missing command hook")
  const parts: MessagePart[] = []

  await command({ command: "goal", sessionID: "s1", arguments: "--strict ship it" }, { parts })
  assert.match(text(parts), /Unknown flag: --strict/)
})

test("/goal preserves apostrophes and punctuation-like hyphen tokens in objectives", async () => {
  const stateFilePath = await tempState()
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath })
  const command = hooks["command.execute.before"]
  if (!command) throw new Error("missing command hook")
  const parts: MessagePart[] = []

  await command({
    command: "goal",
    sessionID: "s1",
    arguments: "make users' prompts -> don't fail, even with commas...",
  }, { parts })

  assert.match(text(parts), /New active goal: make users' prompts -> don't fail, even with commas\.\.\./)
  const goals = await readGoals(stateFilePath)
  assert.equal(goals[0]?.objective, "make users' prompts -> don't fail, even with commas...")

  await command({
    command: "goal",
    sessionID: "s2",
    arguments: "--check -> trace input -> output",
  }, { parts })
  const updatedGoals = await readGoals(stateFilePath)
  const punctuationGoal = updatedGoals.find((goal) => goal.objective === "trace input -> output")
  assert.equal(punctuationGoal?.checks[0]?.text, "->")
})

test("/goal rejects objectives longer than the configured durable cap", async () => {
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath: await tempState(), maxObjectiveLength: 12 })
  const command = hooks["command.execute.before"]
  if (!command) throw new Error("missing command hook")
  const parts: MessagePart[] = []

  await command({ command: "goal", sessionID: "s1", arguments: "ship this carefully" }, { parts })

  assert.match(text(parts), /Objective is too long \(19\/12 characters\)/)
  assert.match(text(parts), /Put long details in a file/)
})

test("/goal reports missing check values and supports -- for literal objectives", async () => {
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath: await tempState() })
  const command = hooks["command.execute.before"]
  if (!command) throw new Error("missing command hook")
  const parts: MessagePart[] = []

  await command({ command: "goal", sessionID: "s1", arguments: "--check -- ship it" }, { parts })
  assert.match(text(parts), /Missing value for --check/)

  await command({ command: "goal", sessionID: "s2", arguments: "-- fix - broken tests" }, { parts })
  assert.match(text(parts), /New active goal: fix - broken tests/)
})

test("/goal handles quoted flag-like text and reports unclosed quotes", async () => {
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath: await tempState() })
  const command = hooks["command.execute.before"]
  if (!command) throw new Error("missing command hook")
  const parts: MessagePart[] = []

  await command({ command: "goal", sessionID: "s1", arguments: '--check "- no regressions" ship it' }, { parts })
  assert.match(text(parts), /New active goal: ship it/)
  assert.match(text(parts), /Checklist mode enabled/)

  await command({ command: "goal", sessionID: "s1", arguments: "checks" }, { parts })
  assert.match(text(parts), /C1 \[pending\] - no regressions/)

  await command({ command: "goal", sessionID: "s2", arguments: '"unfinished objective' }, { parts })
  assert.match(text(parts), /Unclosed " quote/)

  await command({ command: "goal", sessionID: "s1", arguments: 'done C1 "unfinished evidence' }, { parts })
  assert.match(text(parts), /Unclosed " quote/)
})

test("/goal help is explicit and ordinary help objectives still create goals", async () => {
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath: await tempState() })
  const command = hooks["command.execute.before"]
  if (!command) throw new Error("missing command hook")
  const parts: MessagePart[] = []

  await command({ command: "goal", sessionID: "s1", arguments: "help" }, { parts })
  assert.match(text(parts), /Examples:/)
  assert.match(text(parts), /--check "tests pass"/)

  await command({ command: "goal", sessionID: "s2", arguments: "help improve onboarding" }, { parts })
  assert.match(text(parts), /New active goal: help improve onboarding/)
})

test("/goal add, done, and mode checklist commands are user-facing", async () => {
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath: await tempState() })
  const command = hooks["command.execute.before"]
  if (!command) throw new Error("missing command hook")
  const parts: MessagePart[] = []

  await command({ command: "goal", sessionID: "s1", arguments: "ship it" }, { parts })
  await command({ command: "goal", sessionID: "s1", arguments: 'add "manual smoke passes"' }, { parts })
  assert.match(text(parts), /Mode: checklist/)
  assert.match(text(parts), /C1 \[pending\] manual smoke passes/)

  await command({ command: "goal", sessionID: "s1", arguments: 'done C1 "smoke passed"' }, { parts })
  assert.match(text(parts), /C1 \[satisfied\] manual smoke passes - smoke passed/)

  await command({ command: "goal", sessionID: "s1", arguments: "mode standard" }, { parts })
  assert.match(text(parts), /Mode: standard/)
})

test("system and compaction hooks inject active goal state", async () => {
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath: await tempState() })
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: "finish docs" }, { parts })

  const system = { system: ["base system"] }
  await hooks["experimental.chat.system.transform"]?.({ sessionID: "s1" }, system)
  assert.match(system.system[0] ?? "", /<goal_data>/)
  assert.match(system.system[0] ?? "", /finish docs/)

  const compacting = { context: [] as string[] }
  await hooks["experimental.session.compacting"]?.({ sessionID: "s1" }, compacting)
  assert.match(compacting.context[0] ?? "", /Active Goal/)

  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: "pause" }, { parts })
  const paused = { context: [] as string[] }
  await hooks["experimental.session.compacting"]?.({ sessionID: "s1" }, paused)
  assert.match(paused.context[0] ?? "", /Paused Goal/)
  assert.doesNotMatch(paused.context[0] ?? "", /Continue working/)

  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: "resume" }, { parts })
  await hooks.event?.({
    event: {
      type: "message.updated",
      properties: {
        message: {
          info: { id: "terminal", role: "assistant", sessionID: "s1" },
          parts: [{ type: "text", text: "Done\n[goal:evidence] verified\n[goal:complete]" }],
        },
      },
    },
  })
  const terminal = { context: [] as string[] }
  await hooks["experimental.session.compacting"]?.({ sessionID: "s1" }, terminal)
  assert.deepEqual(terminal.context, [])
})

test("checklist mode rejects completion until checks are satisfied", async () => {
  const stateFilePath = await tempState()
  const assistant: SessionMessage = {
    info: { id: "m1", role: "assistant", sessionID: "s1", tokens: { input: 10, output: 20 } },
    parts: [{ type: "text", text: "Done\n[goal:evidence] I think it is done\n[goal:complete]" }],
  }
  let prompt = ""
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [assistant] }),
      promptAsync: async (input) => {
        prompt = input.body.parts[0]?.text ?? ""
        return {}
      },
    },
  }
  const hooks = await OpenCodeGoalPlugin({ client }, { stateFilePath, idleSettleMs: 0, minDelayMs: 0 })
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: '--check "tests pass" ship it' }, { parts })
  await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } })

  const goals = await readGoals(stateFilePath)
  assert.equal(goals[0]?.status, "active")
  assert.match(goals[0]?.evaluatorFeedback ?? "", /required checks still need evidence/)
  assert.match(prompt, /Consult evaluator_feedback in goal_data/)
})

test("duplicate rejected assistant messages are not counted repeatedly", async () => {
  const stateFilePath = await tempState()
  const assistantText = `${"progress ".repeat(300)}\n[goal:evidence] claimed done\n[goal:complete]`
  const message: SessionMessage = {
    info: { id: "m1", role: "assistant", sessionID: "s1", tokens: { input: 10, output: 20 } },
    parts: [{ type: "text", text: assistantText }],
  }
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath, autoContinue: false })
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: '--check "tests pass" ship it' }, { parts })

  await hooks.event?.({ event: { type: "message.updated", properties: { message } } })
  await hooks.event?.({ event: { type: "message.updated", properties: { message } } })

  const goals = await readGoals(stateFilePath)
  assert.equal(goals[0]?.status, "active")
  assert.equal(goals[0]?.completionRejectedCount, 1)
  assert.equal(goals[0]?.lastAssistantTextLength, assistantText.length)
})

test("recorded check evidence re-evaluates the latest rejected completion", async () => {
  const stateFilePath = await tempState()
  const assistant: SessionMessage = {
    info: { id: "m1", role: "assistant", sessionID: "s1", tokens: { input: 10, output: 20 } },
    parts: [{ type: "text", text: "Done\n[goal:evidence] claimed done\n[goal:complete]" }],
  }
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [assistant] }),
      promptAsync: async () => ({}),
    },
  }
  const hooks = await OpenCodeGoalPlugin({ client }, { stateFilePath, idleSettleMs: 0, minDelayMs: 0 })
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: '--check "tests pass" ship it' }, { parts })
  await hooks.event?.({ event: { type: "message.updated", properties: { message: assistant } } })

  let goals = await readGoals(stateFilePath)
  assert.equal(goals[0]?.status, "active")
  assert.equal(goals[0]?.completionRejectedCount, 1)

  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: 'done C1 "bun test passed"' }, { parts })
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: "status" }, { parts })

  goals = await readGoals(stateFilePath)
  assert.equal(goals[0]?.status, "complete")
  assert.equal(goals[0]?.checks[0]?.status, "satisfied")
  assert.equal(goals[0]?.completionRejectedCount, 1)
})

test("checklist mode accepts completion after check evidence is recorded", async () => {
  const stateFilePath = await tempState()
  const assistant: SessionMessage = {
    info: { id: "m1", role: "assistant", sessionID: "s1", tokens: { input: 10, output: 20 } },
    parts: [{ type: "text", text: "Done\n[goal:evidence] bun test passed\n[goal:complete]" }],
  }
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [assistant] }),
      promptAsync: async () => ({}),
    },
  }
  const hooks = await OpenCodeGoalPlugin({ client }, { stateFilePath, idleSettleMs: 0, minDelayMs: 0 })
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: '--check "tests pass" ship it' }, { parts })
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: 'done C1 "bun test passed"' }, { parts })
  await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } })

  const goals = await readGoals(stateFilePath)
  assert.equal(goals[0]?.status, "complete")
  assert.equal(goals[0]?.checks[0]?.status, "satisfied")
  assert.equal(goals[0]?.lastEvidence, "bun test passed")
})

test("evidence marker can satisfy named checks directly", async () => {
  const stateFilePath = await tempState()
  const assistant: SessionMessage = {
    info: { id: "m1", role: "assistant", sessionID: "s1", tokens: { input: 10, output: 20 } },
    parts: [{ type: "text", text: "Done\n[goal:evidence] C1: bun test passed\n[goal:complete]" }],
  }
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [assistant] }),
      promptAsync: async () => ({}),
    },
  }
  const hooks = await OpenCodeGoalPlugin({ client }, { stateFilePath, idleSettleMs: 0, minDelayMs: 0 })
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: '--check "tests pass" ship it' }, { parts })
  await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } })

  const goals = await readGoals(stateFilePath)
  assert.equal(goals[0]?.status, "complete")
  assert.equal(goals[0]?.checks[0]?.status, "satisfied")
  assert.equal(goals[0]?.checks[0]?.evidence, "C1: bun test passed")
})

test("idle event records completion with evidence", async () => {
  const stateFilePath = await tempState()
  const assistant: SessionMessage = {
    info: { id: "m1", role: "assistant", sessionID: "s1", tokens: { input: 10, output: 20 } },
    parts: [{ type: "text", text: "Done\n[goal:evidence] bun test passed\n[goal:complete]" }],
  }
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [assistant] }),
      promptAsync: async () => ({}),
    },
  }
  const hooks = await OpenCodeGoalPlugin({ client }, { stateFilePath, autoContinue: true })
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: "make tests pass" }, { parts })
  await hooks.event?.({ event: { type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } } })

  const state = JSON.parse(await readFile(stateFilePath, "utf8")) as { goals: Array<{ status: string; lastEvidence: string; tokensUsed: number }> }
  assert.equal(state.goals[0]?.status, "complete")
  assert.equal(state.goals[0]?.lastEvidence, "bun test passed")
  assert.equal(state.goals[0]?.tokensUsed, 30)
})

test("message update records completion with evidence without waiting for idle", async () => {
  const stateFilePath = await tempState()
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath, autoContinue: false })
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: "make tests pass" }, { parts })
  await hooks.event?.({
    event: {
      type: "message.updated",
      properties: {
        message: {
          info: { id: "m1", role: "assistant", sessionID: "s1", tokens: { input: 10, output: 20 } },
          parts: [{ type: "text", text: "Done\n[goal:evidence] bun test passed\n[goal:complete]" }],
        },
      },
    },
  })

  const state = JSON.parse(await readFile(stateFilePath, "utf8")) as { goals: Array<{ status: string; lastEvidence: string; tokensUsed: number }> }
  assert.equal(state.goals[0]?.status, "complete")
  assert.equal(state.goals[0]?.lastEvidence, "bun test passed")
  assert.equal(state.goals[0]?.tokensUsed, 30)
})

test("message updates after completion do not mutate terminal goals", async () => {
  const stateFilePath = await tempState()
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath, autoContinue: false })
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: "make tests pass" }, { parts })
  await hooks.event?.({
    event: {
      type: "message.updated",
      properties: {
        message: {
          info: { id: "m1", role: "assistant", sessionID: "s1", tokens: { input: 10, output: 20 } },
          parts: [{ type: "text", text: "Done\n[goal:evidence] bun test passed\n[goal:complete]" }],
        },
      },
    },
  })
  await hooks.event?.({
    event: {
      type: "message.updated",
      properties: {
        message: {
          info: { id: "m2", role: "assistant", sessionID: "s1", tokens: { input: 100, output: 200 } },
          parts: [{ type: "text", text: "Continuing the normal conversation after the goal is done." }],
        },
      },
    },
  })

  const state = JSON.parse(await readFile(stateFilePath, "utf8")) as { goals: Array<{ status: string; lastEvidence: string; tokensUsed: number }> }
  assert.equal(state.goals[0]?.status, "complete")
  assert.equal(state.goals[0]?.lastEvidence, "bun test passed")
  assert.equal(state.goals[0]?.tokensUsed, 30)
})

test("message update accepts OpenCode top-level message event shape", async () => {
  const stateFilePath = await tempState()
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath, autoContinue: false })
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: "make tests pass" }, { parts })
  await hooks.event?.({
    event: {
      type: "message.updated",
      properties: {
        info: { id: "m1", role: "assistant", sessionID: "s1", tokens: { input: 10, output: 20 } },
        parts: [{ type: "text", text: "Done\n[goal:evidence] bun test passed\n[goal:complete]" }],
      },
    },
  })
  const goals = await readGoals(stateFilePath)
  assert.equal(goals[0]?.status, "complete")
  assert.equal(goals[0]?.lastEvidence, "bun test passed")
  assert.equal(goals[0]?.tokensUsed, 30)
})

test("message update with info-only OpenCode event reconciles through session messages", async () => {
  const stateFilePath = await tempState()
  const assistant: SessionMessage = {
    info: { id: "m1", role: "assistant", sessionID: "s1", tokens: { input: 10, output: 20 } },
    parts: [{ type: "text", text: "Done\n[goal:evidence] bun test passed\n[goal:complete]" }],
  }
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [assistant] }),
    },
  }
  const hooks = await OpenCodeGoalPlugin({ client }, { stateFilePath, autoContinue: false })
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: "make tests pass" }, { parts })
  await hooks.event?.({
    event: {
      type: "message.updated",
      properties: {
        info: { id: "m1", role: "assistant", sessionID: "s1", tokens: { input: 10, output: 20 } },
      },
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 200))

  const goals = await readGoals(stateFilePath)
  assert.equal(goals[0]?.status, "complete")
  assert.equal(goals[0]?.lastEvidence, "bun test passed")
  assert.equal(goals[0]?.tokensUsed, 30)
})

test("part update events debounce session reconciliation", async () => {
  const stateFilePath = await tempState()
  let messageCalls = 0
  const assistant: SessionMessage = {
    info: { id: "m1", role: "assistant", sessionID: "s1", tokens: { input: 10, output: 20 } },
    parts: [{ type: "text", text: "Done\n[goal:evidence] bun test passed\n[goal:complete]" }],
  }
  const client: OpencodeClient = {
    session: {
      messages: async () => {
        messageCalls += 1
        return { data: [assistant] }
      },
    },
  }
  const hooks = await OpenCodeGoalPlugin({ client }, { stateFilePath, autoContinue: false })
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: "make tests pass" }, { parts })

  await hooks.event?.({ event: { type: "message.part.updated", properties: { part: { sessionID: "s1" } } } })
  await hooks.event?.({ event: { type: "message.part.updated", properties: { part: { sessionID: "s1" } } } })
  await hooks.event?.({ event: { type: "message.part.updated", properties: { part: { sessionID: "s1" } } } })
  await sleep(250)

  const goals = await readGoals(stateFilePath)
  assert.equal(messageCalls, 1)
  assert.equal(goals[0]?.status, "complete")
})

test("/goal status reconciles terminal markers from recent session messages", async () => {
  const stateFilePath = await tempState()
  const assistant: SessionMessage = {
    info: { id: "m1", role: "assistant", sessionID: "s1", tokens: { input: 10, output: 20 } },
    parts: [{ type: "text", text: "Done\n[goal:evidence] live smoke passed\n[goal:complete]" }],
  }
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [assistant] }),
    },
  }
  const hooks = await OpenCodeGoalPlugin({ client }, { stateFilePath, autoContinue: false })
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: "make tests pass" }, { parts })
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: "status" }, { parts })

  assert.match(text(parts), /Status: complete/)
  assert.match(text(parts), /Evidence: live smoke passed/)
})

test("idle event sends one continuation when goal remains active", async () => {
  let prompt = ""
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [] }),
      promptAsync: async (input) => {
        prompt = input.body.parts[0]?.text ?? ""
        return {}
      },
    },
  }
  const hooks = await OpenCodeGoalPlugin({ client }, { stateFilePath: await tempState(), maxTurns: 1 })
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: "continue carefully" }, { parts })
  await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
  assert.match(prompt, /<goal_continuation>/)
  assert.match(prompt, /continue carefully/)
})

test("auto-continue calls promptAsync with its SDK receiver intact", async () => {
  let receiverWasSession = false
  let prompt = ""
  const session = {
    messages: async () => ({ data: [] }),
    async promptAsync(input: { body: { parts: Array<{ text?: string }> } }) {
      receiverWasSession = this === session
      prompt = input.body.parts[0]?.text ?? ""
      return {}
    },
  }
  const hooks = await OpenCodeGoalPlugin({ client: { session } }, { stateFilePath: await tempState(), maxTurns: 1 })
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: "continue carefully" }, { parts })
  await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } })

  assert.equal(receiverWasSession, true)
  assert.match(prompt, /<goal_continuation>/)
})

test("auto-continue retries transient prompt failures before pausing", async () => {
  const stateFilePath = await tempState()
  let prompts = 0
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [] }),
      promptAsync: async () => {
        prompts += 1
        return { error: { name: "NetworkError", message: "temporary socket failure" } }
      },
    },
  }
  const hooks = await OpenCodeGoalPlugin(
    { client },
    { stateFilePath, idleSettleMs: 0, minDelayMs: 0, maxPromptFailures: 2 },
  )
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: "keep going after limits reset" }, { parts })

  await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
  let goals = await readGoals(stateFilePath)
  assert.equal(goals[0]?.status, "active")
  assert.equal(goals[0]?.promptFailureCount, 1)

  await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
  goals = await readGoals(stateFilePath)
  assert.equal(prompts, 2)
  assert.equal(goals[0]?.status, "paused")
  assert.equal(goals[0]?.continuationCount, 0)
  assert.equal(goals[0]?.promptFailureCount, 2)
})

test("auto-continue waits on provider usage windows without pausing or retrying immediately", async () => {
  const stateFilePath = await tempState()
  let prompts = 0
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [] }),
      promptAsync: async () => {
        prompts += 1
        return { error: { name: "UsageLimitError", message: "Usage limit reached. Try again in 5 hours." } }
      },
    },
  }
  const hooks = await OpenCodeGoalPlugin(
    { client },
    { stateFilePath, idleSettleMs: 0, minDelayMs: 0, maxPromptFailures: 1, usageLimitWaitSeconds: 60 },
  )
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: "keep going after usage resets" }, { parts })

  await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
  let goals = await readGoals(stateFilePath)
  assert.equal(prompts, 1)
  assert.equal(goals[0]?.status, "active")
  assert.equal(goals[0]?.promptFailureCount, 0)
  assert.match(goals[0]?.usageLimitedReason ?? "", /Usage limit reached/)
  assert.ok((goals[0]?.usageLimitedUntil ?? 0) > Math.floor(Date.now() / 1000))

  await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
  goals = await readGoals(stateFilePath)
  assert.equal(prompts, 1)
  assert.equal(goals[0]?.status, "active")
})

test("session.error usage limits put the active goal into provider-wait state", async () => {
  const stateFilePath = await tempState()
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath, usageLimitWaitSeconds: 300 })
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: "continue later" }, { parts })

  await hooks.event?.({
    event: {
      type: "session.error",
      properties: {
        sessionID: "s1",
        error: { name: "RateLimitError", message: "429 rate limit exceeded" },
      },
    },
  })

  const goals = await readGoals(stateFilePath)
  assert.equal(goals[0]?.status, "active")
  assert.equal(goals[0]?.promptFailureCount, 0)
  assert.match(goals[0]?.usageLimitedReason ?? "", /429 rate limit exceeded/)
  assert.ok((goals[0]?.usageLimitedUntil ?? 0) > Math.floor(Date.now() / 1000))
})

test("session.error handles SDK-shaped OpenAI 429 errors and reset headers", async () => {
  const stateFilePath = await tempState()
  const hooks = await OpenCodeGoalPlugin({}, { stateFilePath, usageLimitWaitSeconds: 300 })
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: "continue later" }, { parts })

  await hooks.event?.({
    event: {
      type: "session.error",
      properties: {
        sessionID: "s1",
        error: {
          name: "APIError",
          data: {
            message: "Rate limit reached for requests",
            statusCode: 429,
            responseHeaders: {
              "x-ratelimit-reset-requests": "2s",
            },
          },
        },
      },
    },
  })

  const goals = await readGoals(stateFilePath)
  assert.equal(goals[0]?.status, "active")
  assert.equal(goals[0]?.promptFailureCount, 0)
  assert.match(goals[0]?.usageLimitedReason ?? "", /Rate limit reached/)
  assert.ok((goals[0]?.usageLimitedUntil ?? 0) <= Math.floor(Date.now() / 1000) + 5)
})

test("auto-continue pauses when a real user message arrives after plugin continuation", async () => {
  const stateFilePath = await tempState()
  let prompt = ""
  let messageCalls = 0
  const client: OpencodeClient = {
    session: {
      messages: async () => {
        messageCalls += 1
        if (messageCalls === 1) return { data: [] }
        return {
          data: [
            { info: { id: "u1", role: "user", sessionID: "s1" }, parts: [{ type: "text", text: prompt }] },
            { info: { id: "a1", role: "assistant", sessionID: "s1" }, parts: [{ type: "text", text: "Working." }] },
            { info: { id: "u2", role: "user", sessionID: "s1" }, parts: [{ type: "text", text: "Pause this and answer me." }] },
          ],
        }
      },
      promptAsync: async (input) => {
        prompt = input.body.parts[0]?.text ?? ""
        return {}
      },
    },
  }
  const hooks = await OpenCodeGoalPlugin({ client }, { stateFilePath, idleSettleMs: 0, minDelayMs: 0 })
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: "finish the task" }, { parts })

  await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
  await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } })

  const goals = await readGoals(stateFilePath)
  assert.match(prompt, /<goal_continuation>/)
  assert.equal(goals[0]?.status, "paused")
  assert.equal(goals[0]?.continuationCount, 1)
})

test("auto-continue sends a natural wrap-up prompt near token budget", async () => {
  const stateFilePath = await tempState()
  let prompt = ""
  const assistant: SessionMessage = {
    info: { id: "a1", role: "assistant", sessionID: "s1", tokens: { input: 10, output: 76 } },
    parts: [{ type: "text", text: "Progress checkpoint with enough detail to avoid low-progress handling." }],
  }
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [assistant] }),
      promptAsync: async (input) => {
        prompt = input.body.parts[0]?.text ?? ""
        return {}
      },
    },
  }
  const hooks = await OpenCodeGoalPlugin(
    { client },
    { stateFilePath, idleSettleMs: 0, minDelayMs: 0, tokenBudget: 100, budgetWrapupRatio: 0.85 },
  )
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: "ship the migration" }, { parts })

  await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } })

  const goals = await readGoals(stateFilePath)
  assert.match(prompt, /concise handoff/)
  assert.equal(goals[0]?.status, "active")
  assert.equal(goals[0]?.budgetWrapupSent, true)
})

test("auto-continue pauses after repeated low-progress assistant turns", async () => {
  const stateFilePath = await tempState()
  let prompts = 0
  let messageCalls = 0
  const client: OpencodeClient = {
    session: {
      messages: async () => {
        messageCalls += 1
        if (messageCalls === 1) return { data: [] }
        return {
          data: [
            {
              info: { id: `a${messageCalls}`, role: "assistant", sessionID: "s1", tokens: { output: 1 } },
              parts: [{ type: "text", text: "ok" }],
            },
          ],
        }
      },
      promptAsync: async () => {
        prompts += 1
        return {}
      },
    },
  }
  const hooks = await OpenCodeGoalPlugin(
    { client },
    { stateFilePath, idleSettleMs: 0, minDelayMs: 0, noProgressTurnsBeforePause: 2 },
  )
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: "finish implementation" }, { parts })

  await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
  await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
  await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } })

  const goals = await readGoals(stateFilePath)
  assert.equal(prompts, 2)
  assert.equal(goals[0]?.status, "paused")
  assert.equal(goals[0]?.noProgressTurns, 2)
})

test("idle event pauses instead of counting a continuation when prompt client is unavailable", async () => {
  const stateFilePath = await tempState()
  const hooks = await OpenCodeGoalPlugin(
    { client: { session: { messages: async () => ({ data: [] }) } } },
    { stateFilePath },
  )
  const parts: MessagePart[] = []
  await hooks["command.execute.before"]?.({ command: "goal", sessionID: "s1", arguments: "continue carefully" }, { parts })
  await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } })

  const state = JSON.parse(await readFile(stateFilePath, "utf8")) as { goals: Array<{ status: string; continuationCount: number }> }
  assert.equal(state.goals[0]?.status, "paused")
  assert.equal(state.goals[0]?.continuationCount, 0)
})
