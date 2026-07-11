import { isRecord } from "./records.ts"
import { defaultGoalPolicy, isThreadGoalStatus } from "./types.ts"
import type {
  AssistantTokenTotal,
  GoalCheck,
  GoalCheckStatus,
  GoalArchiveEntry,
  GoalArchiveStatus,
  GoalHistoryEntry,
  GoalMode,
  GoalPolicy,
  StoredGoal,
  ThreadGoalStatus,
} from "./types.ts"

export const GOAL_LIMITS = {
  objectiveCodePoints: 4_000,
  checks: 50,
  checkTextCodePoints: 1_000,
  detailCodePoints: 4_000,
  checklistAggregateCodePoints: 8_000,
  constraints: 20,
  constraintCodePoints: 1_000,
  constraintsAggregateCodePoints: 8_000,
  assistantCheckpointCodePoints: 2_000,
  historyEntries: 40,
  historyTypeCodePoints: 128,
  goalsPerSnapshot: 1_000,
  snapshotBytes: 8 * 1024 * 1024,
  ledgerBytes: 64 * 1024 * 1024,
  archiveBytes: 2 * 1024 * 1024,
  archiveEntries: 100,
  commandNameCodePoints: 64,
  markerCodePoints: 128,
  identifierCodePoints: 512,
  stallFingerprintCodePoints: 2_000,
  assistantTokenTotals: 1_000,
  projectionIdentifierCodePoints: 64,
  promptOutputCodePoints: 32 * 1024,
  toolOutputCodePoints: 64 * 1024,
  toolHistoryEntries: 10,
  toolHistoryDetailCodePoints: 1_000,
} as const

const CLOCK_SKEW_SECONDS = 5 * 60
const TRUNCATED_SUFFIX = " … [truncated]"

export type ContractIssue = {
  path: string
  code: string
  message: string
}

export type ContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ContractIssue[] }

export type InputValidation =
  | { ok: true; value: string }
  | { ok: false; error: string }

export class GoalContractError extends Error {
  readonly issues: ContractIssue[]

  constructor(context: string, issues: readonly ContractIssue[]) {
    const first = issues[0]
    super(
      first
        ? `${context}: ${first.path} ${first.message}`
        : `${context}: goal contract validation failed`,
    )
    this.name = "GoalContractError"
    this.issues = [...issues]
  }
}

export function codePointLength(value: string): number {
  return [...value].length
}

export function truncateCodePoints(value: string, maximum: number): string {
  const points = [...value]
  if (points.length <= maximum) return value
  if (maximum <= 0) return ""
  const suffix = [...TRUNCATED_SUFFIX]
  if (suffix.length >= maximum) return suffix.slice(0, maximum).join("")
  return `${points.slice(0, maximum - suffix.length).join("")}${TRUNCATED_SUFFIX}`
}

export function projectNonNegativeInteger(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function inputString(
  raw: string,
  label: string,
  maximum: number,
  required = true,
): InputValidation {
  const value = raw.trim()
  if (required && !value) return { ok: false, error: `${label} is required.` }
  const length = codePointLength(value)
  if (length > maximum) {
    return {
      ok: false,
      error: `${label} is too long (${length}/${maximum} characters). Put long detail in a file and reference it from the goal.`,
    }
  }
  return { ok: true, value }
}

export function validateCheckText(raw: string): InputValidation {
  return inputString(raw, "Check text", GOAL_LIMITS.checkTextCodePoints)
}

export function validateEvidence(raw: string): InputValidation {
  return inputString(raw, "Evidence", GOAL_LIMITS.detailCodePoints)
}

export function validateBlocker(raw: string): InputValidation {
  return inputString(raw, "Blocker", GOAL_LIMITS.detailCodePoints)
}

export function validateProviderDetail(raw: string): InputValidation {
  return inputString(raw, "Provider detail", GOAL_LIMITS.detailCodePoints, false)
}

export function validateIdentifier(raw: string, label: string): InputValidation {
  return inputString(raw, label, GOAL_LIMITS.identifierCodePoints)
}

export function checklistAggregateCodePoints(checks: readonly Pick<GoalCheck, "text" | "evidence">[]): number {
  return checks.reduce(
    (total, check) => total + codePointLength(check.text) + codePointLength(check.evidence),
    0,
  )
}

export function validateInitialChecks(rawChecks: readonly string[]):
  | { ok: true; value: string[] }
  | { ok: false; error: string } {
  if (rawChecks.length > GOAL_LIMITS.checks) {
    return { ok: false, error: `Too many checks (${rawChecks.length}/${GOAL_LIMITS.checks}).` }
  }
  const checks: string[] = []
  for (const raw of rawChecks) {
    const result = validateCheckText(raw)
    if (!result.ok) return result
    checks.push(result.value)
  }
  const aggregate = checks.reduce((total, check) => total + codePointLength(check), 0)
  if (aggregate > GOAL_LIMITS.checklistAggregateCodePoints) {
    return {
      ok: false,
      error: `Checklist text is too long in aggregate (${aggregate}/${GOAL_LIMITS.checklistAggregateCodePoints} characters). Put long detail in a file and reference it from the goal.`,
    }
  }
  return { ok: true, value: checks }
}

export function validateCheckAddition(goal: StoredGoal, rawText: string): InputValidation {
  if (goal.checks.length >= GOAL_LIMITS.checks) {
    return { ok: false, error: `A goal can have at most ${GOAL_LIMITS.checks} checks.` }
  }
  const result = validateCheckText(rawText)
  if (!result.ok) return result
  const aggregate = checklistAggregateCodePoints(goal.checks) + codePointLength(result.value)
  if (aggregate > GOAL_LIMITS.checklistAggregateCodePoints) {
    return {
      ok: false,
      error: `Checklist text is too long in aggregate (${aggregate}/${GOAL_LIMITS.checklistAggregateCodePoints} characters). Put long detail in a file and reference it from the goal.`,
    }
  }
  return result
}

export function validateCheckEvidence(
  goal: StoredGoal,
  checkId: string,
  rawEvidence: string,
): InputValidation {
  const result = validateEvidence(rawEvidence)
  if (!result.ok) return result
  const check = goal.checks.find((item) => item.id.toLowerCase() === checkId.toLowerCase())
  if (!check) return { ok: false, error: `Unknown check: ${checkId}` }
  const aggregate =
    checklistAggregateCodePoints(goal.checks) -
    codePointLength(check.evidence) +
    codePointLength(result.value)
  if (aggregate > GOAL_LIMITS.checklistAggregateCodePoints) {
    return {
      ok: false,
      error: `Checklist evidence is too long in aggregate (${aggregate}/${GOAL_LIMITS.checklistAggregateCodePoints} characters). Put long detail in a file and reference it from the goal.`,
    }
  }
  return result
}

export function validateCommandName(raw: string): InputValidation {
  const result = inputString(raw.replace(/^\/+/, ""), "Command name", GOAL_LIMITS.commandNameCodePoints)
  if (!result.ok) return result
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(result.value)) {
    return { ok: false, error: "Command name may contain only letters, numbers, underscores, and hyphens." }
  }
  return result
}

