import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { GOAL_LIMITS, validateCommandName, validateMarker } from "./goal-contract.ts"
import { DEFAULT_MAX_OBJECTIVE_LENGTH } from "./objective.ts"
import type { GoalPluginOptions, GoalPolicy } from "./types.ts"

export type ResolvedOptions = {
  commandName: string
  maxTurns: number
  maxDurationSeconds: number
  tokenBudget: number | null
  stateFilePath: string
  stateFileTrustRoot: string
  stateFileProjectLocal: boolean
  persistState: boolean
  registerTools: boolean
  autoContinue: boolean
  idleSettleMs: number
  minDelayMs: number
  maxPromptFailures: number
  usageLimitWaitSeconds: number
  maxRecentMessages: number
  noProgressTokenThreshold: number
  noProgressTurnsBeforePause: number
  noToolCallTurnsBeforePause: number
  budgetWrapupRatio: number
  maxObjectiveLength: number
  completionMarker: string
  blockedMarker: string
  evidenceMarker: string
  toastNotifications: boolean
  sessionTitle: boolean
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function ratio(value: unknown, fallback: number): number {
  return typeof value === "number" && value > 0 && value < 1 ? value : fallback
}

function boundedPositiveInteger(value: unknown, fallback: number, maximum: number, label: string): number {
  const result = positiveInteger(value, fallback)
  if (result > maximum) throw new Error(`${label} must not exceed ${maximum}.`)
  return result
}

function resolveStateFilePath(
  configuredValue: string | undefined,
  projectDirectory: string,
): Pick<ResolvedOptions, "stateFilePath" | "stateFileTrustRoot" | "stateFileProjectLocal"> {
  const configured = configuredValue?.trim() ?? ""
  if (configured && isAbsolute(configured)) {
    const stateFilePath = resolve(configured)
    return {
      stateFilePath,
      stateFileTrustRoot: dirname(stateFilePath),
      stateFileProjectLocal: false,
    }
  }

  const stateFileTrustRoot = resolve(projectDirectory)
  const stateFilePath = resolve(
    stateFileTrustRoot,
    configured || ".opencode/goals/opencode-goal-state.json",
  )
  const fromRoot = relative(stateFileTrustRoot, stateFilePath)
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(
      `Unsafe stateFilePath "${configured}": relative paths must stay within plugin directory "${stateFileTrustRoot}".`,
    )
  }
  return { stateFilePath, stateFileTrustRoot, stateFileProjectLocal: true }
}

export function resolveOptions(options: GoalPluginOptions = {}, cwd = process.cwd()): ResolvedOptions {
  const commandNameResult = validateCommandName(
    typeof options.commandName === "string" && options.commandName.trim() ? options.commandName : "goal",
  )
  if (!commandNameResult.ok) throw new Error(commandNameResult.error)
  const completionMarker = validateMarker(
    typeof options.completionMarker === "string" && options.completionMarker.trim()
      ? options.completionMarker
      : "[goal:complete]",
    "Completion marker",
  )
  if (!completionMarker.ok) throw new Error(completionMarker.error)
  const blockedMarker = validateMarker(
    typeof options.blockedMarker === "string" && options.blockedMarker.trim()
      ? options.blockedMarker
      : "[goal:blocked]",
    "Blocked marker",
  )
  if (!blockedMarker.ok) throw new Error(blockedMarker.error)
  const evidenceMarker = validateMarker(
    typeof options.evidenceMarker === "string" && options.evidenceMarker.trim()
      ? options.evidenceMarker
      : "[goal:evidence]",
    "Evidence marker",
  )
  if (!evidenceMarker.ok) throw new Error(evidenceMarker.error)
  if (new Set([completionMarker.value, blockedMarker.value, evidenceMarker.value]).size !== 3) {
    throw new Error("Completion, blocked, and evidence markers must be distinct.")
  }
  const configuredTokenBudget = positiveInteger(options.tokenBudget, 0)
  // Relative persistence paths are project-directory relative; absolute paths
  // are an explicit operator-selected trust boundary.
  const stateFile = resolveStateFilePath(options.stateFilePath, cwd)
  return {
    commandName: commandNameResult.value,
    maxTurns: positiveInteger(options.maxTurns, 0),
    maxDurationSeconds: positiveInteger(options.maxDurationSeconds, 0),
    tokenBudget: configuredTokenBudget > 0 ? configuredTokenBudget : null,
    ...stateFile,
    persistState: options.persistState !== false,
    registerTools: options.registerTools !== false,
    autoContinue: options.autoContinue !== false,
    idleSettleMs: nonNegativeInteger(options.idleSettleMs, 500),
    minDelayMs: nonNegativeInteger(options.minDelayMs, 1500),
    maxPromptFailures: positiveInteger(options.maxPromptFailures, 3),
    usageLimitWaitSeconds: positiveInteger(options.usageLimitWaitSeconds, 5 * 60 * 60),
    maxRecentMessages: boundedPositiveInteger(
      options.maxRecentMessages,
      50,
      GOAL_LIMITS.assistantTokenTotals,
      "maxRecentMessages",
    ),
    noProgressTokenThreshold: positiveInteger(options.noProgressTokenThreshold, 50),
    noProgressTurnsBeforePause: positiveInteger(options.noProgressTurnsBeforePause, 3),
    noToolCallTurnsBeforePause: nonNegativeInteger(options.noToolCallTurnsBeforePause, 0),
    budgetWrapupRatio: ratio(options.budgetWrapupRatio, 0.85),
    maxObjectiveLength: boundedPositiveInteger(
      options.maxObjectiveLength,
      DEFAULT_MAX_OBJECTIVE_LENGTH,
      GOAL_LIMITS.objectiveCodePoints,
      "maxObjectiveLength",
    ),
    completionMarker: completionMarker.value,
    blockedMarker: blockedMarker.value,
    evidenceMarker: evidenceMarker.value,
    toastNotifications: options.toastNotifications !== false,
    sessionTitle: options.sessionTitle !== false,
  }
}

export function goalPolicyDefaults(
  options: Pick<ResolvedOptions, "maxTurns" | "maxDurationSeconds" | "tokenBudget">,
  constraints: readonly string[] = [],
): GoalPolicy {
  return {
    maxTurns: options.maxTurns,
    maxDurationSeconds: options.maxDurationSeconds,
    tokenBudget: options.tokenBudget,
    constraints: [...constraints],
  }
}
