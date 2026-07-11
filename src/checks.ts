import {
  GOAL_LIMITS,
  checklistAggregateCodePoints,
  codePointLength,
  truncateCodePoints,
  validateCheckAddition,
  validateCheckEvidence,
  validateEvidence,
} from "./goal-contract.ts"
import type { GoalCheck, StoredGoal } from "./types.ts"

export function missingChecks(goal: StoredGoal): GoalCheck[] {
  return goal.checks.filter((check) => check.status !== "satisfied")
}

export function addCheck(goal: StoredGoal, text: string): GoalCheck {
  const validation = validateCheckAddition(goal, text)
  if (!validation.ok) throw new Error(validation.error)
  const nextNumber = goal.checks.reduce((highest, check) => {
    const match = check.id.match(/^C(\d+)$/)
    return match ? Math.max(highest, Number(match[1])) : highest
  }, 0) + 1
  const check: GoalCheck = {
    id: `C${nextNumber}`,
    text: validation.value,
    status: "pending",
    evidence: "",
    updatedAt: Date.now(),
  }
  goal.checks = [...goal.checks, check]
  return check
}

export function recordCheckEvidence(goal: StoredGoal, checkId: string, evidence: string): GoalCheck | undefined {
  const check = goal.checks.find((item) => item.id.toLowerCase() === checkId.toLowerCase())
  if (!check) return undefined
  const validation = validateCheckEvidence(goal, check.id, evidence)
  if (!validation.ok) throw new Error(validation.error)
  check.status = "satisfied"
  check.evidence = validation.value
  check.updatedAt = Date.now()
  goal.lastEvidence = validation.value
  goal.evaluatorFeedback = ""
  goal.lastAssistantMessageId = ""
  goal.lastAssistantText = ""
  goal.lastAssistantTextLength = 0
  return check
}

export function recordMentionedChecks(goal: StoredGoal, evidence: string): { ok: true } | { ok: false; error: string } {
  const validation = validateEvidence(evidence)
  if (!validation.ok) return validation
  const mentioned = goal.checks.filter((check) => {
    if (check.status === "satisfied") return false
    return new RegExp(`\\b${check.id}\\b`, "i").test(validation.value)
  })
  const aggregate =
    checklistAggregateCodePoints(goal.checks) -
    mentioned.reduce((total, check) => total + codePointLength(check.evidence), 0) +
    mentioned.length * codePointLength(validation.value)
  if (aggregate > GOAL_LIMITS.checklistAggregateCodePoints) {
    return {
      ok: false,
      error: `Checklist evidence is too long in aggregate (${aggregate}/${GOAL_LIMITS.checklistAggregateCodePoints} characters). Put long detail in a file and reference it from the goal.`,
    }
  }
  for (const check of mentioned) recordCheckEvidence(goal, check.id, validation.value)
  return { ok: true }
}

export function completionRejection(goal: StoredGoal): string {
  const missing = missingChecks(goal)
  if (missing.length > 0) {
    return truncateCodePoints(
      `Completion rejected: required checks still need evidence: ${missing.map((check) => `${check.id} ${check.text}`).join("; ")}.`,
      GOAL_LIMITS.detailCodePoints,
    )
  }
  if (goal.mode === "checklist" && goal.checks.length === 0) {
    return "Completion rejected: checklist mode needs explicit checks first. Add checks, record evidence, then try completion again."
  }
  return ""
}