export function validateMarker(raw: string, label: string): InputValidation {
  const result = inputString(raw, label, GOAL_LIMITS.markerCodePoints)
  if (!result.ok) return result
  if (/\r|\n/.test(result.value)) return { ok: false, error: `${label} must be a single line.` }
  return result
}

function issue(issues: ContractIssue[], path: string, code: string, message: string): undefined {
  issues.push({ path, code, message })
  return undefined
}

function storedString(
  value: unknown,
  path: string,
  maximum: number,
  issues: ContractIssue[],
  required = false,
): string | undefined {
  if (typeof value !== "string") return issue(issues, path, "type", "must be a string")
  if (required && !value.trim()) return issue(issues, path, "required", "must not be empty")
  const length = codePointLength(value)
  if (length > maximum) return issue(issues, path, "length", `exceeds ${maximum} characters`)
  return value
}

function safeInteger(
  value: unknown,
  path: string,
  issues: ContractIssue[],
  positive = false,
): number | undefined {
  if (!Number.isSafeInteger(value)) return issue(issues, path, "integer", "must be a finite safe integer")
  const number = value as number
  if (positive ? number <= 0 : number < 0) {
    return issue(issues, path, "range", positive ? "must be positive" : "must be non-negative")
  }
  return number
}

function storedBoolean(value: unknown, path: string, issues: ContractIssue[]): boolean | undefined {
  return typeof value === "boolean" ? value : issue(issues, path, "type", "must be a boolean")
}

function checkStatus(value: unknown): value is GoalCheckStatus {
  return value === "pending" || value === "satisfied"
}

function goalMode(value: unknown): value is GoalMode {
  return value === "standard" || value === "checklist"
}

const STORED_GOAL_KEYS = new Set([
  "threadId", "objective", "status", "policy", "tokenBudget", "tokensUsed", "timeUsedSeconds", "createdAt", "updatedAt",
  "mode", "checks", "assistantTokenTotals", "continuationCount", "activeStartedAtSeconds", "lastContinueAt",
  "lastProgressAt", "usageLimitedUntil", "usageLimitedReason", "promptFailureCount", "noProgressTurns",
  "noToolCallTurns", "budgetWrapupSent", "budgetWrapupPending", "budgetWrapupLimitReason",
  "budgetWrapupBaselineAssistantMessageId", "evaluatorFeedback", "completionRejectedCount", "lastAssistantText",
  "lastAssistantTextLength", "lastAssistantMessageId", "lastStallEvaluatedAssistantMessageId",
  "lastStallEvaluatedAssistantFingerprint", "lastEvidence", "blockedReason", "history",
])

export function validateConstraints(rawConstraints: readonly string[]):
  | { ok: true; value: string[] }
  | { ok: false; error: string } {
  if (rawConstraints.length > GOAL_LIMITS.constraints) {
    return { ok: false, error: `Too many constraints (${rawConstraints.length}/${GOAL_LIMITS.constraints}).` }
  }
  const constraints: string[] = []
  let aggregate = 0
  for (const raw of rawConstraints) {
    const result = inputString(raw, "Constraint", GOAL_LIMITS.constraintCodePoints)
    if (!result.ok) return result
    aggregate += codePointLength(result.value)
    if (aggregate > GOAL_LIMITS.constraintsAggregateCodePoints) {
      return {
        ok: false,
        error: `Constraint text is too long in aggregate (${aggregate}/${GOAL_LIMITS.constraintsAggregateCodePoints} characters).`,
      }
    }
    constraints.push(result.value)
  }
  return { ok: true, value: constraints }
}

