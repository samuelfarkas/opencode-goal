import assert from "node:assert/strict"
import test from "node:test"
import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "@opencode-ai/plugin"
import { GoalStore } from "../src/store.ts"
import { GOAL_LIMITS, codePointLength } from "../src/goal-contract.ts"
import { buildTools } from "../src/tools.ts"
import { buildDoctorReport, formatDoctorReport } from "../src/doctor.ts"
import type { ToolDefinition } from "../src/types.ts"

const context: ToolContext = {
  sessionID: "s1",
  messageID: "m1",
  agent: "build",
  directory: "/tmp",
  worktree: "/tmp",
  abort: new AbortController().signal,
  metadata() {},
  async ask() {},
}

function requireTool(tools: Record<string, ToolDefinition>, name: string): ToolDefinition {
  const found = tools[name]
  if (!found) throw new Error(`missing tool: ${name}`)
  return found
}

async function executeText(definition: ToolDefinition, args: Record<string, unknown>): Promise<string> {
  const result = await definition.execute(args, context)
  return typeof result === "string" ? result : result.output
}

test("agent tools set, read, update, and clear a session goal", async () => {
  const store = new GoalStore("", false)
  const tools = buildTools(tool, store)

  assert.equal(tools.purge_goal, undefined)

  assert.match(await executeText(requireTool(tools, "set_goal"), { objective: "ship it" }), /New active goal/)
  assert.equal(store.read("s1")?.goal.policy.tokenBudget, null)
  assert.match(await executeText(requireTool(tools, "get_goal"), {}), /"objective": "ship it"/)
  assert.match(
    await executeText(requireTool(tools, "update_goal"), { status: "complete", evidence: "unit tests passed" }),
    /"status": "complete"/,
  )
  assert.equal(await executeText(requireTool(tools, "clear_goal"), {}), "Goal cleared.")
})

test("set_goal inherits configured policy defaults and ignores undeclared override fields", async () => {
  const store = new GoalStore("", false)
  const tools = buildTools(tool, store, { tokenBudget: 100, maxTurns: 4, maxDurationSeconds: 600 })

  await executeText(requireTool(tools, "set_goal"), {
    objective: "ship it",
    maxTurns: 1,
    maxDurationSeconds: 1,
    tokenBudget: 1,
  })

  assert.deepEqual(store.read("s1")?.goal.policy, {
    maxTurns: 4,
    maxDurationSeconds: 600,
    tokenBudget: 100,
    constraints: [],
  })
  assert.deepEqual(Object.keys(requireTool(tools, "set_goal").args), ["objective"])
})

test("agent tools require evidence for completion", async () => {
  const store = new GoalStore("", false)
  const tools = buildTools(tool, store)

  await executeText(requireTool(tools, "set_goal"), { objective: "ship it" })
  const before = store.read("s1")
  if (!before) throw new Error("missing goal")
  assert.equal(
    await executeText(requireTool(tools, "update_goal"), { status: "complete" }),
    "Completion requires evidence.",
  )
  const after = store.read("s1")
  assert.deepEqual(after?.revision, before.revision)
  assert.equal(after?.goal.lastEvidence, "")
  assert.equal(after?.goal.status, "active")
})

test("agent tools reject manual usageLimited status", async () => {
  const store = new GoalStore("", false)
  const tools = buildTools(tool, store)

  await executeText(requireTool(tools, "set_goal"), { objective: "ship it" })
  assert.equal(
    await executeText(requireTool(tools, "update_goal"), { status: "usageLimited" }),
    "A valid status is required.",
  )
  assert.match(await executeText(requireTool(tools, "get_goal"), {}), /"status": "active"/)
})

test("agent tools reject objectives beyond the configured cap", async () => {
  const store = new GoalStore("", false)
  const tools = buildTools(tool, store, { maxObjectiveLength: 8 })

  assert.match(
    await executeText(requireTool(tools, "set_goal"), { objective: "ship this now" }),
    /Objective is too long \(13\/8 characters\)/,
  )
  assert.equal(await executeText(requireTool(tools, "get_goal"), {}), "No active goal.")
})

test("agent tools manage check evidence before completion", async () => {
  const store = new GoalStore("", false)
  const tools = buildTools(tool, store)

  await executeText(requireTool(tools, "set_goal"), { objective: "ship it" })
  assert.match(
    await executeText(requireTool(tools, "add_goal_check"), { text: "unit tests pass" }),
    /"mode": "checklist"/,
  )
  assert.match(
    await executeText(requireTool(tools, "update_goal"), { status: "complete", evidence: "claimed done" }),
    /Completion rejected/,
  )
  const evidenceResult = await executeText(requireTool(tools, "record_goal_check_evidence"), { check_id: "C1", evidence: "bun test passed" })
  assert.match(evidenceResult, /"status": "satisfied"/)
  assert.match(evidenceResult, /call update_goal with status "complete"/)
  const completeResult = await executeText(requireTool(tools, "update_goal"), { status: "complete", evidence: "bun test passed" })
  assert.match(completeResult, /"status": "complete"/)
  assert.match(completeResult, /include \[goal:evidence\]/)
})

