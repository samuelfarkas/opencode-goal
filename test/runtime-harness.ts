import { GoalRuntime } from "../src/runtime.ts"
import { resolveOptions } from "../src/options.ts"
import { goalPolicyDefaults } from "../src/options.ts"
import { createGoal, GoalStore } from "../src/store.ts"
import type { GoalSnapshot } from "../src/store.ts"
import type { GoalPluginOptions, OpencodeClient, SessionMessage, StoredGoal } from "../src/types.ts"

export type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

const storePolicies = new WeakMap<GoalStore, ReturnType<typeof resolveOptions>>()

export function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined
  let rejectPromise: (reason?: unknown) => void = () => undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

export function assistantMessage(
  id: string,
  text: string,
  tokens: { input?: number; output?: number; reasoning?: number } = {},
): SessionMessage {
  return {
    info: { id, role: "assistant", sessionID: "s1", tokens },
    parts: [{ type: "text", text }],
  }
}

export function runtimeFixture(
  client: OpencodeClient,
  pluginOptions: GoalPluginOptions = {},
): { runtime: GoalRuntime; store: GoalStore } {
  const options = resolveOptions({
    persistState: false,
    registerTools: false,
    toastNotifications: false,
    sessionTitle: false,
    idleSettleMs: 0,
    minDelayMs: 0,
    ...pluginOptions,
  })
  const store = new GoalStore(
    options.stateFilePath,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    goalPolicyDefaults(options),
  )
  storePolicies.set(store, options)
  return { runtime: new GoalRuntime({ client }, store, options), store }
}

export async function seedGoal(
  store: GoalStore,
  objective = "finish the task",
  tokenBudget?: number | null,
): Promise<GoalSnapshot> {
  const options = storePolicies.get(store) ?? resolveOptions({ persistState: false })
  const policy = goalPolicyDefaults(options)
  if (tokenBudget !== undefined) policy.tokenBudget = tokenBudget
  return store.replace(createGoal("s1", objective, policy.tokenBudget, "standard", [], undefined, policy))
}

export async function updateGoal(
  store: GoalStore,
  transition: (draft: StoredGoal) => void,
): Promise<GoalSnapshot> {
  const current = store.read("s1")
  if (!current) throw new Error("missing goal")
  const updated = await store.update("s1", current.revision, (draft) => {
    transition(draft)
    return { commit: true, value: undefined }
  })
  if (!updated.applied) throw new Error(`goal update was ${updated.reason}`)
  return updated.snapshot
}

export function idleEvent(): { event: { type: string; properties: { sessionID: string } } } {
  return { event: { type: "session.idle", properties: { sessionID: "s1" } } }
}

export function messageEvent(message: SessionMessage): {
  event: { type: string; properties: { message: SessionMessage } }
} {
  return { event: { type: "message.updated", properties: { message } } }
}
