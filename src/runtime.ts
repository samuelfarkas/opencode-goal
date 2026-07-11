import { isTerminalStatus } from "./markers.ts"
import { markerVerdict } from "./markers.ts"
import { decideContinuation, pauseForUserIntervention } from "./continuation.ts"
import { normalizeGoalEvent } from "./goal-events.ts"
import {
  clearBudgetWrapupPending,
  finishBudgetWrapup,
  interruptBudgetWrapup,
  markAutoContinueRecovered,
  markAutoContinueSent,
  markBudgetLimited,
  markBudgetWrapupPending,
  pauseGoal,
  recordPromptFailure,
} from "./goal-operations.ts"
import { observeAssistant } from "./goal-observation.ts"
import type { ResolvedOptions } from "./options.ts"
import { applyAssistantTokenTotal, latestAssistant, messageId, messageRole, partText, textPart } from "./parts.ts"
import { continuationPrompt } from "./prompt.ts"
import { isRecord } from "./records.ts"
import { type GoalSnapshot, type GoalStore, touchGoal } from "./store.ts"
import { applyUsageLimitWait, clearUsageLimitWait, promptErrorDetail, promptErrorFromUnknown, usageWaitRemaining } from "./usage-window.ts"
import type { PromptError, UsageLimitWait } from "./usage-window.ts"
import type { EventEnvelope, PluginInput, SessionMessage, StoredGoal } from "./types.ts"

const SERVICE = "opencode-goal"
const PART_SYNC_DEBOUNCE_MS = 150

export type RuntimeSchedulerHooks = {
  setTimeout?: (callback: () => void, milliseconds: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

type PendingReconciliation = {
  messages: Map<string, SessionMessage>
  transcript: boolean
}

function mergeStreamingMessage(previous: SessionMessage | undefined, next: SessionMessage): SessionMessage {
  if (!previous) return structuredClone(next)
  const merged = structuredClone(next)
  if (!merged.info && previous.info) merged.info = structuredClone(previous.info)
  const previousTokens = previous.info?.tokens
  if (previousTokens && merged.info) {
    if (!merged.info.tokens) merged.info.tokens = structuredClone(previousTokens)
    else {
      for (const key of ["input", "output", "reasoning"] as const) {
        const earlier = previousTokens[key]
        const current = merged.info.tokens[key]
        if (earlier !== undefined && (current === undefined || earlier > current)) merged.info.tokens[key] = earlier
      }
      if (previousTokens.cache) {
        merged.info.tokens.cache = {
          read: Math.max(previousTokens.cache.read ?? 0, merged.info.tokens.cache?.read ?? 0),
          write: Math.max(previousTokens.cache.write ?? 0, merged.info.tokens.cache?.write ?? 0),
        }
      }
    }
  }
  return merged
}

type IdleAction =
  | { type: "stop" }
  | { type: "budget-limit"; detail: string; sendWrapup: boolean; baselineAssistantMessageId: string }
  | { type: "budget-wrapup" }
  | { type: "continue" }

type PromptOutcome =
  | { type: "accepted" }
  | { type: "usage-limit"; wait: UsageLimitWait }
  | { type: "failure"; detail: string }

type ContinuationSendOutcome =
  | { type: "skipped" }
  | { type: "accepted"; snapshot: GoalSnapshot }
  | { type: "usage-limit"; snapshot: GoalSnapshot }
  | { type: "failure"; snapshot: GoalSnapshot }

type HardBudgetWrapup = {
  limitReason: string
  baselineAssistantMessageId: string
}

type PendingWrapupResponse =
  | { type: "response"; message: SessionMessage; messageId: string }
  | { type: "none" }
  | { type: "ambiguous" }

export type ReconciliationOutcome =
  | { type: "updated" }
  | { type: "unchanged" }
  | { type: "unavailable"; detail: string }

type TranscriptOutcome =
  | { type: "available"; messages: SessionMessage[] }
  | { type: "unavailable"; detail: string }

function nowMilliseconds(): number {
  return Date.now()
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))
}

function sameRevision(left: GoalSnapshot, right: GoalSnapshot): boolean {
  return (
    left.revision.generation === right.revision.generation &&
    left.revision.revision === right.revision.revision
  )
}

