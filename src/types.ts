import type {
  Hooks as OpencodeHooks,
  PluginInput as OpencodePluginInput,
  ToolContext as OpencodeToolContext,
  ToolDefinition as OpencodeToolDefinition,
  tool as opencodeTool,
} from "@opencode-ai/plugin"

type EventHook = NonNullable<OpencodeHooks["event"]>
type OpencodeEvent = Parameters<EventHook>[0]["event"]
type CommandHook = NonNullable<OpencodeHooks["command.execute.before"]>
type ConfigHook = NonNullable<OpencodeHooks["config"]>
type OpencodePart = Parameters<CommandHook>[1]["parts"][number]

export const THREAD_GOAL_STATUSES = ["active", "paused", "blocked", "budgetLimited", "complete"] as const
export const USER_SETTABLE_GOAL_STATUSES = THREAD_GOAL_STATUSES

export type ThreadGoalStatus = (typeof THREAD_GOAL_STATUSES)[number]
export type UserSettableGoalStatus = (typeof USER_SETTABLE_GOAL_STATUSES)[number]

export function isThreadGoalStatus(value: unknown): value is ThreadGoalStatus {
  return typeof value === "string" && THREAD_GOAL_STATUSES.includes(value as ThreadGoalStatus)
}

export function isUserSettableGoalStatus(value: unknown): value is UserSettableGoalStatus {
  return isThreadGoalStatus(value)
}

export type ThreadGoal = {
  threadId: string
  objective: string
  status: ThreadGoalStatus
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
}

export type GoalPolicy = {
  maxTurns: number
  maxDurationSeconds: number
  tokenBudget: number | null
  constraints: string[]
}

export function defaultGoalPolicy(tokenBudget: number | null = null): GoalPolicy {
  return {
    // Zero disables the optional guard, matching Codex's unbounded default.
    maxTurns: 0,
    maxDurationSeconds: 0,
    tokenBudget,
    constraints: [],
  }
}

export type GoalClock = () => number

export type GoalHistoryEntry = {
  timestamp: number
  type: string
  detail: string
}

export type GoalMode = "standard" | "checklist"

export type GoalCheckStatus = "pending" | "satisfied"

export type GoalCheck = {
  id: string
  text: string
  status: GoalCheckStatus
  evidence: string
  updatedAt: number
}

export type AssistantTokenTotal = {
  messageId: string
  total: number
}

export type GoalArchiveStatus = "complete" | "blocked" | "budgetLimited" | "cleared"

export type GoalArchiveCheckSummary = {
  id: string
  status: GoalCheckStatus
}

export type GoalArchiveEntry = {
  id: string
  threadId: string
  objective: string
  status: GoalArchiveStatus
  terminalAt: number
  tokensUsed: number
  timeUsedSeconds: number
  continuationCount: number
  lastEvidence: string
  blockedReason: string
  checks: GoalArchiveCheckSummary[]
}

export type PersistedGoalArchiveV1 = {
  version: 1
  lastSequence: number
  entries: GoalArchiveEntry[]
}

export type StoredGoal = ThreadGoal & {
  policy: GoalPolicy
  mode: GoalMode
  checks: GoalCheck[]
  assistantTokenTotals?: AssistantTokenTotal[]
  continuationCount: number
  activeStartedAtSeconds: number | null
  lastContinueAt: number
  lastProgressAt: number
  usageLimitedUntil: number
  usageLimitedReason: string
  promptFailureCount: number
  noProgressTurns: number
  noToolCallTurns: number
  budgetWrapupSent: boolean
  budgetWrapupPending?: boolean
  budgetWrapupLimitReason?: string
  budgetWrapupBaselineAssistantMessageId?: string
  evaluatorFeedback: string
  completionRejectedCount: number
  lastAssistantText: string
  lastAssistantTextLength: number
  lastAssistantMessageId: string
  lastStallEvaluatedAssistantMessageId?: string
  lastStallEvaluatedAssistantFingerprint?: string
  lastEvidence: string
  blockedReason: string
  history: GoalHistoryEntry[]
}

export type PersistedStateV1 = {
  version: 1
  goals: StoredGoal[]
}

export type PersistedStateV2 = {
  version: 2
  lastSequence: number
  goals: StoredGoal[]
}

export type PersistedState = PersistedStateV1 | PersistedStateV2