function validatePolicy(
  value: unknown,
  path: string,
  issues: ContractIssue[],
): GoalPolicy | undefined {
  if (!isRecord(value)) return issue(issues, path, "type", "must be an object")
  const unknown = Object.keys(value).filter((key) => !["maxTurns", "maxDurationSeconds", "tokenBudget", "constraints"].includes(key))
  if (unknown.length > 0) issue(issues, path, "unknown", `contains unknown fields: ${unknown.join(", ")}`)
  const maxTurns = safeInteger(value.maxTurns, `${path}.maxTurns`, issues, true)
  const maxDurationSeconds = safeInteger(value.maxDurationSeconds, `${path}.maxDurationSeconds`, issues, true)
  let tokenBudget: number | null | undefined
  if (value.tokenBudget === null) tokenBudget = null
  else tokenBudget = safeInteger(value.tokenBudget, `${path}.tokenBudget`, issues, true)
  if (!Array.isArray(value.constraints)) {
    issue(issues, `${path}.constraints`, "type", "must be an array")
    return undefined
  }
  const constraints: string[] = []
  let aggregate = 0
  if (value.constraints.length > GOAL_LIMITS.constraints) {
    issue(issues, `${path}.constraints`, "count", `exceeds ${GOAL_LIMITS.constraints} constraints`)
  }
  for (const [index, raw] of value.constraints.entries()) {
    const constraint = storedString(raw, `${path}.constraints[${index}]`, GOAL_LIMITS.constraintCodePoints, issues, true)
    if (constraint !== undefined) {
      aggregate += codePointLength(constraint)
      constraints.push(constraint)
    }
  }
  if (aggregate > GOAL_LIMITS.constraintsAggregateCodePoints) {
    issue(issues, `${path}.constraints`, "aggregate", `exceeds ${GOAL_LIMITS.constraintsAggregateCodePoints} characters`)
  }
  if (maxTurns === undefined || maxDurationSeconds === undefined || tokenBudget === undefined) return undefined
  return { maxTurns, maxDurationSeconds, tokenBudget, constraints }
}

function validateChecks(value: unknown, path: string, loadedAtSeconds: number, issues: ContractIssue[]): GoalCheck[] | undefined {
  if (!Array.isArray(value)) return issue(issues, path, "type", "must be an array")
  if (value.length > GOAL_LIMITS.checks) issue(issues, path, "count", `exceeds ${GOAL_LIMITS.checks} checks`)
  const result: GoalCheck[] = []
  const ids = new Set<string>()
  for (const [index, raw] of value.entries()) {
    const checkPath = `${path}[${index}]`
    if (!isRecord(raw)) {
      issue(issues, checkPath, "type", "must be an object")
      continue
    }
    const unknown = Object.keys(raw).filter((key) => !["id", "text", "status", "evidence", "updatedAt"].includes(key))
    if (unknown.length > 0) issue(issues, checkPath, "unknown", `contains unknown fields: ${unknown.join(", ")}`)
    const id = storedString(raw.id, `${checkPath}.id`, GOAL_LIMITS.identifierCodePoints, issues, true)
    const text = storedString(raw.text, `${checkPath}.text`, GOAL_LIMITS.checkTextCodePoints, issues, true)
    const evidence = storedString(raw.evidence, `${checkPath}.evidence`, GOAL_LIMITS.detailCodePoints, issues)
    const updatedAt = safeInteger(raw.updatedAt, `${checkPath}.updatedAt`, issues)
    if (id) {
      const match = id.match(/^C([1-9]\d*)$/)
      if (!match || !Number.isSafeInteger(Number(match[1]))) {
        issue(issues, `${checkPath}.id`, "format", "must be a canonical safe-integer check id such as C1")
      }
    }
    if (id && ids.has(id)) issue(issues, `${checkPath}.id`, "duplicate", "must be unique")
    if (id) ids.add(id)
    if (!checkStatus(raw.status)) issue(issues, `${checkPath}.status`, "enum", "must be pending or satisfied")
    if (raw.status === "satisfied" && !evidence?.trim()) issue(issues, `${checkPath}.evidence`, "required", "is required for a satisfied check")
    if (raw.status === "pending" && evidence) issue(issues, `${checkPath}.evidence`, "state", "must be empty for a pending check")
    if (updatedAt !== undefined && updatedAt > (loadedAtSeconds + CLOCK_SKEW_SECONDS) * 1000) {
      issue(issues, `${checkPath}.updatedAt`, "future", "is implausibly far in the future")
    }
    if (id !== undefined && text !== undefined && evidence !== undefined && updatedAt !== undefined && checkStatus(raw.status)) {
      result.push({ id, text, status: raw.status, evidence, updatedAt })
    }
  }
  const aggregate = checklistAggregateCodePoints(result)
  if (aggregate > GOAL_LIMITS.checklistAggregateCodePoints) {
    issue(issues, path, "aggregate", `exceeds ${GOAL_LIMITS.checklistAggregateCodePoints} text/evidence characters`)
  }
  return result
}