function pendingWrapupResponse(goal: StoredGoal, messages: readonly SessionMessage[]): PendingWrapupResponse {
  const assistants = messages.filter((message) => messageRole(message) === "assistant")
  const baselineId = goal.budgetWrapupBaselineAssistantMessageId ?? ""
  if (!baselineId) {
    const response = assistants.at(-1)
    if (!response) return { type: "none" }
    const responseId = messageId(response)
    return responseId
      ? { type: "response", message: response, messageId: responseId }
      : { type: "ambiguous" }
  }

  const baselineIndex = assistants.findIndex((message) => messageId(message) === baselineId)
  if (baselineIndex < 0) return { type: "ambiguous" }
  const response = assistants.at(-1)
  if (!response || baselineIndex === assistants.length - 1) return { type: "none" }
  const responseId = messageId(response)
  return responseId
    ? { type: "response", message: response, messageId: responseId }
    : { type: "ambiguous" }
}

async function log(input: PluginInput, level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>): Promise<void> {
  const body =
    extra === undefined
      ? { service: SERVICE, level, message }
      : { service: SERVICE, level, message, extra }
  try {
    await input.client?.app?.log?.({ body })
  } catch {
    // Host logging is a non-critical observer and must not affect lifecycle state.
  }
}

export class GoalRuntime {
  readonly #input: PluginInput
  readonly #store: GoalStore
  readonly #options: ResolvedOptions
  readonly #inFlight = new Set<string>()
  readonly #syncTimers = new Map<string, unknown>()
  readonly #syncFlushes = new Map<string, Promise<void>>()
  readonly #pendingReconciliations = new Map<string, PendingReconciliation>()
  readonly #activityEpochs = new Map<string, number>()
  readonly #scheduler: Required<RuntimeSchedulerHooks>

