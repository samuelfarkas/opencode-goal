import { GoalStore } from "./store.ts"
import { addGoalCheck, createThreadGoal, satisfyGoalCheck, setGoalStatus } from "./goal-operations.ts"
import { goalToolJson, validateCheckAddition, validateCheckEvidence } from "./goal-contract.ts"
import { validateObjective } from "./objective.ts"
import type { ResolvedOptions } from "./options.ts"
import { goalPolicyDefaults } from "./options.ts"
import { USER_SETTABLE_GOAL_STATUSES, isUserSettableGoalStatus } from "./types.ts"
import type { ToolContext, ToolDefinition, ToolFactory, UserSettableGoalStatus } from "./types.ts"

export async function loadToolFactory(): Promise<ToolFactory | undefined> {
  try {
    const module: typeof import("@opencode-ai/plugin") = await import("@opencode-ai/plugin")
    return module.tool
  } catch {
    return undefined
  }
}

function sessionId(context: ToolContext): string | undefined {
  return context.sessionID ?? context.session_id ?? context.session?.id
}

function readString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === "string" ? value.trim() : ""
}

function readStatus(args: Record<string, unknown>): UserSettableGoalStatus | undefined {
  const value = args.status
  return isUserSettableGoalStatus(value) ? value : undefined
}

function missingSession(): string {
  return "No session id was provided by OpenCode for this tool call."
}

export function buildTools(
  tool: ToolFactory,
  store: GoalStore,
  options?: Partial<Pick<ResolvedOptions, "maxObjectiveLength" | "evidenceMarker" | "completionMarker" | "blockedMarker" | "tokenBudget" | "maxTurns" | "maxDurationSeconds">>,
): Record<string, ToolDefinition> {
  const stringSchema = tool.schema.string()
  const optionalStringSchema = tool.schema.optional(stringSchema)
  const statusSchema = tool.schema.enum(USER_SETTABLE_GOAL_STATUSES)

  return {
    get_goal: tool({
      description: "Read the current session goal. Use before deciding whether a goal is active.",
      args: {},
      async execute(_args, context) {
        const id = sessionId(context)
        if (!id) return missingSession()
        const goal = store.read(id)?.goal
        return goal ? goalToolJson(goal) : "No active goal."
      },
    }),
    set_goal: tool({
      description: "Set or replace the current session goal ONLY when the user explicitly asks for a goal.",
      args: { objective: stringSchema },
      async execute(args, context) {
        const id = sessionId(context)
        if (!id) return missingSession()
        const validation = validateObjective(readString(args, "objective"), options?.maxObjectiveLength)
        if (!validation.ok) return validation.error
        const goal = createThreadGoal({
          threadId: id,
          objective: validation.objective,
          tokenBudget: options?.tokenBudget ?? null,
          policy: goalPolicyDefaults({
            maxTurns: options?.maxTurns ?? 10,
            maxDurationSeconds: options?.maxDurationSeconds ?? 15 * 60,
            tokenBudget: options?.tokenBudget ?? null,
          }),
        })
        await store.replace(goal)
        return `New active goal: ${validation.objective}`
      },
    }),
    update_goal: tool({
      description: "Update the current goal status. Completion requires concrete evidence; blocked requires a blocker. Provider usage waits are tracked automatically while the goal remains active.",
      args: { status: statusSchema, evidence: optionalStringSchema, blocker: optionalStringSchema },
      async execute(args, context) {
        const id = sessionId(context)
        if (!id) return missingSession()
        const current = store.read(id)
        if (!current) return "No active goal to update."
        const status = readStatus(args)
        if (!status) return "A valid status is required."
        const updated = await store.update(id, current.revision, (draft) => {
          const result = setGoalStatus(draft, {
            status,
            evidence: readString(args, "evidence"),
            blocker: readString(args, "blocker"),
            requireEvidence: true,
            requireBlocker: true,
          })
          return { commit: result.ok, value: result }
        })
        if (!updated.applied) {
          if (updated.reason === "unchanged") return updated.value.ok ? "Goal status was unchanged." : updated.value.error
          return "Goal changed before the update; retry the tool call."
        }
        const terminalNote =
          status === "complete"
            ? `\n\nGoal status is complete. In your final response, include ${options?.evidenceMarker ?? "[goal:evidence]"} with concrete evidence, then ${options?.completionMarker ?? "[goal:complete]"} on its own final line.`
            : status === "blocked"
            ? `\n\nGoal status is blocked. In your final response, state the concrete blocker immediately before ${options?.blockedMarker ?? "[goal:blocked]"} on its own final line.`
            : ""
        return `${goalToolJson(updated.snapshot.goal)}${terminalNote}`
      },
    }),
    add_goal_check: tool({
      description: "Add a concrete check to the active goal. Use this for checklist mode or high-risk long-running goals.",
      args: { text: stringSchema },
      async execute(args, context) {
        const id = sessionId(context)
        if (!id) return missingSession()
        const current = store.read(id)
        if (!current) return "No active goal to update."
        const text = readString(args, "text")
        const validation = validateCheckAddition(current.goal, text)
        if (!validation.ok) return validation.error
        const updated = await store.update(id, current.revision, (draft) => {
          addGoalCheck(draft, validation.value)
          return { commit: true, value: undefined }
        })
        return updated.applied
          ? goalToolJson(updated.snapshot.goal)
          : "Goal changed before the update; retry the tool call."
      },
    }),
    record_goal_check_evidence: tool({
      description: "Record concrete evidence for a goal check and mark it satisfied.",
      args: { check_id: stringSchema, evidence: stringSchema },
      async execute(args, context) {
        const id = sessionId(context)
        if (!id) return missingSession()
        const current = store.read(id)
        if (!current) return "No active goal to update."
        const checkId = readString(args, "check_id")
        const evidence = readString(args, "evidence")
        if (!checkId || !evidence) return "check_id and evidence are required."
        const validation = validateCheckEvidence(current.goal, checkId, evidence)
        if (!validation.ok) return validation.error
        const updated = await store.update(id, current.revision, (draft) => {
          const check = satisfyGoalCheck(draft, checkId, validation.value)
          return { commit: Boolean(check), value: Boolean(check) }
        })
        if (!updated.applied) {
          if (updated.reason === "unchanged") return `Unknown check: ${checkId}`
          return "Goal changed before the update; retry the tool call."
        }
        const goal = updated.snapshot.goal
        const nextStep =
          goal.status === "active" && goal.checks.length > 0 && goal.checks.every((item) => item.status === "satisfied")
            ? "\n\nAll checks are satisfied. If the objective is verified, call update_goal with status \"complete\" and concrete evidence before your final marker response."
            : ""
        return `${goalToolJson(goal)}${nextStep}`
      },
    }),
    clear_goal: tool({
      description: "Clear the current session goal.",
      args: {},
      async execute(_args, context) {
        const id = sessionId(context)
        if (!id) return missingSession()
        return (await store.clear(id)) ? "Goal cleared." : "No active goal to clear."
      },
    }),
  }
}