function validateTokenTotals(
  value: unknown,
  path: string,
  issues: ContractIssue[],
): AssistantTokenTotal[] | undefined {
  if (!Array.isArray(value)) return issue(issues, path, "type", "must be an array")
  if (value.length > GOAL_LIMITS.assistantTokenTotals) {
    issue(issues, path, "count", `exceeds ${GOAL_LIMITS.assistantTokenTotals} entries`)
  }
  const ids = new Set<string>()
  const result: AssistantTokenTotal[] = []
  for (const [index, raw] of value.entries()) {
    const entryPath = `${path}[${index}]`
    if (!isRecord(raw)) {
      issue(issues, entryPath, "type", "must be an object")
      continue
    }
    const unknown = Object.keys(raw).filter((key) => !["messageId", "total"].includes(key))
    if (unknown.length > 0) issue(issues, entryPath, "unknown", `contains unknown fields: ${unknown.join(", ")}`)
    const messageId = storedString(raw.messageId, `${entryPath}.messageId`, GOAL_LIMITS.identifierCodePoints, issues, true)
    const total = safeInteger(raw.total, `${entryPath}.total`, issues)
    if (messageId && ids.has(messageId)) issue(issues, `${entryPath}.messageId`, "duplicate", "must be unique")
    if (messageId) ids.add(messageId)
    if (messageId !== undefined && total !== undefined) result.push({ messageId, total })
  }
  return result
}

function validateHistory(
  value: unknown,
  path: string,
  createdAt: number | undefined,
  loadedAtSeconds: number,
  issues: ContractIssue[],
): GoalHistoryEntry[] | undefined {
  if (!Array.isArray(value)) return issue(issues, path, "type", "must be an array")
  if (value.length > GOAL_LIMITS.historyEntries) issue(issues, path, "count", `exceeds ${GOAL_LIMITS.historyEntries} entries`)
  const result: GoalHistoryEntry[] = []
  let previousTimestamp = -1
  for (const [index, raw] of value.entries()) {
    const entryPath = `${path}[${index}]`
    if (!isRecord(raw)) {
      issue(issues, entryPath, "type", "must be an object")
      continue
    }
    const unknown = Object.keys(raw).filter((key) => !["timestamp", "type", "detail"].includes(key))
    if (unknown.length > 0) issue(issues, entryPath, "unknown", `contains unknown fields: ${unknown.join(", ")}`)
    const timestamp = safeInteger(raw.timestamp, `${entryPath}.timestamp`, issues)
    const type = storedString(raw.type, `${entryPath}.type`, GOAL_LIMITS.historyTypeCodePoints, issues, true)
    const detail = storedString(raw.detail, `${entryPath}.detail`, GOAL_LIMITS.detailCodePoints, issues)
    if (timestamp !== undefined) {
      if (createdAt !== undefined && timestamp < createdAt * 1000) issue(issues, `${entryPath}.timestamp`, "order", "precedes goal creation")
      if (timestamp > (loadedAtSeconds + CLOCK_SKEW_SECONDS) * 1000) issue(issues, `${entryPath}.timestamp`, "future", "is implausibly far in the future")
      if (timestamp < previousTimestamp) issue(issues, `${entryPath}.timestamp`, "order", "precedes the previous history entry")
      previousTimestamp = timestamp
    }
    if (timestamp !== undefined && type !== undefined && detail !== undefined) result.push({ timestamp, type, detail })
  }
  return result
}

function archiveStatus(value: unknown): value is GoalArchiveStatus {
  return value === "complete" || value === "blocked" || value === "budgetLimited" || value === "cleared"
}

