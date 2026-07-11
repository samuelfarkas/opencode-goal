import { addGoalCheck, createThreadGoal, pauseGoal, resumeGoal, satisfyGoalCheck, setGoalMode, setGoalStatus } from "./goal-operations.ts"
import { validateCheckAddition, validateCheckEvidence, validateConstraints, validateInitialChecks } from "./goal-contract.ts"
import { goalPolicyDefaults } from "./options.ts"
import { validateObjective } from "./objective.ts"
import { textPart } from "./parts.ts"
import { GoalStore } from "./store.ts"
import { USER_SETTABLE_GOAL_STATUSES, isUserSettableGoalStatus } from "./types.ts"
import type { GoalArchiveEntry, GoalMode, MessagePart, StoredGoal, UserSettableGoalStatus } from "./types.ts"
import type { ResolvedOptions } from "./options.ts"

const USER_SETTABLE_STATUS_LIST = USER_SETTABLE_GOAL_STATUSES.join(", ")
const HELP_WORDS = new Set(["help", "--help", "-h"])
const CHECK_FLAGS = new Set(["--check", "--checks", "-c"])

type GoalSpec =
  | {
      ok: true
      objective: string
      mode: GoalMode
      checks: string[]
      constraints: string[]
      maxTurns: number | undefined
      maxDurationSeconds: number | undefined
      tokenBudget: number | undefined
    }
  | { ok: false; error: string }

type Token = {
  value: string
  quoted: boolean
}

type Tokenized =
  | { ok: true; tokens: Token[] }
  | { ok: false; error: string }

type DoneCommand =
  | { ok: true; checkId: string; evidence: string }
  | { ok: false; error: string }
  | undefined

function policySummary(goal: StoredGoal, options: ResolvedOptions): string[] {
  const overrides: string[] = []
  if (goal.policy.maxTurns !== options.maxTurns) overrides.push(`max turns ${goal.policy.maxTurns}`)
  if (goal.policy.maxDurationSeconds !== options.maxDurationSeconds) {
    overrides.push(`max minutes ${goal.policy.maxDurationSeconds / 60}`)
  }
  if (goal.policy.tokenBudget !== options.tokenBudget) {
    overrides.push(`max tokens ${goal.policy.tokenBudget === null ? "none" : goal.policy.tokenBudget}`)
  }
  return [
    overrides.length > 0 ? `Policy overrides: ${overrides.join(", ")}` : "",
    goal.policy.constraints.length > 0
      ? ["Constraints:", ...goal.policy.constraints.map((constraint) => `- ${constraint}`)].join("\n")
      : "",
  ].filter(Boolean)
}

