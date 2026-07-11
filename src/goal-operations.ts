import { addCheck, completionRejection, recordCheckEvidence } from "./checks.ts"
import { validateBlocker, validateEvidence, validateIdentifier, validateInitialChecks } from "./goal-contract.ts"
import { validateObjective } from "./objective.ts"
import { createGoal, touchGoal } from "./store.ts"
import type { ResolvedOptions } from "./options.ts"
import type { GoalCheck, GoalClock, GoalMode, GoalPolicy, StoredGoal, UserSettableGoalStatus } from "./types.ts"

export type GoalStatusUpdate = {
  status: UserSettableGoalStatus
  evidence?: string
  blocker?: string
  requireEvidence?: boolean
  requireBlocker?: boolean
}

export type GoalOperationResult =
  | { ok: true; goal: StoredGoal }
  | { ok: false; error: string }

export function createThreadGoal(input: {
  threadId: string
  objective: string
  tokenBudget: number | null
  policy?: GoalPolicy
  mode?: GoalMode
  checks?: readonly string[]
  clock?: GoalClock
}): StoredGoal {
  const threadId = validateIdentifier(input.threadId, "Thread id")
  if (!threadId.ok) throw new Error(threadId.error)
  const objective = validateObjective(input.objective)
  if (!objective.ok) throw new Error(objective.error)
  const checks = validateInitialChecks(input.checks ?? [])
  if (!checks.ok) throw new Error(checks.error)
  return createGoal(
    threadId.value,
    objective.objective,
    input.tokenBudget,
    input.mode ?? "standard",
    checks.value,
    input.clock,
    input.policy,
  )
}

export function addGoalCheck(goal: StoredGoal, text: string, clock?: GoalClock): GoalCheck {
  goal.mode = "checklist"
  const check = addCheck(goal, text)
  touchGoal(goal, "check", `Added ${check.id}: ${check.text}`, clock)
  return check
}

export function satisfyGoalCheck(goal: StoredGoal, checkId: string, evidence: string, clock?: GoalClock): GoalCheck | undefined {
  const check = recordCheckEvidence(goal, checkId, evidence)
  if (!check) return undefined
  touchGoal(goal, "evidence", `Satisfied ${check.id}: ${evidence}`, clock)
  return check
}

export function setGoalMode(goal: StoredGoal, mode: GoalMode, clock?: GoalClock): void {
  goal.mode = mode
  touchGoal(goal, "mode", `Goal mode set to ${goal.mode}.`, clock)
}

export function pauseGoal(goal: StoredGoal, detail: string, clock?: GoalClock): void {
  clearBudgetWrapupPending(goal)
  goal.status = "paused"
  touchGoal(goal, "paused", detail, clock)
}

export function resumeGoal(goal: StoredGoal, detail: string, clock?: GoalClock): void {
  clearBudgetWrapupPending(goal)
  goal.status = "active"
  goal.blockedReason = ""
  goal.usageLimitedUntil = 0
  goal.usageLimitedReason = ""
  touchGoal(goal, "resumed", detail, clock)
}

export function setGoalStatus(goal: StoredGoal, update: GoalStatusUpdate, clock?: GoalClock): GoalOperationResult {
  if (update.status === "complete") {
    const rawEvidence = update.evidence?.trim() ?? ""
    if (update.requireEvidence && !rawEvidence) return { ok: false, error: "Completion requires evidence." }
    const evidence = rawEvidence ? validateEvidence(rawEvidence) : { ok: true as const, value: "" }
    if (!evidence.ok) return { ok: false, error: evidence.error }
    if (evidence.value) goal.lastEvidence = evidence.value
    const rejection = completionRejection(goal)
    if (rejection) return { ok: false, error: rejection }
    goal.evaluatorFeedback = ""
  }

  if (update.status === "blocked") {
    const rawBlocker = update.blocker?.trim() ?? ""
    if (update.requireBlocker && !rawBlocker) return { ok: false, error: "Blocked status requires a concrete blocker." }
    const blocker = rawBlocker ? validateBlocker(rawBlocker) : { ok: true as const, value: "" }
    if (!blocker.ok) return { ok: false, error: blocker.error }
    if (blocker.value) goal.blockedReason = blocker.value
  }

  if (update.status === "active") {
    goal.blockedReason = ""
    goal.usageLimitedUntil = 0
    goal.usageLimitedReason = ""
  }

  clearBudgetWrapupPending(goal)
  goal.status = update.status
  touchGoal(goal, "status", `Goal status set to ${update.status}.`, clock)
  return { ok: true, goal }
}