export function validateArchiveEntry(
  value: unknown,
  loadedAtSeconds: number,
  path = "archive",
): ContractResult<GoalArchiveEntry> {
  const issues: ContractIssue[] = []
  if (!isRecord(value)) return { ok: false, issues: [{ path, code: "type", message: "must be an object" }] }
  const allowed = [
    "id", "threadId", "objective", "status", "terminalAt", "tokensUsed", "timeUsedSeconds",
    "continuationCount", "lastEvidence", "blockedReason", "checks",
  ]
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) issue(issues, path, "unknown", `contains unknown fields: ${unknown.join(", ")}`)
  const id = storedString(value.id, `${path}.id`, GOAL_LIMITS.identifierCodePoints, issues, true)
  const threadId = storedString(value.threadId, `${path}.threadId`, GOAL_LIMITS.identifierCodePoints, issues, true)
  const objective = storedString(value.objective, `${path}.objective`, GOAL_LIMITS.objectiveCodePoints, issues, true)
  const terminalAt = safeInteger(value.terminalAt, `${path}.terminalAt`, issues)
  const tokensUsed = safeInteger(value.tokensUsed, `${path}.tokensUsed`, issues)
  const timeUsedSeconds = safeInteger(value.timeUsedSeconds, `${path}.timeUsedSeconds`, issues)
  const continuationCount = safeInteger(value.continuationCount, `${path}.continuationCount`, issues)
  const lastEvidence = storedString(value.lastEvidence, `${path}.lastEvidence`, GOAL_LIMITS.detailCodePoints, issues)
  const blockedReason = storedString(value.blockedReason, `${path}.blockedReason`, GOAL_LIMITS.detailCodePoints, issues)
  if (!archiveStatus(value.status)) issue(issues, `${path}.status`, "enum", "must be a terminal archive status")
  if (terminalAt !== undefined && terminalAt > loadedAtSeconds + CLOCK_SKEW_SECONDS) {
    issue(issues, `${path}.terminalAt`, "future", "is implausibly far in the future")
  }
  const checks: GoalArchiveEntry["checks"] = []
  if (!Array.isArray(value.checks)) {
    issue(issues, `${path}.checks`, "type", "must be an array")
  } else {
    if (value.checks.length > GOAL_LIMITS.checks) issue(issues, `${path}.checks`, "count", `exceeds ${GOAL_LIMITS.checks} checks`)
    const ids = new Set<string>()
    for (const [index, raw] of value.checks.entries()) {
      const checkPath = `${path}.checks[${index}]`
      if (!isRecord(raw)) {
        issue(issues, checkPath, "type", "must be an object")
        continue
      }
      const checkUnknown = Object.keys(raw).filter((key) => !["id", "status"].includes(key))
      if (checkUnknown.length > 0) issue(issues, checkPath, "unknown", `contains unknown fields: ${checkUnknown.join(", ")}`)
      const checkId = storedString(raw.id, `${checkPath}.id`, GOAL_LIMITS.identifierCodePoints, issues, true)
      if (!checkStatus(raw.status)) issue(issues, `${checkPath}.status`, "enum", "must be pending or satisfied")
      if (checkId && ids.has(checkId)) issue(issues, `${checkPath}.id`, "duplicate", "must be unique")
      if (checkId) ids.add(checkId)
      if (checkId !== undefined && checkStatus(raw.status)) checks.push({ id: checkId, status: raw.status })
    }
  }
  if (issues.length > 0) return { ok: false, issues }
  if (
    id === undefined || threadId === undefined || objective === undefined || !archiveStatus(value.status) ||
    terminalAt === undefined || tokensUsed === undefined || timeUsedSeconds === undefined ||
    continuationCount === undefined || lastEvidence === undefined || blockedReason === undefined
  ) {
    return { ok: false, issues: [{ path, code: "incomplete", message: "is missing required fields" }] }
  }
  return {
    ok: true,
    value: {
      id,
      threadId,
      objective,
      status: value.status,
      terminalAt,
      tokensUsed,
      timeUsedSeconds,
      continuationCount,
      lastEvidence,
      blockedReason,
      checks,
    },
  }
}

export function assertArchiveEntries(
  entries: readonly GoalArchiveEntry[],
  loadedAtSeconds: number,
  context: string,
): void {
  if (entries.length > GOAL_LIMITS.archiveEntries) {
    throw new GoalContractError(context, [{ path: "entries", code: "count", message: `exceeds ${GOAL_LIMITS.archiveEntries} entries` }])
  }
  const ids = new Set<string>()
  for (const [index, entry] of entries.entries()) {
    const result = validateArchiveEntry(entry, loadedAtSeconds, `entries[${index}]`)
    if (!result.ok) throw new GoalContractError(context, result.issues)
    if (ids.has(result.value.id)) {
      throw new GoalContractError(context, [{ path: `entries[${index}].id`, code: "duplicate", message: "must be unique" }])
    }
    ids.add(result.value.id)
  }
}

