import { GOAL_LIMITS, codePointLength } from "./goal-contract.ts"

export const DEFAULT_MAX_OBJECTIVE_LENGTH = GOAL_LIMITS.objectiveCodePoints

export type ObjectiveValidation =
  | { ok: true; objective: string }
  | { ok: false; error: string }

export function objectiveLength(objective: string): number {
  return codePointLength(objective)
}

export function validateObjective(rawObjective: string, maxLength: number = DEFAULT_MAX_OBJECTIVE_LENGTH): ObjectiveValidation {
  const objective = rawObjective.trim()
  if (!objective) return { ok: false, error: "Objective is required." }

  const length = objectiveLength(objective)
  if (length > maxLength) {
    return {
      ok: false,
      error: `Objective is too long (${length}/${maxLength} characters). Put long details in a file and reference it from the goal.`,
    }
  }

  return { ok: true, objective }
}