export type GoalPluginOptions = {
  commandName?: string
  maxTurns?: number
  maxDurationSeconds?: number
  tokenBudget?: number
  stateFilePath?: string
  persistState?: boolean
  registerTools?: boolean
  autoContinue?: boolean
  idleSettleMs?: number
  minDelayMs?: number
  maxPromptFailures?: number
  usageLimitWaitSeconds?: number
  maxRecentMessages?: number
  noProgressTokenThreshold?: number
  noProgressTurnsBeforePause?: number
  noToolCallTurnsBeforePause?: number
  budgetWrapupRatio?: number
  maxObjectiveLength?: number
  completionMarker?: string
  blockedMarker?: string
  evidenceMarker?: string
  toastNotifications?: boolean
  sessionTitle?: boolean
}

export type TextPart = TextPartInput

export type MessagePart = OpencodePart | TextPart | { type: string; [key: string]: unknown }

export type SessionMessageInfo = {
  id?: string
  sessionID?: string
  role?: string
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: {
      read?: number
      write?: number
    }
  }
}

export type SessionMessage = {
  info?: SessionMessageInfo
  role?: string
  parts?: MessagePart[]
}

type OpencodeClientMethods = OpencodePluginInput["client"]
type PromptInput = Parameters<OpencodeClientMethods["session"]["promptAsync"]>[0]
type PromptPartInput = NonNullable<PromptInput["body"]>["parts"][number]
type TextPartInput = Extract<PromptPartInput, { type: "text" }>
type SessionMessagesInput = Parameters<OpencodeClientMethods["session"]["messages"]>[0]
type SessionStatusInput = Parameters<OpencodeClientMethods["session"]["status"]>[0]
type SessionStatusResult = Awaited<ReturnType<OpencodeClientMethods["session"]["status"]>>
type SessionStatusData = SessionStatusResult["data"]
type SessionUpdateInput = Parameters<OpencodeClientMethods["session"]["update"]>[0]
type TuiShowToastInput = Parameters<OpencodeClientMethods["tui"]["showToast"]>[0]

export type OpencodeClient = {
  session?: {
    messages?: (input: SessionMessagesInput) => Promise<{ data?: SessionMessage[] }>
    status?: (input?: SessionStatusInput) => Promise<{ data?: SessionStatusData; error?: unknown }>
    promptAsync?: (input: {
      path: { id: string }
      body: { parts: TextPart[] }
    }) => Promise<{ error?: unknown } | undefined>
    update?: (input: SessionUpdateInput) => Promise<unknown>
  }
  app?: Partial<Pick<OpencodeClientMethods["app"], "log">>
  tui?: {
    showToast?: (input: TuiShowToastInput) => Promise<unknown>
  }
}

export type PluginInput = Partial<Pick<OpencodePluginInput, "directory" | "worktree">> & {
  client?: OpencodeClient
}

export type EventEnvelope = {
  event?: {
    type?: OpencodeEvent["type"] | string
    properties?: Record<string, unknown>
  }
}

export type Hooks = {
  config?: (input: Parameters<ConfigHook>[0]) => Promise<void>
  "command.execute.before"?: (
    input: Parameters<NonNullable<OpencodeHooks["command.execute.before"]>>[0],
    output: { parts: MessagePart[] },
  ) => Promise<void>
  "experimental.chat.system.transform"?: (
    input: Partial<Parameters<NonNullable<OpencodeHooks["experimental.chat.system.transform"]>>[0]> & { sessionID?: string },
    output: Parameters<NonNullable<OpencodeHooks["experimental.chat.system.transform"]>>[1],
  ) => Promise<void>
  "experimental.session.compacting"?: OpencodeHooks["experimental.session.compacting"]
  "experimental.compaction.autocontinue"?: (
    input: Partial<Parameters<NonNullable<OpencodeHooks["experimental.compaction.autocontinue"]>>[0]> & { sessionID: string },
    output: Parameters<NonNullable<OpencodeHooks["experimental.compaction.autocontinue"]>>[1],
  ) => Promise<void>
  event?: (input: EventEnvelope) => Promise<void>
  tool?: OpencodeHooks["tool"]
}

export type ToolContext = Partial<OpencodeToolContext> & {
  session_id?: string
  session?: { id?: string }
}

export type ToolDefinition = OpencodeToolDefinition
export type ToolFactory = typeof opencodeTool