test("agent tools enforce the shared detail contract at runtime", async () => {
  const store = new GoalStore("", false)
  const tools = buildTools(tool, store)
  await executeText(requireTool(tools, "set_goal"), { objective: "ship it" })

  const exactCheck = "😀".repeat(GOAL_LIMITS.checkTextCodePoints)
  assert.match(
    await executeText(requireTool(tools, "add_goal_check"), { text: exactCheck }),
    /"id": "C1"/,
  )
  const beforeCheckRejection = store.read("s1")
  assert.match(
    await executeText(requireTool(tools, "add_goal_check"), { text: `${exactCheck}😀` }),
    /Check text is too long \(1001\/1000 characters\)/,
  )
  assert.deepEqual(store.read("s1")?.revision, beforeCheckRejection?.revision)

  const oversized = "e".repeat(GOAL_LIMITS.detailCodePoints + 1)
  const beforeEvidenceRejection = store.read("s1")
  assert.match(
    await executeText(requireTool(tools, "record_goal_check_evidence"), { check_id: "C1", evidence: oversized }),
    /Evidence is too long \(4001\/4000 characters\)/,
  )
  assert.deepEqual(store.read("s1")?.revision, beforeEvidenceRejection?.revision)
  assert.equal(store.read("s1")?.goal.checks[0]?.status, "pending")

  assert.match(
    await executeText(requireTool(tools, "update_goal"), { status: "complete", evidence: oversized }),
    /Evidence is too long \(4001\/4000 characters\)/,
  )
  assert.match(
    await executeText(requireTool(tools, "update_goal"), { status: "blocked", blocker: oversized }),
    /Blocker is too long \(4001\/4000 characters\)/,
  )
  assert.equal(store.read("s1")?.goal.status, "active")

  const projected = await executeText(requireTool(tools, "get_goal"), {})
  assert.ok(codePointLength(projected) <= GOAL_LIMITS.toolOutputCodePoints)
})

test("doctor report formats every status in stable order and separates readiness", () => {
  const report = buildDoctorReport({
    packageVersion: "0.2.4",
    supportedOpenCodeRange: ">=1.17.9 <2",
    openCodeVersion: "1.17.18",
    configurationStatus: "available",
    configurationReason: "config loaded",
    registerTools: false,
    toolFactoryAvailable: true,
    persistence: {
      enabled: false,
      path: "/tmp/unused.json",
      projectLocal: false,
      state: { status: "available", reason: "persistence disabled" },
      archive: { status: "available", reason: "persistence disabled" },
    },
    hooks: { system: true, compaction: true, autocontinue: true },
  })

  assert.equal(report.ready, true)
  assert.deepEqual(new Set(report.capabilities.map((item) => item.status)), new Set([
    "available",
    "unavailable",
    "registered-unverified",
    "unknown",
  ]))
  const formatted = formatDoctorReport({ ...report, capabilities: [...report.capabilities].reverse() })
  assert.match(formatted, /^OpenCode Goal Doctor: READY/)
  assert.ok(formatted.indexOf("Package contract") < formatted.indexOf("OpenCode binary"))
  assert.ok(formatted.indexOf("OpenCode binary") < formatted.indexOf("Transcript reads"))
  assert.match(formatted, /\[unavailable\] Agent tool factory: disabled by plugin configuration/)
  assert.match(formatted, /\[registered-unverified\] System prompt hook/)
  assert.match(formatted, /No model or provider was contacted/)

  const degraded = buildDoctorReport({
    openCodeError: "binary missing",
    configurationStatus: "unavailable",
    configurationReason: "invalid config",
    toolFactoryAvailable: false,
    hooks: { system: false, compaction: false, autocontinue: false },
  })
  assert.equal(degraded.ready, false)
  assert.match(formatDoctorReport(degraded), /^OpenCode Goal Doctor: DEGRADED/)

  const incompatible = buildDoctorReport({
    packageVersion: "0.2.4",
    supportedOpenCodeRange: ">=1.17.9 <2",
    openCodeVersion: "2.0.0",
    configurationStatus: "unknown",
    configurationReason: "not selected",
    toolFactoryAvailable: false,
    hooks: { system: true, compaction: true, autocontinue: true },
  })
  assert.equal(incompatible.ready, false)
  assert.match(formatDoctorReport(incompatible), /\[unavailable\] OpenCode binary: 2\.0\.0 is outside >=1\.17\.9 <2/)
  assert.match(formatDoctorReport(incompatible), /\[unavailable\] Agent tool factory/)

  const prerelease = buildDoctorReport({
    packageVersion: "0.2.4",
    supportedOpenCodeRange: ">=1.17.9 <2",
    openCodeVersion: "1.17.9-beta.1",
    configurationStatus: "unknown",
    configurationReason: "not selected",
    toolFactoryAvailable: true,
    hooks: { system: true, compaction: true, autocontinue: true },
  })
  assert.equal(prerelease.ready, false)
  assert.match(formatDoctorReport(prerelease), /1\.17\.9-beta\.1 is outside/)
})

test("doctor report bounds untrusted diagnostic reasons", () => {
  const report = buildDoctorReport({
    packageVersion: "0.2.4",
    supportedOpenCodeRange: ">=1.17.9 <2",
    openCodeError: "x".repeat(100_000),
    configurationStatus: "unknown",
    configurationReason: "y".repeat(100_000),
    toolFactoryAvailable: true,
    hooks: { system: true, compaction: true, autocontinue: true },
  })
  const output = formatDoctorReport(report)
  assert.ok(codePointLength(output) <= 24 * 1024)
  assert.doesNotMatch(output, /x{701}|y{701}/)
})