export function markBudgetLimited(goal: StoredGoal, detail: string, clock?: GoalClock): void {
  clearBudgetWrapupPending(goal)
  goal.status = "budgetLimited"
  touchGoal(goal, "budgetLimited", detail, clock)
}

export function markBudgetWrapupPending(
  goal: StoredGoal,
  detail: string,
  baselineAssistantMessageId: string,
  clock?: GoalClock,
): void {
  goal.budgetWrapupPending = true
  goal.budgetWrapupLimitReason = detail
  goal.budgetWrapupBaselineAssistantMessageId = baselineAssistantMessageId
  touchGoal(goal, "budgetWrapupPending", "Waiting for the accepted final budget wrap-up response.", clock)
}

export function clearBudgetWrapupPending(goal: StoredGoal): void {
  goal.budgetWrapupPending = false
  goal.budgetWrapupLimitReason = ""
  goal.budgetWrapupBaselineAssistantMessageId = ""
}

export function finishBudgetWrapup(
  goal: StoredGoal,
  responseAssistantMessageId: string,
  clock?: GoalClock,
): void {
  const limitReason = goal.budgetWrapupLimitReason || "Budget limit reached."
  clearBudgetWrapupPending(goal)
  if (goal.status === "complete" || goal.status === "blocked") {
    touchGoal(goal, "budgetWrapupObserved", `Observed final budget wrap-up response ${responseAssistantMessageId}.`, clock)
    return
  }
  markBudgetLimited(goal, limitReason, clock)
}

export function interruptBudgetWrapup(goal: StoredGoal, detail: string, clock?: GoalClock): void {
  const limitReason = goal.budgetWrapupLimitReason || "Budget limit reached."
  clearBudgetWrapupPending(goal)
  touchGoal(goal, "budgetWrapupInterrupted", detail, clock)
  markBudgetLimited(goal, limitReason, clock)
}

export function markAutoContinueSent(goal: StoredGoal, _options: Pick<ResolvedOptions, "maxTurns">, mode: "continue" | "wrapup", clock?: GoalClock): void {
  const count = goal.policy.maxTurns > 0
    ? `${goal.continuationCount}/${goal.policy.maxTurns}`
    : `${goal.continuationCount}`
  touchGoal(goal, mode === "wrapup" ? "budgetWrapup" : "autoContinue", `Sent continuation ${count}.`, clock)
}

export function markAutoContinueRecovered(goal: StoredGoal, clock?: GoalClock): void {
  goal.promptFailureCount = 0
  touchGoal(goal, "autoContinueRecovered", "Auto-continue prompt succeeded after previous failures.", clock)
}

export function recordPromptFailure(goal: StoredGoal, detail: string, maxPromptFailures: number, clock?: GoalClock): void {
  goal.promptFailureCount += 1
  if (goal.promptFailureCount >= maxPromptFailures) {
    goal.status = "paused"
    touchGoal(goal, "paused", `Auto-continue failed ${goal.promptFailureCount} times: ${detail}`, clock)
    return
  }
  touchGoal(goal, "autoContinueRetry", `Auto-continue failed ${goal.promptFailureCount}/${maxPromptFailures}: ${detail}`, clock)
}