export function validatePersistedGoal(
  value: unknown,
  loadedAtSeconds: number,
  path = "goal",
  allowedEnvelopeKeys: readonly string[] = [],
  policyDefaults: GoalPolicy = defaultGoalPolicy(),
): ContractResult<StoredGoal> {
  const issues: ContractIssue[] = []
  if (!isRecord(value)) return { ok: false, issues: [{ path, code: "type", message: "must be an object" }] }

  const allowed = new Set([...STORED_GOAL_KEYS, ...allowedEnvelopeKeys])
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) issue(issues, path, "unknown", `contains unknown fields: ${unknown.join(", ")}`)

  const threadId = storedString(value.threadId, `${path}.threadId`, GOAL_LIMITS.identifierCodePoints, issues, true)
  const objective = storedString(value.objective, `${path}.objective`, GOAL_LIMITS.objectiveCodePoints, issues, true)
  let status: ThreadGoalStatus | undefined
  if (value.status === "usageLimited") status = "active"
  else if (isThreadGoalStatus(value.status)) status = value.status
  else issue(issues, `${path}.status`, "enum", "must be a supported goal status")
  let mode: GoalMode | undefined
  if (goalMode(value.mode)) mode = value.mode
  else issue(issues, `${path}.mode`, "enum", "must be standard or checklist")

  let policy: GoalPolicy | undefined
  if (value.policy === undefined) {
    let legacyTokenBudget: number | null | undefined
    if (value.tokenBudget === null) legacyTokenBudget = null
    else legacyTokenBudget = safeInteger(value.tokenBudget, `${path}.tokenBudget`, issues, true)
    if (legacyTokenBudget !== undefined) {
      policy = { ...structuredClone(policyDefaults), tokenBudget: legacyTokenBudget, constraints: [] }
    }
  } else {
    policy = validatePolicy(value.policy, `${path}.policy`, issues)
    if (Object.hasOwn(value, "tokenBudget")) {
      issue(issues, `${path}.tokenBudget`, "duplicate", "must be omitted when policy is present")
    }
  }
  const tokensUsed = safeInteger(value.tokensUsed, `${path}.tokensUsed`, issues)
  const timeUsedSeconds = safeInteger(value.timeUsedSeconds, `${path}.timeUsedSeconds`, issues)
  const createdAt = safeInteger(value.createdAt, `${path}.createdAt`, issues)
  const updatedAt = safeInteger(value.updatedAt, `${path}.updatedAt`, issues)
  const continuationCount = safeInteger(value.continuationCount, `${path}.continuationCount`, issues)
  const lastContinueAt = safeInteger(value.lastContinueAt, `${path}.lastContinueAt`, issues)
  const lastProgressAt = safeInteger(value.lastProgressAt, `${path}.lastProgressAt`, issues)
  const usageLimitedUntil = safeInteger(value.usageLimitedUntil, `${path}.usageLimitedUntil`, issues)
  const promptFailureCount = safeInteger(value.promptFailureCount, `${path}.promptFailureCount`, issues)
  const noProgressTurns = safeInteger(value.noProgressTurns, `${path}.noProgressTurns`, issues)
  const noToolCallTurns = safeInteger(value.noToolCallTurns, `${path}.noToolCallTurns`, issues)
  const completionRejectedCount = safeInteger(value.completionRejectedCount, `${path}.completionRejectedCount`, issues)
  const lastAssistantTextLength = safeInteger(value.lastAssistantTextLength, `${path}.lastAssistantTextLength`, issues)

  const usageLimitedReason = storedString(value.usageLimitedReason, `${path}.usageLimitedReason`, GOAL_LIMITS.detailCodePoints, issues)
  const evaluatorFeedback = storedString(value.evaluatorFeedback, `${path}.evaluatorFeedback`, GOAL_LIMITS.detailCodePoints, issues)
  const lastAssistantText = storedString(value.lastAssistantText, `${path}.lastAssistantText`, GOAL_LIMITS.assistantCheckpointCodePoints, issues)
  const lastAssistantMessageId = storedString(value.lastAssistantMessageId, `${path}.lastAssistantMessageId`, GOAL_LIMITS.identifierCodePoints, issues)
  const lastEvidence = storedString(value.lastEvidence, `${path}.lastEvidence`, GOAL_LIMITS.detailCodePoints, issues)
  const blockedReason = storedString(value.blockedReason, `${path}.blockedReason`, GOAL_LIMITS.detailCodePoints, issues)

  const budgetWrapupSent = storedBoolean(value.budgetWrapupSent, `${path}.budgetWrapupSent`, issues)
  const budgetWrapupPending = value.budgetWrapupPending === undefined
    ? false
    : storedBoolean(value.budgetWrapupPending, `${path}.budgetWrapupPending`, issues)
  const budgetWrapupLimitReason = value.budgetWrapupLimitReason === undefined
    ? ""
    : storedString(value.budgetWrapupLimitReason, `${path}.budgetWrapupLimitReason`, GOAL_LIMITS.detailCodePoints, issues)
  const budgetWrapupBaselineAssistantMessageId = value.budgetWrapupBaselineAssistantMessageId === undefined
    ? ""
    : storedString(
        value.budgetWrapupBaselineAssistantMessageId,
        `${path}.budgetWrapupBaselineAssistantMessageId`,
        GOAL_LIMITS.identifierCodePoints,
        issues,
      )
  const lastStallEvaluatedAssistantMessageId = value.lastStallEvaluatedAssistantMessageId === undefined
    ? ""
    : storedString(
        value.lastStallEvaluatedAssistantMessageId,
        `${path}.lastStallEvaluatedAssistantMessageId`,
        GOAL_LIMITS.identifierCodePoints,
        issues,
      )
  const lastStallEvaluatedAssistantFingerprint = value.lastStallEvaluatedAssistantFingerprint === undefined
    ? ""
    : storedString(
        value.lastStallEvaluatedAssistantFingerprint,
        `${path}.lastStallEvaluatedAssistantFingerprint`,
        GOAL_LIMITS.stallFingerprintCodePoints,
        issues,
      )

  const checks = validateChecks(value.checks, `${path}.checks`, loadedAtSeconds, issues)
  let assistantTokenTotals: AssistantTokenTotal[] | undefined
  if (value.assistantTokenTotals === undefined) {
    assistantTokenTotals = lastAssistantMessageId && tokensUsed !== undefined && tokensUsed > 0
      ? [{ messageId: lastAssistantMessageId, total: tokensUsed }]
      : []
  } else {
    assistantTokenTotals = validateTokenTotals(value.assistantTokenTotals, `${path}.assistantTokenTotals`, issues)
  }
  const history = validateHistory(value.history, `${path}.history`, createdAt, loadedAtSeconds, issues)

  let persistedActiveStartedAt: number | null | undefined
  const hasPersistedActiveStartedAt = Object.hasOwn(value, "activeStartedAtSeconds")
  if (value.activeStartedAtSeconds === undefined || value.activeStartedAtSeconds === null) {
    persistedActiveStartedAt = null
  } else {
    persistedActiveStartedAt = safeInteger(value.activeStartedAtSeconds, `${path}.activeStartedAtSeconds`, issues)
    if (persistedActiveStartedAt !== undefined && persistedActiveStartedAt > loadedAtSeconds) {
      issue(issues, `${path}.activeStartedAtSeconds`, "future", "must not be in the future")
    }
  }

  if (createdAt !== undefined) {
    if (createdAt > loadedAtSeconds + CLOCK_SKEW_SECONDS) issue(issues, `${path}.createdAt`, "future", "is implausibly far in the future")
    if (updatedAt !== undefined && updatedAt < createdAt) issue(issues, `${path}.updatedAt`, "order", "precedes goal creation")
    if (lastProgressAt !== undefined && lastProgressAt < createdAt) issue(issues, `${path}.lastProgressAt`, "order", "precedes goal creation")
  }
  if (updatedAt !== undefined && updatedAt > loadedAtSeconds + CLOCK_SKEW_SECONDS) {
    issue(issues, `${path}.updatedAt`, "future", "is implausibly far in the future")
  }
  if (lastProgressAt !== undefined && lastProgressAt > loadedAtSeconds + CLOCK_SKEW_SECONDS) {
    issue(issues, `${path}.lastProgressAt`, "future", "is implausibly far in the future")
  }
  if (lastContinueAt !== undefined && lastContinueAt > (loadedAtSeconds + CLOCK_SKEW_SECONDS) * 1000) {
    issue(issues, `${path}.lastContinueAt`, "future", "is implausibly far in the future")
  }
  if (usageLimitedUntil !== undefined && usageLimitedReason !== undefined) {
    if ((usageLimitedUntil > 0) !== Boolean(usageLimitedReason)) {
      issue(issues, `${path}.usageLimitedReason`, "state", "must be present exactly when a provider wait is active")
    }
  }
  if (
    hasPersistedActiveStartedAt &&
    status !== undefined &&
    usageLimitedUntil !== undefined &&
    usageLimitedReason !== undefined
  ) {
    const chargeable = status === "active" && usageLimitedUntil === 0 && !usageLimitedReason
    if (chargeable && persistedActiveStartedAt === null) {
      issue(issues, `${path}.activeStartedAtSeconds`, "state", "is required while active time is chargeable")
    }
    if (!chargeable && persistedActiveStartedAt !== null && persistedActiveStartedAt !== undefined) {
      issue(issues, `${path}.activeStartedAtSeconds`, "state", "must be null while active time is stopped")
    }
  }
  if (lastAssistantText !== undefined && lastAssistantTextLength !== undefined && lastAssistantTextLength < lastAssistantText.length) {
    issue(issues, `${path}.lastAssistantTextLength`, "range", "must cover the stored assistant checkpoint")
  }
  if (budgetWrapupPending) {
    if (!budgetWrapupSent) issue(issues, `${path}.budgetWrapupPending`, "state", "requires budgetWrapupSent")
    if (status !== "active") issue(issues, `${path}.budgetWrapupPending`, "state", "requires active status")
    if (!budgetWrapupLimitReason) issue(issues, `${path}.budgetWrapupLimitReason`, "required", "is required while wrap-up is pending")
  } else if (budgetWrapupLimitReason || budgetWrapupBaselineAssistantMessageId) {
    issue(issues, `${path}.budgetWrapupPending`, "state", "cleared wrap-up state must not retain pending metadata")
  }

  if (issues.length > 0) return { ok: false, issues }
  if (
    threadId === undefined || objective === undefined || status === undefined || mode === undefined ||
    policy === undefined || tokensUsed === undefined || timeUsedSeconds === undefined || createdAt === undefined ||
    updatedAt === undefined || continuationCount === undefined || lastContinueAt === undefined ||
    lastProgressAt === undefined || usageLimitedUntil === undefined || usageLimitedReason === undefined ||
    promptFailureCount === undefined || noProgressTurns === undefined || noToolCallTurns === undefined ||
    budgetWrapupSent === undefined || budgetWrapupPending === undefined || budgetWrapupLimitReason === undefined ||
    budgetWrapupBaselineAssistantMessageId === undefined || evaluatorFeedback === undefined ||
    completionRejectedCount === undefined || lastAssistantText === undefined || lastAssistantTextLength === undefined ||
    lastAssistantMessageId === undefined || lastStallEvaluatedAssistantMessageId === undefined ||
    lastStallEvaluatedAssistantFingerprint === undefined || lastEvidence === undefined || blockedReason === undefined ||
    checks === undefined || assistantTokenTotals === undefined || history === undefined
  ) {
    return { ok: false, issues: [{ path, code: "incomplete", message: "is missing required fields" }] }
  }

  const activeStartedAtSeconds =
    status === "active" && usageLimitedUntil === 0 && !usageLimitedReason
      ? loadedAtSeconds
      : null
  return {
    ok: true,
    value: {
      threadId,
      objective,
      status,
      mode,
      policy,
      checks,
      assistantTokenTotals,
      tokensUsed,
      timeUsedSeconds,
      createdAt,
      updatedAt,
      continuationCount,
      activeStartedAtSeconds,
      lastContinueAt,
      lastProgressAt,
      usageLimitedUntil,
      usageLimitedReason,
      promptFailureCount,
      noProgressTurns,
      noToolCallTurns,
      budgetWrapupSent,
      budgetWrapupPending,
      budgetWrapupLimitReason,
      budgetWrapupBaselineAssistantMessageId,
      evaluatorFeedback,
      completionRejectedCount,
      lastAssistantText,
      lastAssistantTextLength,
      lastAssistantMessageId,
      lastStallEvaluatedAssistantMessageId,
      lastStallEvaluatedAssistantFingerprint,
      lastEvidence,
      blockedReason,
      history,
    },
  }
}