function summarize(goal: StoredGoal, options: ResolvedOptions): string {
  const checks = goal.checks.map((check) => {
    const suffix = check.evidence ? ` - ${check.evidence}` : ""
    return `- ${check.id} [${check.status}] ${check.text}${suffix}`
  })
  const waitingUntil = goal.usageLimitedUntil > 0 ? new Date(goal.usageLimitedUntil * 1000).toISOString() : ""
  return [
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Mode: ${goal.mode}`,
    `Tokens: ${goal.tokensUsed}${goal.policy.tokenBudget === null ? "" : ` / ${goal.policy.tokenBudget}`}`,
    `Elapsed: ${goal.timeUsedSeconds}s`,
    ...policySummary(goal, options),
    waitingUntil ? `Waiting until: ${waitingUntil}` : "",
    goal.usageLimitedReason ? `Waiting reason: ${goal.usageLimitedReason}` : "",
    goal.evaluatorFeedback ? `Evaluator feedback: ${goal.evaluatorFeedback}` : "",
    checks.length > 0 ? ["Checks:", ...checks].join("\n") : "",
    goal.lastEvidence ? `Evidence: ${goal.lastEvidence}` : "",
    goal.blockedReason ? `Blocked: ${goal.blockedReason}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function summarizeArchive(entry: GoalArchiveEntry): string {
  const result = entry.status === "complete"
    ? entry.lastEvidence
    : entry.status === "blocked"
      ? entry.blockedReason
      : ""
  return [
    `- ${new Date(entry.terminalAt * 1000).toISOString()} [${entry.status}] ${entry.objective}`,
    `  tokens=${entry.tokensUsed} time=${entry.timeUsedSeconds}s turns=${entry.continuationCount}`,
    result ? `  result: ${result}` : "",
    entry.checks.length > 0
      ? `  checks: ${entry.checks.map((check) => `${check.id}=${check.status}`).join(", ")}`
      : "",
  ].filter(Boolean).join("\n")
}

function parseStatus(raw: string): UserSettableGoalStatus | undefined {
  return isUserSettableGoalStatus(raw) ? raw : undefined
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function output(parts: MessagePart[], text: string): void {
  parts.splice(0, parts.length, textPart(text))
}

function helpText(commandName: string): string {
  return [
    `/${commandName} keeps one durable goal active for this OpenCode session.`,
    "",
    "Examples:",
    `/${commandName} implement checkout retries and verify tests pass`,
    `/${commandName} --check "tests pass" --check "manual smoke passes" ship the feature`,
    `/${commandName} --max-turns 6 --max-minutes 20 --max-tokens 12000 --constraint "do not change the public API" ship safely`,
    `/${commandName} add "docs mention the new behavior"`,
    `/${commandName} done C1 "bun run check passed"`,
    `/${commandName} status`,
    "",
    "Commands:",
    "status                 show the current goal",
    "history                show recent lifecycle events",
    "checks                 show checks and evidence",
    "add <check>            add a check and switch to checklist mode",
    "done C1 <evidence>     record evidence for a check",
    "mode standard|checklist switch completion style",
    "pause | resume | clear",
    "purge                  remove this session's current goal and archive from current files",
    "",
    "Flags when creating a goal:",
    "--check, --checks, -c  add explicit checks; repeatable",
    '--checks "A; B"        add multiple checks split by semicolon',
    "--max-turns <integer> set this goal's auto-continue limit once",
    "--max-minutes <number> set active minutes with at most one decimal place",
    "--max-tokens <integer> set this goal's token budget once",
    "--constraint <text>   add a task constraint; repeatable",
  ].join("\n")
}

function tokenize(value: string): Tokenized {
  const tokens: Token[] = []
  let current = ""
  let quote = ""
  let quoted = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? ""
    if (quote) {
      if (char === quote) {
        quote = ""
      } else {
        current += char
      }
      continue
    }
    // Quotes delimit a value only at a token boundary. Apostrophes and quote
    // characters inside ordinary words (for example, "don't" or "users'")
    // are objective text, not the start of a quoted value.
    if ((char === '"' || char === "'") && current.length === 0) {
      quote = char
      quoted = true
      continue
    }
    if (/\s/.test(char)) {
      if (current || quoted) tokens.push({ value: current, quoted })
      current = ""
      quoted = false
      continue
    }
    current += char
  }
  if (quote) return { ok: false, error: `Unclosed ${quote} quote` }
  if (current || quoted) tokens.push({ value: current, quoted })
  return { ok: true, tokens }
}

function splitChecks(value: string): string[] {
  return value
    .split(/[;\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function isOptionBoundary(token: Token): boolean {
  return !token.quoted && (token.value === "--" || /^--?[A-Za-z]/.test(token.value))
}

function positiveIntegerFlag(raw: string, flag: string): { ok: true; value: number } | { ok: false; error: string } {
  if (!/^\d+$/.test(raw)) return { ok: false, error: `${flag} requires a positive integer` }
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0
    ? { ok: true, value }
    : { ok: false, error: `${flag} requires a positive safe integer` }
}

function minutesFlag(raw: string): { ok: true; value: number } | { ok: false; error: string } {
  if (!/^\d+(?:\.\d)?$/.test(raw)) {
    return { ok: false, error: "--max-minutes requires a positive number with at most one decimal place" }
  }
  const seconds = Number(raw) * 60
  return Number.isSafeInteger(seconds) && seconds > 0
    ? { ok: true, value: seconds }
    : { ok: false, error: "--max-minutes is outside the supported range" }
}

function parseGoalSpec(args: string): GoalSpec {
  const result = tokenize(stripWrappingQuotes(args))
  if (!result.ok) return result
  const tokens = result.tokens
  const objective: string[] = []
  const checks: string[] = []
  const constraints: string[] = []
  let maxTurns: number | undefined
  let maxDurationSeconds: number | undefined
  let tokenBudget: number | undefined
  let parsingFlags = true
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) continue
    if (parsingFlags && !token.quoted && token.value === "--") {
      parsingFlags = false
      continue
    }
    if (parsingFlags && !token.quoted && CHECK_FLAGS.has(token.value)) {
      const check = tokens[index + 1]
      if (!check || isOptionBoundary(check)) {
        return { ok: false, error: `Missing value for ${token.value}` }
      }
      checks.push(...splitChecks(check.value))
      index += 1
      continue
    }
    if (parsingFlags && !token.quoted && token.value === "--constraint") {
      const constraint = tokens[index + 1]
      if (!constraint || isOptionBoundary(constraint)) {
        return { ok: false, error: "Missing value for --constraint" }
      }
      constraints.push(constraint.value)
      index += 1
      continue
    }
    if (parsingFlags && !token.quoted && ["--max-turns", "--max-minutes", "--max-tokens"].includes(token.value)) {
      const rawValue = tokens[index + 1]
      if (!rawValue || isOptionBoundary(rawValue)) {
        return { ok: false, error: `Missing value for ${token.value}` }
      }
      if (token.value === "--max-turns") {
        if (maxTurns !== undefined) return { ok: false, error: "Duplicate flag: --max-turns" }
        const parsed = positiveIntegerFlag(rawValue.value, token.value)
        if (!parsed.ok) return parsed
        maxTurns = parsed.value
      } else if (token.value === "--max-minutes") {
        if (maxDurationSeconds !== undefined) return { ok: false, error: "Duplicate flag: --max-minutes" }
        const parsed = minutesFlag(rawValue.value)
        if (!parsed.ok) return parsed
        maxDurationSeconds = parsed.value
      } else {
        if (tokenBudget !== undefined) return { ok: false, error: "Duplicate flag: --max-tokens" }
        const parsed = positiveIntegerFlag(rawValue.value, token.value)
        if (!parsed.ok) return parsed
        tokenBudget = parsed.value
      }
      index += 1
      continue
    }
    // Only option-shaped tokens are flags. Punctuation commonly used in an
    // objective, such as "->", a standalone dash, or negative numbers, is
    // literal text.
    if (parsingFlags && isOptionBoundary(token)) {
      return { ok: false, error: `Unknown flag: ${token.value}` }
    }
    objective.push(token.value)
  }
  return {
    ok: true,
    objective: stripWrappingQuotes(objective.join(" ").trim()),
    mode: checks.length > 0 ? "checklist" : "standard",
    checks,
    constraints,
    maxTurns,
    maxDurationSeconds,
    tokenBudget,
  }
}

function doneCommand(args: string): DoneCommand {
  if (args !== "done" && !args.startsWith("done ")) return undefined
  const result = tokenize(args.slice("done".length).trim())
  if (!result.ok) return result
  const [check, ...evidenceParts] = result.tokens
  return { ok: true, checkId: check?.value ?? "", evidence: evidenceParts.map((token) => token.value).join(" ").trim() }
}

export async function handleGoalCommand(input: {
  sessionID: string
  arguments: string
  outputParts: MessagePart[]
  store: GoalStore
  options: ResolvedOptions
}): Promise<void> {
  const args = stripWrappingQuotes(input.arguments.trim())
  const existing = input.store.read(input.sessionID)

  if (HELP_WORDS.has(args)) {
    output(input.outputParts, helpText(input.options.commandName))
    return
  }

  if (!args || args === "status") {
    output(input.outputParts, existing ? summarize(existing.goal, input.options) : `No active goal. Set one with /${input.options.commandName} <objective>.`)
    return
  }

  if (args === "history") {
    const archived = input.store.archive(input.sessionID)
    const currentHistory = existing
      ? [`Current goal history: ${existing.goal.objective}`, ...existing.goal.history.map((entry) => `- ${entry.type}: ${entry.detail}`)].join("\n")
      : ""
    output(
      input.outputParts,
      [
        currentHistory,
        archived.length > 0 ? ["Recent archived results:", ...archived.map(summarizeArchive)].join("\n") : "",
      ].filter(Boolean).join("\n\n") || "No goal history.",
    )
    return
  }

  if (args === "checks") {
    output(input.outputParts, existing ? summarize(existing.goal, input.options) : "No active goal.")
    return
  }

  if (args.startsWith("add ")) {
    if (!existing) {
      output(input.outputParts, "No active goal to update.")
      return
    }
    const text = stripWrappingQuotes(args.slice("add ".length).trim())
    const validation = validateCheckAddition(existing.goal, text)
    if (!validation.ok) {
      output(input.outputParts, `${validation.error} Example: /${input.options.commandName} add "tests pass"`)
      return
    }
    const updated = await input.store.update(input.sessionID, existing.revision, (draft) => {
      addGoalCheck(draft, validation.value)
      return { commit: true, value: undefined }
    })
    output(input.outputParts, updated.applied ? summarize(updated.snapshot.goal, input.options) : "Goal changed before the update; retry the command.")
    return
  }

  const done = doneCommand(args)
  if (done) {
    if (!done.ok) {
      output(input.outputParts, `${done.error}. Use /${input.options.commandName} done <check-id> <concrete evidence>.`)
      return
    }
    if (!existing) {
      output(input.outputParts, "No active goal to update.")
      return
    }
    if (!done.checkId || !done.evidence) {
      output(input.outputParts, `Use /${input.options.commandName} done <check-id> <concrete evidence>.`)
      return
    }
    const evidence = validateCheckEvidence(existing.goal, done.checkId, done.evidence)
    if (!evidence.ok) {
      output(input.outputParts, evidence.error)
      return
    }
    const updated = await input.store.update(input.sessionID, existing.revision, (draft) => {
      const check = satisfyGoalCheck(draft, done.checkId, evidence.value)
      return { commit: Boolean(check), value: Boolean(check) }
    })
    if (!updated.applied && updated.reason === "unchanged") {
      output(input.outputParts, `Unknown check: ${done.checkId}`)
      return
    }
    output(input.outputParts, updated.applied ? summarize(updated.snapshot.goal, input.options) : "Goal changed before the update; retry the command.")
    return
  }

  if (args.startsWith("mode ")) {
    if (!existing) {
      output(input.outputParts, "No active goal to update.")
      return
    }
    const mode = args.slice("mode ".length).trim()
    if (mode !== "standard" && mode !== "checklist") {
      output(input.outputParts, "Unknown mode. Use standard or checklist.")
      return
    }
    const updated = await input.store.update(input.sessionID, existing.revision, (draft) => {
      setGoalMode(draft, mode)
      return { commit: true, value: undefined }
    })
    output(input.outputParts, updated.applied ? summarize(updated.snapshot.goal, input.options) : "Goal changed before the update; retry the command.")
    return
  }

  if (args === "clear") {
    const cleared = await input.store.clear(input.sessionID)
    output(input.outputParts, cleared ? "Goal cleared." : "No active goal to clear.")
    return
  }

  if (args === "purge") {
    const purged = await input.store.purge(input.sessionID)
    output(
      input.outputParts,
      purged.currentRemoved || purged.archiveRemoved > 0
        ? `Goal data purged from current files (${purged.archiveRemoved} archived result${purged.archiveRemoved === 1 ? "" : "s"}). This is logical deletion, not forensic secure erasure.`
        : "No current goal or archived results to purge.",
    )
    return
  }

  if (args === "pause") {
    if (!existing) {
      output(input.outputParts, "No active goal to pause.")
      return
    }
    const updated = await input.store.update(input.sessionID, existing.revision, (draft) => {
      pauseGoal(draft, "Goal paused by user command.")
      return { commit: true, value: undefined }
    })
    output(input.outputParts, updated.applied ? summarize(updated.snapshot.goal, input.options) : "Goal changed before the update; retry the command.")
    return
  }

  if (args === "resume") {
    if (!existing) {
      output(input.outputParts, "No active goal to resume.")
      return
    }
    const updated = await input.store.update(input.sessionID, existing.revision, (draft) => {
      resumeGoal(draft, "Goal resumed by user command.")
      return { commit: true, value: undefined }
    })
    output(input.outputParts, updated.applied ? summarize(updated.snapshot.goal, input.options) : "Goal changed before the update; retry the command.")
    return
  }

  if (args.startsWith("status ")) {
    if (!existing) {
      output(input.outputParts, "No active goal to update.")
      return
    }
    const status = parseStatus(args.slice("status ".length).trim())
    if (!status) {
      output(input.outputParts, `Unknown status. Use ${USER_SETTABLE_STATUS_LIST}. Provider usage waits are tracked automatically while the goal remains active.`)
      return
    }
    const updated = await input.store.update(input.sessionID, existing.revision, (draft) => {
      const result = setGoalStatus(draft, { status })
      return { commit: result.ok, value: result }
    })
    if (!updated.applied && updated.reason === "unchanged") {
      output(input.outputParts, updated.value.ok ? "Goal status was unchanged." : updated.value.error)
      return
    }
    output(input.outputParts, updated.applied ? summarize(updated.snapshot.goal, input.options) : "Goal changed before the update; retry the command.")
    return
  }

  const spec = parseGoalSpec(args)
  if (!spec.ok) {
    output(input.outputParts, `${spec.error}. Use /${input.options.commandName} help.`)
    return
  }
  if (!spec.objective) {
    output(input.outputParts, `No objective provided. Use /${input.options.commandName} <objective>, or /${input.options.commandName} help.`)
    return
  }
  const validation = validateObjective(spec.objective, input.options.maxObjectiveLength)
  if (!validation.ok) {
    output(input.outputParts, `${validation.error} Use /${input.options.commandName} help.`)
    return
  }
  const checks = validateInitialChecks(spec.checks)
  if (!checks.ok) {
    output(input.outputParts, `${checks.error} Use /${input.options.commandName} help.`)
    return
  }
  const constraints = validateConstraints(spec.constraints)
  if (!constraints.ok || !constraints.value) {
    output(input.outputParts, `${constraints.ok ? "Invalid constraints." : constraints.error} Use /${input.options.commandName} help.`)
    return
  }
  const policy = goalPolicyDefaults(input.options, constraints.value)
  if (spec.maxTurns !== undefined) policy.maxTurns = spec.maxTurns
  if (spec.maxDurationSeconds !== undefined) policy.maxDurationSeconds = spec.maxDurationSeconds
  if (spec.tokenBudget !== undefined) policy.tokenBudget = spec.tokenBudget
  const goal = createThreadGoal({
    threadId: input.sessionID,
    objective: validation.objective,
    tokenBudget: policy.tokenBudget,
    policy,
    mode: spec.mode,
    checks: checks.value,
  })
  const created = await input.store.replace(goal)
  output(
    input.outputParts,
    [
      `New active goal: ${created.goal.objective}`,
      created.goal.mode === "checklist" ? "Checklist mode enabled: completion waits for recorded check evidence." : "",
      ...policySummary(created.goal, input.options),
      "",
      "Start working toward this goal now.",
      `When satisfied, provide ${input.options.evidenceMarker} with concrete verification evidence, then end with ${input.options.completionMarker} on its own final line.`,
      `If blocked, state the blocker immediately before ${input.options.blockedMarker}.`,
    ].join("\n"),
  )
}
