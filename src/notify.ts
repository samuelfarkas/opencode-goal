import type { OpencodeClient, StoredGoal, ThreadGoalStatus } from "./types.ts"

export type ToastVariant = "info" | "success" | "warning" | "error"

const TITLE_MAX = 56

// Truncate by Unicode code points, never mid-surrogate-pair, so an objective cut
// inside an emoji can't emit a lone surrogate into the title/toast.
function truncatePoints(text: string, max: number): string {
  const points = Array.from(text)
  if (points.length <= max) return text
  return `${points.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`
}

// Glyph leads the session title so the goal and its state read at a glance in
// the session header and session list. `⟳` keeps active goals easy to scan
// indicator; OpenCode's native working spinner shows the live run state.
function statusGlyph(status: ThreadGoalStatus): string {
  switch (status) {
    case "active":
      return "⟳"
    case "complete":
      return "✓"
    case "blocked":
      return "✗"
    case "paused":
      return "⏸"
    case "budgetLimited":
      return "⏳"
    default:
      return "•"
  }
}

function objectiveText(objective: string): string {
  return objective.replace(/\s+/g, " ").trim()
}

export function goalSessionTitle(goal: StoredGoal): string {
  const glyph = statusGlyph(goal.status)
  return `${glyph} ${truncatePoints(objectiveText(goal.objective), TITLE_MAX - glyph.length - 1)}`
}

// Sets the session title to the goal status glyph + objective. The title is the
// persistent goal indicator; it is (re)written on each status transition.
// Guarded: a host without client.session.update is a silent no-op and a failed
// update never affects the goal loop.
export function updateGoalSessionTitle(client: OpencodeClient | undefined, goal: StoredGoal): void {
  setSessionTitle(client, goal.threadId, goalSessionTitle(goal))
}

// Drops the goal glyph when the goal is cleared, leaving the bare objective so a
// stale "⟳"/"✓" indicator never lingers on a session with no goal behind it.
export function clearGoalSessionTitle(client: OpencodeClient | undefined, goal: StoredGoal): void {
  setSessionTitle(client, goal.threadId, truncatePoints(objectiveText(goal.objective), TITLE_MAX))
}

function setSessionTitle(client: OpencodeClient | undefined, id: string, title: string): void {
  try {
    // Call inline (not via an extracted variable) so the SDK method keeps its
    // `this` receiver — the generated client relies on `this._client`.
    void Promise.resolve(client?.session?.update?.({ path: { id }, body: { title } })).catch(() => {})
  } catch {
    // Title updates must never affect the goal loop.
  }
}

export type GoalToast = {
  message: string
  variant: ToastVariant
}

const OBJECTIVE_MAX = 80

function objectiveLabel(goal: StoredGoal): string {
  return truncatePoints(objectiveText(goal.objective), OBJECTIVE_MAX)
}

// Maps a status transition to a toast. Returns undefined for transitions that
// should stay quiet. The caller only invokes this on an actual status change,
// so same-status updates (token accounting, auto-continue) never notify.
export function goalStatusToast(goal: StoredGoal, previousStatus: ThreadGoalStatus | undefined): GoalToast | undefined {
  const objective = objectiveLabel(goal)
  switch (goal.status) {
    case "active":
      return previousStatus === undefined
        ? { message: `Goal: ${objective}`, variant: "info" }
        : { message: `Goal resumed: ${objective}`, variant: "info" }
    case "complete":
      return { message: `✓ Goal complete: ${objective}`, variant: "success" }
    case "blocked":
      return { message: `⚠ Goal blocked: ${goal.blockedReason ? goal.blockedReason.replace(/\s+/g, " ").trim() : objective}`, variant: "error" }
    case "paused":
      return { message: `Goal paused: ${objective}`, variant: "info" }
    case "budgetLimited":
      return { message: `Goal budget reached: ${objective}`, variant: "warning" }
    default:
      return undefined
  }
}

// Fire-and-forget toast on a goal status change. Fully guarded: a host without
// the documented client.tui.showToast surface is a silent no-op, and a rejected
// request never escapes. The TUI's native working indicator already shows the
// "still running" state during each auto-continue turn.
export function notifyGoalStatusChange(
  client: OpencodeClient | undefined,
  goal: StoredGoal,
  previousStatus: ThreadGoalStatus | undefined,
): void {
  const toast = goalStatusToast(goal, previousStatus)
  if (!toast) return
  try {
    // Call inline (not via an extracted variable) so the SDK method keeps its
    // `this` receiver — the generated client relies on `this._client`.
    void Promise.resolve(client?.tui?.showToast?.({ body: { title: "Goal", message: toast.message, variant: toast.variant } })).catch(() => {})
  } catch {
    // Notifications must never affect the goal loop.
  }
}