export function assertPersistedGoals(goals: readonly StoredGoal[], nowSeconds: number, context: string): void {
  if (goals.length > GOAL_LIMITS.goalsPerSnapshot) {
    throw new GoalContractError(context, [{
      path: "goals",
      code: "count",
      message: `exceeds ${GOAL_LIMITS.goalsPerSnapshot} goals`,
    }])
  }
  const threadIds = new Set<string>()
  for (const [index, goal] of goals.entries()) {
    const result = validatePersistedGoal(goal, nowSeconds, `goals[${index}]`)
    if (!result.ok) throw new GoalContractError(context, result.issues)
    if (threadIds.has(result.value.threadId)) {
      throw new GoalContractError(context, [{ path: `goals[${index}].threadId`, code: "duplicate", message: "must be unique" }])
    }
    threadIds.add(result.value.threadId)
  }
}

export type ProjectedCheck = Pick<GoalCheck, "id" | "status"> & {
  text: string
  evidence: string
}

export function projectChecks(checks: readonly GoalCheck[]): { checks: ProjectedCheck[]; truncated: boolean } {
  const projected: ProjectedCheck[] = []
  let remaining = GOAL_LIMITS.checklistAggregateCodePoints
  let truncated = checks.length > GOAL_LIMITS.checks
  for (const check of checks.slice(0, GOAL_LIMITS.checks)) {
    if (remaining <= 0) {
      truncated = true
      break
    }
    const text = truncateCodePoints(check.text, Math.min(GOAL_LIMITS.checkTextCodePoints, remaining))
    remaining -= codePointLength(text)
    const evidence = truncateCodePoints(check.evidence, Math.min(GOAL_LIMITS.detailCodePoints, remaining))
    remaining -= codePointLength(evidence)
    if (text !== check.text || evidence !== check.evidence) truncated = true
    projected.push({
      id: truncateCodePoints(check.id, GOAL_LIMITS.projectionIdentifierCodePoints),
      status: check.status === "satisfied" ? "satisfied" : "pending",
      text,
      evidence,
    })
  }
  return { checks: projected, truncated }
}