  constructor(input: PluginInput, store: GoalStore, options: ResolvedOptions, scheduler: RuntimeSchedulerHooks = {}) {
    this.#input = input
    this.#store = store
    this.#options = options
    this.#scheduler = {
      setTimeout: scheduler.setTimeout ?? ((callback, milliseconds) => setTimeout(callback, milliseconds)),
      clearTimeout: scheduler.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    }
    this.#store.setLifecycleFlush((threadId) => this.flushSession(threadId))
  }

  async handleEvent(input: EventEnvelope): Promise<void> {
    const event = normalizeGoalEvent(input)
    if (!event) return
    if (event.type === "messageUpdated") {
      this.#recordActivity(event.sessionID)
      if (messageRole(event.message) !== "assistant") return
      if (event.sessionID && this.#isTerminalMarkerCandidate(event.message)) {
        await this.flushSession(event.sessionID)
        await this.#handleMessageUpdated(event.sessionID, event.message)
      } else {
        this.#scheduleSync(event.sessionID, event.message, false)
      }
      return
    }
    if (event.type === "partChanged") {
      this.#recordActivity(event.sessionID)
      this.#scheduleSync(event.sessionID, undefined, true)
      return
    }
    if (event.type === "activity") {
      this.#recordActivity(event.sessionID)
      return
    }
    if (event.type === "promptError") {
      await this.flushSession(event.sessionID)
      await this.#handleSessionError(event.sessionID, event.error)
      return
    }
    if (event.type === "sessionDeleted") {
      await this.flushSession(event.sessionID)
      if (event.sessionID) await this.#store.clear(event.sessionID, false)
      return
    }
    const activityEpoch = event.sessionID ? this.#activityEpoch(event.sessionID) : 0
    await this.flushSession(event.sessionID)
    await this.#handleIdle(event.sessionID, activityEpoch)
  }

  #isTerminalMarkerCandidate(message: SessionMessage | undefined): boolean {
    const text = partText(message?.parts)
    if (!text) return false
    const verdict = markerVerdict(text, this.#options)
    return verdict.status === "complete" || verdict.status === "blocked"
  }

  #recordActivity(sessionID: string | undefined): void {
    if (!sessionID) return
    if (!this.#store.read(sessionID)) {
      this.#activityEpochs.delete(sessionID)
      return
    }
    this.#activityEpochs.set(sessionID, (this.#activityEpochs.get(sessionID) ?? 0) + 1)
  }

  #activityEpoch(sessionID: string): number {
    return this.#activityEpochs.get(sessionID) ?? 0
  }

  #activityUnchanged(sessionID: string, expected: number): boolean {
    return this.#activityEpoch(sessionID) === expected
  }

  async #readTranscript(sessionID: string, limit: number): Promise<TranscriptOutcome> {
    const session = this.#input.client?.session
    const messages = session?.messages
    if (!session || !messages) {
      const detail = "OpenCode client did not provide session.messages."
      await log(this.#input, "warn", "Transcript reconciliation unavailable", { error: detail })
      return { type: "unavailable", detail }
    }

    try {
      const response = await messages.call(session, {
        path: { id: sessionID },
        query: { limit },
      })
      return { type: "available", messages: response.data ?? [] }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await log(this.#input, "warn", "Transcript reconciliation unavailable", { error: detail })
      return { type: "unavailable", detail }
    }
  }

  async syncSession(sessionID: string | undefined): Promise<ReconciliationOutcome> {
    if (!sessionID) return { type: "unchanged" }
    const current = this.#store.read(sessionID)
    if (!current || current.goal.status !== "active") return { type: "unchanged" }
    const transcript = await this.#readTranscript(sessionID, this.#options.maxRecentMessages)
    if (transcript.type === "unavailable") return transcript
    const updated = await this.#store.update(sessionID, current.revision, (draft) => {
      let changed = false
      for (const message of transcript.messages) {
        changed = applyAssistantTokenTotal(draft, message, this.#options.maxRecentMessages).changed || changed
      }
      if (draft.budgetWrapupPending) return { commit: changed, value: undefined }
      const observation = observeAssistant(draft, latestAssistant(transcript.messages), this.#options)
      if (observation !== "unchanged" && draft.status === "active") {
        clearUsageLimitWait(draft, "Observed new assistant output after provider usage wait.")
      }
      return { commit: changed || observation !== "unchanged", value: undefined }
    })
    return updated.applied ? { type: "updated" } : { type: "unchanged" }
  }

  async #handleMessageUpdated(sessionID: string | undefined, message: SessionMessage | undefined): Promise<void> {
    await this.#handleMessagesUpdated(sessionID, message ? [message] : [])
  }

  async #handleMessagesUpdated(sessionID: string | undefined, messages: readonly SessionMessage[]): Promise<void> {
    if (!sessionID) return
    const current = this.#store.read(sessionID)
    if (!current || isTerminalStatus(current.goal.status)) return

    const needsSync =
      current.goal.status === "active" &&
      !current.goal.budgetWrapupPending &&
      messages.some((message) => messageRole(message) === "assistant" && (!message.parts || !messageId(message)))
    const updated = await this.#store.update(sessionID, current.revision, (draft) => {
      let changed = false
      let tokenDelta = 0
      for (const message of messages) {
        const tokenUpdate = applyAssistantTokenTotal(draft, message, this.#options.maxRecentMessages)
        changed = tokenUpdate.changed || changed
        tokenDelta += tokenUpdate.delta
      }
      if (tokenDelta > 0) touchGoal(draft, "tokens", "Observed message token accounting.")

      const message = messages.at(-1)
      if (
        draft.status === "active" &&
        !draft.budgetWrapupPending &&
        messageRole(message) === "assistant" &&
        message?.parts
      ) {
        const observation = observeAssistant(draft, message, this.#options)
        if (observation !== "unchanged" && draft.status === "active") {
          changed = clearUsageLimitWait(draft, "Received new assistant output after provider usage wait.") || changed
        }
        changed = changed || observation !== "unchanged"
      }
      return { commit: changed, value: undefined }
    })

    if (needsSync && (updated.applied || updated.reason === "unchanged")) await this.syncSession(sessionID)
  }

  #scheduleSync(
    sessionID: string | undefined,
    message: SessionMessage | undefined,
    transcript: boolean,
  ): void {
    if (!sessionID) return
    const current = this.#pendingReconciliations.get(sessionID) ?? { messages: new Map(), transcript: false }
    if (message) {
      const id = messageId(message)
      const key = id || "__idless__"
      current.messages.set(key, mergeStreamingMessage(current.messages.get(key), message))
      if (!id) current.transcript = true
      while (current.messages.size > this.#options.maxRecentMessages) {
        const oldest = current.messages.keys().next().value
        if (typeof oldest !== "string") break
        current.messages.delete(oldest)
      }
    }
    current.transcript = transcript || current.transcript
    this.#pendingReconciliations.set(sessionID, current)
    if (this.#syncTimers.has(sessionID)) return
    const timer = this.#scheduler.setTimeout(() => {
      void this.#startScheduledFlush(sessionID).catch(async (error: unknown) => {
        await log(this.#input, "error", "Deferred transcript reconciliation failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, PART_SYNC_DEBOUNCE_MS)
    const maybeTimer: unknown = timer
    if (isRecord(maybeTimer) && typeof maybeTimer.unref === "function") maybeTimer.unref()
    this.#syncTimers.set(sessionID, timer)
  }

  async #flushScheduled(sessionID: string): Promise<void> {
    const timer = this.#syncTimers.get(sessionID)
    if (timer !== undefined) this.#scheduler.clearTimeout(timer)
    this.#syncTimers.delete(sessionID)
    const pending = this.#pendingReconciliations.get(sessionID)
    this.#pendingReconciliations.delete(sessionID)
    if (!pending) return
    if (pending.messages.size > 0) await this.#handleMessagesUpdated(sessionID, [...pending.messages.values()])
    if (pending.transcript) await this.syncSession(sessionID)
  }

  #startScheduledFlush(sessionID: string): Promise<void> {
    const active = this.#syncFlushes.get(sessionID)
    if (active) return active
    const flush = this.#flushScheduled(sessionID).finally(() => {
      if (this.#syncFlushes.get(sessionID) === flush) this.#syncFlushes.delete(sessionID)
    })
    this.#syncFlushes.set(sessionID, flush)
    return flush
  }

  async flushSession(sessionID: string | undefined): Promise<void> {
    if (!sessionID) return
    while (
      this.#syncFlushes.has(sessionID) ||
      this.#syncTimers.has(sessionID) ||
      this.#pendingReconciliations.has(sessionID)
    ) {
      await this.#startScheduledFlush(sessionID)
    }
  }

  async dispose(): Promise<void> {
    const sessions = new Set([
      ...this.#syncTimers.keys(),
      ...this.#pendingReconciliations.keys(),
      ...this.#syncFlushes.keys(),
    ])
    for (const sessionID of sessions) await this.#flushScheduled(sessionID)
    this.#store.setLifecycleFlush(undefined)
  }

  async #handleIdle(sessionID: string | undefined, initialActivityEpoch?: number): Promise<void> {
    if (!sessionID || this.#inFlight.has(sessionID) || !this.#options.autoContinue) return
    const initial = this.#store.read(sessionID)
    if (!initial || initial.goal.status !== "active") return
    const activityEpoch = initialActivityEpoch ?? this.#activityEpoch(sessionID)

    this.#inFlight.add(sessionID)
    try {
      await sleep(this.#options.idleSettleMs)
      if (!this.#activityUnchanged(sessionID, activityEpoch)) return
      const current = this.#store.read(sessionID)
      if (!current || current.goal.status !== "active") return
      if (usageWaitRemaining(current.goal) > 0) return

      const transcript = await this.#readTranscript(
        sessionID,
        current.goal.budgetWrapupPending
          ? Math.max(2, this.#options.maxRecentMessages)
          : this.#options.maxRecentMessages,
      )
      if (transcript.type === "unavailable") return
      if (!this.#activityUnchanged(sessionID, activityEpoch)) return
      const messages = transcript.messages
      const evaluated = await this.#store.update<IdleAction>(sessionID, current.revision, (draft) => {
        let changed = false
        for (const message of messages) {
          changed = applyAssistantTokenTotal(draft, message, this.#options.maxRecentMessages).changed || changed
        }
        changed = clearUsageLimitWait(draft, "Provider usage window wait elapsed.") || changed
        if (pauseForUserIntervention(draft, messages)) {
          clearBudgetWrapupPending(draft)
          return { commit: true, value: { type: "stop" } satisfies IdleAction }
        }

        const assistant = latestAssistant(messages)
        if (draft.budgetWrapupPending) {
          const pending = pendingWrapupResponse(draft, messages)
          if (pending.type === "response") {
            observeAssistant(draft, pending.message, this.#options)
            finishBudgetWrapup(draft, pending.messageId)
          } else {
            const detail = pending.type === "ambiguous"
              ? "Final budget wrap-up was accepted, but its response could not be correlated after restart or transcript truncation."
              : "Final budget wrap-up was accepted, but no later assistant response was present when the session became idle."
            interruptBudgetWrapup(draft, detail)
          }
          return { commit: true, value: { type: "stop" } satisfies IdleAction }
        }

        const observation = observeAssistant(draft, assistant, this.#options)
        changed = changed || observation !== "unchanged"
        if (observation === "terminal") {
          return { commit: true, value: { type: "stop" } satisfies IdleAction }
        }

        const previousStallMessageId = draft.lastStallEvaluatedAssistantMessageId
        const previousStallFingerprint = draft.lastStallEvaluatedAssistantFingerprint
        const decision = decideContinuation({
          goal: draft,
          assistant,
          observation,
          options: this.#options,
          canPrompt: Boolean(this.#input.client?.session?.promptAsync),
        })
        const stallEvaluated =
          draft.lastStallEvaluatedAssistantMessageId !== previousStallMessageId ||
          draft.lastStallEvaluatedAssistantFingerprint !== previousStallFingerprint
        if (decision.type === "budget-limit") {
          const baselineAssistantMessageId = messageId(assistant)
          return {
            commit: changed,
            value: {
              type: "budget-limit",
              detail: decision.detail,
              sendWrapup: decision.sendWrapup && (!assistant || Boolean(baselineAssistantMessageId)),
              baselineAssistantMessageId,
            } satisfies IdleAction,
          }
        }
        if (decision.type === "budget-wrapup") {
          return { commit: changed, value: { type: "budget-wrapup" } satisfies IdleAction }
        }
        if (decision.type === "pause-stall") {
          return { commit: true, value: { type: "stop" } satisfies IdleAction }
        }
        if (decision.type === "pause-unavailable") {
          pauseGoal(draft, decision.detail)
          return { commit: true, value: { type: "stop" } satisfies IdleAction }
        }
        if (decision.type === "await-wrapup") {
          return { commit: changed, value: { type: "stop" } satisfies IdleAction }
        }
        return { commit: changed || stallEvaluated, value: { type: "continue" } satisfies IdleAction }
      })

      if (!evaluated.applied && evaluated.reason !== "unchanged") return
      if (!this.#activityUnchanged(sessionID, activityEpoch)) return
      const action = evaluated.value
      let ready = evaluated.snapshot

      if (action.type === "stop") return
      if (action.type === "budget-limit") {
        if (action.sendWrapup) {
          await this.#sendContinuation(ready, "wrapup", activityEpoch, {
            limitReason: action.detail,
            baselineAssistantMessageId: action.baselineAssistantMessageId,
          })
          return
        }
        await this.#store.update(sessionID, ready.revision, (draft) => {
          markBudgetLimited(draft, action.detail)
          return { commit: true, value: undefined }
        })
        return
      }
      if (action.type === "budget-wrapup") {
        await this.#sendContinuation(ready, "wrapup", activityEpoch)
        return
      }

      const afterCooldown = await this.#waitForCooldown(ready, activityEpoch)
      if (!afterCooldown) return
      await this.#sendContinuation(afterCooldown, "continue", activityEpoch)
    } finally {
      this.#inFlight.delete(sessionID)
      this.#activityEpochs.delete(sessionID)
    }
  }

  async #handleSessionError(sessionID: string | undefined, error: PromptError | undefined): Promise<void> {
    if (!sessionID) return
    const current = this.#store.read(sessionID)
    if (!current || current.goal.status !== "active") return
    const updated = await this.#store.update<PromptOutcome>(sessionID, current.revision, (draft) => {
      if (draft.budgetWrapupPending) {
        const detail = promptErrorDetail(error)
        interruptBudgetWrapup(draft, `Accepted final budget wrap-up ended with a host error: ${detail}`)
        return { commit: true, value: { type: "failure", detail } satisfies PromptOutcome }
      }
      const wait = applyUsageLimitWait(draft, error, this.#options.usageLimitWaitSeconds)
      if (wait) return { commit: true, value: { type: "usage-limit", wait } satisfies PromptOutcome }
      const detail = promptErrorDetail(error)
      recordPromptFailure(draft, detail, this.#options.maxPromptFailures)
      return { commit: true, value: { type: "failure", detail } satisfies PromptOutcome }
    })
    if (updated.applied) await this.#logPromptOutcome(updated.snapshot.goal, updated.value)
  }

  async #waitForCooldown(goal: GoalSnapshot, activityEpoch: number): Promise<GoalSnapshot | undefined> {
    const elapsed = nowMilliseconds() - goal.goal.lastContinueAt
    const remaining = this.#options.minDelayMs - elapsed
    if (remaining > 0) await sleep(remaining)
    if (!this.#activityUnchanged(goal.goal.threadId, activityEpoch)) return undefined
    const current = this.#store.read(goal.goal.threadId)
    return current && current.goal.status === "active" && sameRevision(goal, current) ? current : undefined
  }

  async #sendContinuation(
    goal: GoalSnapshot,
    mode: "continue" | "wrapup",
    activityEpoch: number,
    hardBudgetWrapup?: HardBudgetWrapup,
  ): Promise<ContinuationSendOutcome> {
    const session = this.#input.client?.session
    if (!session?.promptAsync) return { type: "skipped" }
    if (!(await this.#eligibleToPrompt(goal, activityEpoch))) return { type: "skipped" }

    const promptedAt = nowMilliseconds()
    const promptGoal: StoredGoal = {
      ...goal.goal,
      continuationCount: goal.goal.continuationCount + 1,
      budgetWrapupSent: mode === "wrapup" ? true : goal.goal.budgetWrapupSent,
    }

    let promptError: PromptError | undefined
    try {
      const result = await session.promptAsync({
        path: { id: goal.goal.threadId },
        body: { parts: [textPart(continuationPrompt(promptGoal, this.#options, mode))] },
      })
      if (result?.error) promptError = promptErrorFromUnknown(result.error)
    } catch (error) {
      promptError = promptErrorFromUnknown(error)
    }

    const updated = await this.#store.update<PromptOutcome>(goal.goal.threadId, goal.revision, (draft) => {
      draft.lastContinueAt = promptedAt
      if (promptError) {
        const wait = applyUsageLimitWait(draft, promptError, this.#options.usageLimitWaitSeconds)
        if (wait) return { commit: true, value: { type: "usage-limit", wait } satisfies PromptOutcome }
        const detail = promptErrorDetail(promptError)
        recordPromptFailure(draft, detail, this.#options.maxPromptFailures)
        return { commit: true, value: { type: "failure", detail } satisfies PromptOutcome }
      }

      draft.continuationCount = promptGoal.continuationCount
      draft.budgetWrapupSent = promptGoal.budgetWrapupSent
      markAutoContinueSent(draft, this.#options, mode)
      if (hardBudgetWrapup) {
        markBudgetWrapupPending(
          draft,
          hardBudgetWrapup.limitReason,
          hardBudgetWrapup.baselineAssistantMessageId,
        )
      }
      if (draft.promptFailureCount > 0) markAutoContinueRecovered(draft)
      return { commit: true, value: { type: "accepted" } satisfies PromptOutcome }
    })
    if (!updated.applied) return { type: "skipped" }
    await this.#logPromptOutcome(updated.snapshot.goal, updated.value)
    return { type: updated.value.type, snapshot: updated.snapshot }
  }

  async #eligibleToPrompt(goal: GoalSnapshot, activityEpoch: number): Promise<boolean> {
    const sessionID = goal.goal.threadId
    if (!this.#activityUnchanged(sessionID, activityEpoch)) return false
    const current = this.#store.read(sessionID)
    if (!current || current.goal.status !== "active" || !sameRevision(goal, current)) return false

    const status = this.#input.client?.session?.status
    if (!status) return true
    let response: Awaited<ReturnType<typeof status>>
    try {
      response = await status.call(this.#input.client?.session)
    } catch (error) {
      await log(this.#input, "warn", "Skipped auto-continue because session status lookup failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }

    if (!this.#activityUnchanged(sessionID, activityEpoch)) return false
    const latest = this.#store.read(sessionID)
    if (!latest || latest.goal.status !== "active" || !sameRevision(goal, latest)) return false
    if (response.error) {
      await log(this.#input, "warn", "Skipped auto-continue because session status lookup failed", {
        error: String(response.error),
      })
      return false
    }
    return response.data?.[sessionID]?.type === "idle"
  }

  async #logPromptOutcome(goal: StoredGoal, outcome: PromptOutcome): Promise<void> {
    if (outcome.type === "accepted") return
    if (outcome.type === "usage-limit") {
      await log(this.#input, "warn", "Auto-continue waiting for provider usage window", {
        waitSeconds: outcome.wait.waitSeconds,
        error: outcome.wait.detail,
      })
      return
    }
    await log(this.#input, goal.status === "paused" ? "error" : "warn", "Auto-continue failed", {
      failureCount: goal.promptFailureCount,
      maxFailures: this.#options.maxPromptFailures,
      error: outcome.detail,
    })
  }
}
