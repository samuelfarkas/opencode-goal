import { completionRejection, recordMentionedChecks } from "./checks.ts"
import { GOAL_LIMITS, truncateCodePoints, validateBlocker, validateEvidence } from "./goal-contract.ts"
import { markerVerdict } from "./markers.ts"
import { messageId, partText } from "./parts.ts"
import { touchGoal } from "./store.ts"
import type { SessionMessage, StoredGoal } from "./types.ts"

export type GoalObservation = "unchanged" | "changed" | "terminal"

export type GoalObservationConfig = {
  completionMarker: string
  blockedMarker: string
  evidenceMarker: string
}

export function observeAssistant(goal: StoredGoal, assistant: SessionMessage | undefined, config: GoalObservationConfig): GoalObservation {
  const text = partText(assistant?.parts)
  if (!text) return "unchanged"

  const assistantId = messageId(assistant)
  const textPreview = truncateCodePoints(text, GOAL_LIMITS.assistantCheckpointCodePoints)
  if (
    assistantId === goal.lastAssistantMessageId &&
    textPreview === goal.lastAssistantText &&
    text.length === goal.lastAssistantTextLength
  ) {
    return "unchanged"
  }

  goal.lastAssistantMessageId = assistantId
  goal.lastAssistantText = textPreview
  goal.lastAssistantTextLength = text.length
  goal.lastProgressAt = Math.floor(Date.now() / 1000)

  const verdict = markerVerdict(text, config)
  if (verdict.status === "complete") {
    const evidence = validateEvidence(verdict.evidence)
    if (!evidence.ok) {
      touchGoal(goal, "marker-rejected", evidence.error)
      return "changed"
    }
    const mentioned = recordMentionedChecks(goal, evidence.value)
    if (!mentioned.ok) {
      touchGoal(goal, "marker-rejected", mentioned.error)
      return "changed"
    }
    goal.lastEvidence = evidence.value
    const rejection = completionRejection(goal)
    if (rejection) {
      goal.evaluatorFeedback = rejection
      goal.completionRejectedCount += 1
      touchGoal(goal, "completion-rejected", rejection)
      return "changed"
    }
    goal.status = "complete"
    goal.evaluatorFeedback = ""
    touchGoal(goal, "complete", evidence.value)
    return "terminal"
  }
  if (verdict.status === "blocked") {
    const blocker = validateBlocker(verdict.reason)
    if (!blocker.ok) {
      touchGoal(goal, "marker-rejected", blocker.error)
      return "changed"
    }
    goal.status = "blocked"
    goal.blockedReason = blocker.value
    touchGoal(goal, "blocked", blocker.value)
    return "terminal"
  }
  if (verdict.status === "missing-evidence" || verdict.status === "missing-blocker") {
    touchGoal(goal, "marker-rejected", verdict.status)
    return "changed"
  }
  return "changed"
}