export function projectGoalForTool(goal: StoredGoal): Record<string, unknown> {
  const checks = projectChecks(goal.checks)
  return {
    threadId: truncateCodePoints(goal.threadId, GOAL_LIMITS.projectionIdentifierCodePoints),
    objective: truncateCodePoints(goal.objective, GOAL_LIMITS.objectiveCodePoints),
    status: goal.status,
    mode: goal.mode,
    checks: checks.checks,
    checksTruncated: checks.truncated,
    policy: {
      maxTurns: projectNonNegativeInteger(goal.policy.maxTurns),
      maxDurationSeconds: projectNonNegativeInteger(goal.policy.maxDurationSeconds),
      tokenBudget: goal.policy.tokenBudget === null ? null : projectNonNegativeInteger(goal.policy.tokenBudget),
      constraints: goal.policy.constraints.map((constraint) => truncateCodePoints(constraint, GOAL_LIMITS.constraintCodePoints)),
    },
    tokensUsed: projectNonNegativeInteger(goal.tokensUsed),
    timeUsedSeconds: projectNonNegativeInteger(goal.timeUsedSeconds),
    continuationCount: projectNonNegativeInteger(goal.continuationCount),
    usageLimitedUntil: projectNonNegativeInteger(goal.usageLimitedUntil),
    usageLimitedReason: truncateCodePoints(goal.usageLimitedReason, GOAL_LIMITS.detailCodePoints),
    evaluatorFeedback: truncateCodePoints(goal.evaluatorFeedback, GOAL_LIMITS.detailCodePoints),
    lastEvidence: truncateCodePoints(goal.lastEvidence, GOAL_LIMITS.detailCodePoints),
    blockedReason: truncateCodePoints(goal.blockedReason, GOAL_LIMITS.detailCodePoints),
    history: goal.history.slice(-GOAL_LIMITS.toolHistoryEntries).map((entry) => ({
      timestamp: projectNonNegativeInteger(entry.timestamp),
      type: truncateCodePoints(entry.type, GOAL_LIMITS.historyTypeCodePoints),
      detail: truncateCodePoints(entry.detail, GOAL_LIMITS.toolHistoryDetailCodePoints),
    })),
  }
}

export function goalToolJson(goal: StoredGoal): string {
  const json = JSON.stringify(projectGoalForTool(goal), null, 2)
  if (codePointLength(json) <= GOAL_LIMITS.toolOutputCodePoints) return json
  return JSON.stringify({
    status: goal.status,
    objective: truncateCodePoints(goal.objective, GOAL_LIMITS.objectiveCodePoints),
    projectionTruncated: true,
    detail: `Goal tool output exceeded ${GOAL_LIMITS.toolOutputCodePoints} characters. Use focused goal commands for details.`,
  }, null, 2)
}
