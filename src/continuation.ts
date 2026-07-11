import { hasToolPart, messageId, messageRole, outputTokens, partText } from "./parts.ts"
import { pauseGoal } from "./goal-operations.ts"
import { activeTimeSeconds } from "./store.ts"
import type { GoalObservation } from "./goal-observation.ts"
import type { ResolvedOptions } from "./options.ts"
import type { GoalClock, SessionMessage, StoredGoal } from "./types.ts"

export type ContinuationDecision =
  | { type: "await-wrapup" }
  | { type: "budget-limit"; detail: string; sendWrapup: boolean }
  | { type: "budget-wrapup" }
  | { type: "pause-unavailable"; detail: string }
  | { type: "pause-stall" }
  | { type: "continue" }

export function budgetLimit(goal: StoredGoal, options: ResolvedOptions, clock?: GoalClock): string {
  if (goal.policy.tokenBudget !== null && goal.tokensUsed >= goal.policy.tokenBudget) return "Token budget reached."
  if (goal.policy.maxDurationSeconds > 0 && activeTimeSeconds(goal, clock) >= goal.policy.maxDurationSeconds) return "Duration budget reached."
  if (goal.policy.maxTurns > 0 && goal.continuationCount >= goal.policy.maxTurns) return "Auto-continue turn budget reached."
  return ""
}

export function budgetWrapupNeeded(goal: StoredGoal, options: ResolvedOptions): boolean {
  return goal.policy.tokenBudget !== null && goal.tokensUsed >= Math.floor(goal.policy.tokenBudget * options.budgetWrapupRatio)
}

function isPluginContinuation(message: SessionMessage): boolean {
  return messageRole(message) === "user" && partText(message.parts).includes("<goal_continuation>")
}

export function hasUserIntervention(messages: readonly SessionMessage[]): boolean {
  let sawPluginContinuation = false
  for (const message of messages) {
    const role = messageRole(message)
    if (role !== "user") continue
    if (isPluginContinuation(message)) {
      sawPluginContinuation = true
      continue
    }
    if (sawPluginContinuation) return true
  }
  return false
}

export function pauseForUserIntervention(goal: StoredGoal, messages: readonly SessionMessage[]): boolean {
  if (goal.continuationCount === 0 || !hasUserIntervention(messages)) return false
  pauseGoal(goal, "Paused because the user sent a newer message after goal auto-continue.")
  return true
}

function fallbackFingerprint(assistant: SessionMessage): string {
  const text = partText(assistant.parts)
  const partTypes = (assistant.parts ?? []).slice(0, 32).map((part) => part.type).join(",")
  const bounded = `${text.length}:${outputTokens(assistant)}:${partTypes}:${text.slice(0, 512)}:${text.slice(-512)}`
  let hash = 2166136261
  for (let index = 0; index < bounded.length; index += 1) {
    hash ^= bounded.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${text.length}:${outputTokens(assistant)}:${(hash >>> 0).toString(16)}`
}

function alreadyEvaluated(goal: StoredGoal, assistant: SessionMessage): boolean {
  const id = messageId(assistant)
  if (id) return goal.lastStallEvaluatedAssistantMessageId === id
  return goal.lastStallEvaluatedAssistantFingerprint === fallbackFingerprint(assistant)
}

function recordEvaluation(goal: StoredGoal, assistant: SessionMessage): void {
  const id = messageId(assistant)
  goal.lastStallEvaluatedAssistantMessageId = id
  goal.lastStallEvaluatedAssistantFingerprint = id ? "" : fallbackFingerprint(assistant)
}

export function applyStallPolicy(goal: StoredGoal, assistant: SessionMessage | undefined, _observation: GoalObservation, options: ResolvedOptions): boolean {
  if (goal.continuationCount === 0 || !assistant || alreadyEvaluated(goal, assistant)) return false
  recordEvaluation(goal, assistant)

  let pauseDetail = ""
  if (options.noToolCallTurnsBeforePause > 0) {
    goal.noToolCallTurns = hasToolPart(assistant) ? 0 : goal.noToolCallTurns + 1
    if (goal.noToolCallTurns >= options.noToolCallTurnsBeforePause) {
      pauseDetail = "Paused after repeated auto-continue turns without tool activity."
    }
  }

  const text = partText(assistant.parts)
  const looksThin = outputTokens(assistant) > 0
    ? outputTokens(assistant) < options.noProgressTokenThreshold
    : text.length < options.noProgressTokenThreshold
  goal.noProgressTurns = looksThin ? goal.noProgressTurns + 1 : 0
  if (!pauseDetail && goal.noProgressTurns >= options.noProgressTurnsBeforePause) {
    pauseDetail = "Paused after repeated low-progress auto-continue turns."
  }
  if (pauseDetail) {
    pauseGoal(goal, pauseDetail)
    return true
  }
  return false
}

export function decideContinuation(input: {
  goal: StoredGoal
  observation: GoalObservation
  assistant: SessionMessage | undefined
  options: ResolvedOptions
  canPrompt: boolean
}): ContinuationDecision {
  if (input.goal.budgetWrapupPending) return { type: "await-wrapup" }

  const limit = budgetLimit(input.goal, input.options)
  if (limit) return { type: "budget-limit", detail: limit, sendWrapup: !input.goal.budgetWrapupSent && input.canPrompt }

  if (budgetWrapupNeeded(input.goal, input.options) && !input.goal.budgetWrapupSent && input.canPrompt) {
    return { type: "budget-wrapup" }
  }

  if (applyStallPolicy(input.goal, input.assistant, input.observation, input.options)) {
    return { type: "pause-stall" }
  }

  if (!input.canPrompt) {
    return { type: "pause-unavailable", detail: "Auto-continue unavailable: OpenCode client did not provide session.promptAsync." }
  }

  return { type: "continue" }
}
