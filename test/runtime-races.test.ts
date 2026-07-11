import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { resolveOptions } from "../src/options.ts"
import { GoalRuntime } from "../src/runtime.ts"
import { createGoal, GoalStore } from "../src/store.ts"
import type { OpencodeClient, SessionMessage, StoredGoal } from "../src/types.ts"
import {
  assistantMessage,
  deferred,
  idleEvent,
  messageEvent,
  runtimeFixture,
  seedGoal,
  updateGoal,
} from "./runtime-harness.ts"

test("transcript reconciliation returns updated, unchanged, and unavailable outcomes", async () => {
  let messages: SessionMessage[] = []
  const available = runtimeFixture({
    session: { messages: async () => ({ data: messages }) },
  })
  await seedGoal(available.store)

  assert.deepEqual(await available.runtime.syncSession("s1"), { type: "unchanged" })
  messages = [assistantMessage("a1", "Progress.")]
  assert.deepEqual(await available.runtime.syncSession("s1"), { type: "updated" })
  assert.deepEqual(await available.runtime.syncSession("s1"), { type: "unchanged" })

  let logCalls = 0
  const unavailable = runtimeFixture({
    session: {
      messages: async () => {
        throw new Error("transcript offline")
      },
    },
    app: {
      log: () => {
        logCalls += 1
        throw new Error("logger offline")
      },
    },
  })
  await seedGoal(unavailable.store)

  assert.deepEqual(await unavailable.runtime.syncSession("s1"), {
    type: "unavailable",
    detail: "transcript offline",
  })
  assert.equal(logCalls, 1)
  assert.equal(unavailable.store.read("s1")?.goal.status, "active")
})

test("transcript reconciliation does not relabel persistence rejection as host unavailability", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-reconcile-persist-"))
  const stateFilePath = join(directory, "state.json")
  const options = resolveOptions({
    stateFilePath,
    persistState: true,
    registerTools: false,
    toastNotifications: false,
    sessionTitle: false,
  })
  const store = new GoalStore(stateFilePath, true)
  await store.replace(createGoal("s1", "persist the observation", null))
  await rm(stateFilePath)
  await mkdir(stateFilePath)
  const runtime = new GoalRuntime(
    {
      client: {
        session: {
          messages: async () => ({ data: [assistantMessage("a1", "Progress.")] }),
        },
      },
    },
    store,
    options,
  )

  await assert.rejects(runtime.syncSession("s1"))
})

test("idle transcript failure skips safely and the next successful idle continues once", async () => {
  let reads = 0
  let prompts = 0
  const client: OpencodeClient = {
    session: {
      messages: async () => {
        reads += 1
        if (reads === 1) throw new Error("transcript offline")
        return { data: [] }
      },
      promptAsync: async () => {
        prompts += 1
        return {}
      },
    },
    app: {
      log: async () => {
        throw new Error("logger offline")
      },
    },
  }
  const { runtime, store } = runtimeFixture(client)
  await seedGoal(store)

  await runtime.handleEvent(idleEvent())
  assert.equal(prompts, 0)
  assert.equal(store.read("s1")?.goal.continuationCount, 0)
  assert.equal(store.read("s1")?.goal.promptFailureCount, 0)

  await runtime.handleEvent(idleEvent())
  assert.equal(prompts, 1)
  assert.equal(store.read("s1")?.goal.continuationCount, 1)
  assert.equal(store.read("s1")?.goal.promptFailureCount, 0)
})

test("rejecting host logging cannot escape prompt failure handling or debounced sync", async () => {
  let transcriptRejects = false
  const client: OpencodeClient = {
    session: {
      messages: async () => {
        if (transcriptRejects) throw new Error("transcript offline")
        return { data: [] }
      },
      promptAsync: async () => ({ error: { message: "prompt transport failed" } }),
    },
    app: {
      log: async () => {
        throw new Error("logger offline")
      },
    },
  }
  const { runtime, store } = runtimeFixture(client)
  await seedGoal(store)

  await runtime.handleEvent(idleEvent())
  assert.equal(store.read("s1")?.goal.promptFailureCount, 1)
  assert.equal(store.read("s1")?.goal.status, "active")

  transcriptRejects = true
  await runtime.handleEvent({
    event: { type: "message.part.updated", properties: { part: { sessionID: "s1" } } },
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(store.read("s1")?.goal.promptFailureCount, 1)
})

test("clear during session.messages cannot resurrect the cleared goal", async () => {
  const messages = deferred<{ data?: SessionMessage[] }>()
  const { runtime, store } = runtimeFixture({ session: { messages: () => messages.promise } })
  await seedGoal(store)

  const syncing = runtime.syncSession("s1")
  await store.clear("s1")
  messages.resolve({ data: [assistantMessage("a1", "Done\n[goal:evidence] tests passed\n[goal:complete]")] })
  await syncing

  assert.equal(store.read("s1"), undefined)
})

test("replace during session.messages cannot be terminalized by the stale transcript", async () => {
  const messages = deferred<{ data?: SessionMessage[] }>()
  const { runtime, store } = runtimeFixture({ session: { messages: () => messages.promise } })
  await seedGoal(store, "original goal")

  const syncing = runtime.syncSession("s1")
  await store.replace(createGoal("s1", "replacement goal", null))
  messages.resolve({ data: [assistantMessage("a1", "Done\n[goal:evidence] tests passed\n[goal:complete]")] })
  await syncing

  assert.equal(store.read("s1")?.goal.objective, "replacement goal")
  assert.equal(store.read("s1")?.goal.status, "active")
})

test("pause during session.messages cannot be terminalized by the stale transcript", async () => {
  const messages = deferred<{ data?: SessionMessage[] }>()
  const { runtime, store } = runtimeFixture({ session: { messages: () => messages.promise } })
  await seedGoal(store)

  const syncing = runtime.syncSession("s1")
  await updateGoal(store, (draft) => {
    draft.status = "paused"
  })
  messages.resolve({ data: [assistantMessage("a1", "Done\n[goal:evidence] tests passed\n[goal:complete]")] })
  await syncing

  assert.equal(store.read("s1")?.goal.status, "paused")
})

test("replace during promptAsync cannot be overwritten by stale continuation", async () => {
  const prompt = deferred<{ error?: unknown } | undefined>()
  const promptStarted = deferred<void>()
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [] }),
      promptAsync: () => {
        promptStarted.resolve()
        return prompt.promise
      },
    },
  }
  const { runtime, store } = runtimeFixture(client)
  await seedGoal(store, "original goal")

  const idling = runtime.handleEvent(idleEvent())
  await promptStarted.promise
  await store.replace(createGoal("s1", "replacement goal", null))
  prompt.resolve({})
  await idling

  assert.equal(store.read("s1")?.goal.objective, "replacement goal")
  assert.equal(store.read("s1")?.goal.continuationCount, 0)
})

test("clear during promptAsync prevents stale continuation persistence", async () => {
  const prompt = deferred<{ error?: unknown } | undefined>()
  const promptStarted = deferred<void>()
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [] }),
      promptAsync: () => {
        promptStarted.resolve()
        return prompt.promise
      },
    },
  }
  const { runtime, store } = runtimeFixture(client)
  await seedGoal(store)

  const idling = runtime.handleEvent(idleEvent())
  await promptStarted.promise
  await store.clear("s1")
  prompt.resolve({})
  await idling

  assert.equal(store.read("s1"), undefined)
})

test("pause during promptAsync prevents stale continuation persistence", async () => {
  const prompt = deferred<{ error?: unknown } | undefined>()
  const promptStarted = deferred<void>()
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [] }),
      promptAsync: () => {
        promptStarted.resolve()
        return prompt.promise
      },
    },
  }
  const { runtime, store } = runtimeFixture(client)
  await seedGoal(store)

  const idling = runtime.handleEvent(idleEvent())
  await promptStarted.promise
  await updateGoal(store, (draft) => {
    draft.status = "paused"
  })
  prompt.resolve({})
  await idling

  assert.equal(store.read("s1")?.goal.status, "paused")
  assert.equal(store.read("s1")?.goal.continuationCount, 0)
})

test("user activity during idle settle aborts the first continuation", async () => {
  let prompts = 0
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [] }),
      promptAsync: async () => {
        prompts += 1
        return {}
      },
    },
  }
  const { runtime, store } = runtimeFixture(client, { idleSettleMs: 10 })
  await seedGoal(store)

  const idling = runtime.handleEvent(idleEvent())
  await runtime.handleEvent(
    messageEvent({
      info: { id: "u1", role: "user", sessionID: "s1" },
      parts: [{ type: "text", text: "new user work" }],
    }),
  )
  await idling

  assert.equal(prompts, 0)
  assert.equal(store.read("s1")?.goal.status, "active")
  assert.equal(store.read("s1")?.goal.continuationCount, 0)
})

test("non-idle status activity during settle aborts without mutating the goal", async () => {
  let prompts = 0
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [] }),
      promptAsync: async () => {
        prompts += 1
        return {}
      },
    },
  }
  const { runtime, store } = runtimeFixture(client, { idleSettleMs: 10 })
  await seedGoal(store)

  const idling = runtime.handleEvent(idleEvent())
  await runtime.handleEvent({
    event: { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } },
  })
  await idling

  assert.equal(prompts, 0)
  assert.equal(store.read("s1")?.goal.status, "active")
  assert.equal(store.read("s1")?.goal.promptFailureCount, 0)
})

test("host session status permits idle and skips busy or retry", async () => {
  const cases = [
    { status: { type: "idle" } as const, expectedPrompts: 1 },
    { status: { type: "busy" } as const, expectedPrompts: 0 },
    {
      status: { type: "retry", attempt: 1, message: "retrying", next: Date.now() + 1000 } as const,
      expectedPrompts: 0,
    },
  ]

  for (const { status, expectedPrompts } of cases) {
    let prompts = 0
    const client: OpencodeClient = {
      session: {
        messages: async () => ({ data: [] }),
        status: async () => ({ data: { s1: status } }),
        promptAsync: async () => {
          prompts += 1
          return {}
        },
      },
    }
    const { runtime, store } = runtimeFixture(client)
    await seedGoal(store)

    await runtime.handleEvent(idleEvent())

    assert.equal(prompts, expectedPrompts, status.type)
    assert.equal(store.read("s1")?.goal.continuationCount, expectedPrompts, status.type)
    assert.equal(store.read("s1")?.goal.promptFailureCount, 0, status.type)
  }
})

test("missing status capability uses the epoch guard", async () => {
  let prompts = 0
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [] }),
      promptAsync: async () => {
        prompts += 1
        return {}
      },
    },
  }
  const { runtime, store } = runtimeFixture(client)
  await seedGoal(store)

  await runtime.handleEvent(idleEvent())

  assert.equal(prompts, 1)
  assert.equal(store.read("s1")?.goal.continuationCount, 1)
})

test("rejected status lookup skips the idle attempt without consuming failure budget", async () => {
  let prompts = 0
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [] }),
      status: async () => {
        throw new Error("status unavailable")
      },
      promptAsync: async () => {
        prompts += 1
        return {}
      },
    },
  }
  const { runtime, store } = runtimeFixture(client)
  await seedGoal(store)

  await runtime.handleEvent(idleEvent())

  assert.equal(prompts, 0)
  assert.equal(store.read("s1")?.goal.status, "active")
  assert.equal(store.read("s1")?.goal.continuationCount, 0)
  assert.equal(store.read("s1")?.goal.promptFailureCount, 0)
})

test("activity during cooldown aborts continuation", async () => {
  const messagesCalled = deferred<void>()
  let prompts = 0
  const client: OpencodeClient = {
    session: {
      messages: async () => {
        messagesCalled.resolve()
        return { data: [] }
      },
      promptAsync: async () => {
        prompts += 1
        return {}
      },
    },
  }
  const { runtime, store } = runtimeFixture(client, { minDelayMs: 50 })
  await seedGoal(store)
  await updateGoal(store, (draft) => {
    draft.lastContinueAt = Date.now()
  })

  const idling = runtime.handleEvent(idleEvent())
  await messagesCalled.promise
  await new Promise<void>((resolve) => setImmediate(resolve))
  await runtime.handleEvent({
    event: { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } },
  })
  await idling

  assert.equal(prompts, 0)
  assert.equal(store.read("s1")?.goal.continuationCount, 0)
})

test("historical user messages do not block a new goal's first continuation", async () => {
  let prompts = 0
  const oldUserMessage: SessionMessage = {
    info: { id: "u-old", role: "user", sessionID: "s1" },
    parts: [{ type: "text", text: "old conversation" }],
  }
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [oldUserMessage] }),
      status: async () => ({ data: { s1: { type: "idle" } } }),
      promptAsync: async () => {
        prompts += 1
        return {}
      },
    },
  }
  const { runtime, store } = runtimeFixture(client)
  await seedGoal(store)

  await runtime.handleEvent(idleEvent())

  assert.equal(prompts, 1)
  assert.equal(store.read("s1")?.goal.status, "active")
})

test("message.updated before idle still scores the completed assistant turn", async () => {
  const thin = assistantMessage("a1", "ok", { output: 1 })
  let prompts = 0
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [thin] }),
      promptAsync: async () => {
        prompts += 1
        return {}
      },
    },
  }
  const { runtime, store } = runtimeFixture(client, { noProgressTurnsBeforePause: 1 })
  await seedGoal(store)
  await updateGoal(store, (draft) => {
    draft.continuationCount = 1
  })

  await runtime.handleEvent(messageEvent(thin))
  await runtime.handleEvent(idleEvent())

  assert.equal(prompts, 0)
  assert.equal(store.read("s1")?.goal.status, "paused")
  assert.equal(store.read("s1")?.goal.noProgressTurns, 1)
  assert.equal(store.read("s1")?.goal.lastStallEvaluatedAssistantMessageId, "a1")
})

test("streaming updates and repeated idle score one assistant message once", async () => {
  const partial = assistantMessage("a1", "o", { output: 1 })
  const complete = assistantMessage("a1", "ok", { output: 1 })
  let prompts = 0
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [complete] }),
      promptAsync: async () => {
        prompts += 1
        return {}
      },
    },
  }
  const { runtime, store } = runtimeFixture(client, { noProgressTurnsBeforePause: 2 })
  await seedGoal(store)
  await updateGoal(store, (draft) => {
    draft.continuationCount = 1
  })

  await runtime.handleEvent(messageEvent(partial))
  await runtime.handleEvent(messageEvent(complete))
  await runtime.handleEvent(idleEvent())
  await runtime.handleEvent(idleEvent())

  assert.equal(prompts, 2)
  assert.equal(store.read("s1")?.goal.status, "active")
  assert.equal(store.read("s1")?.goal.noProgressTurns, 1)
  assert.equal(store.read("s1")?.goal.lastStallEvaluatedAssistantMessageId, "a1")
})

test("transcript reconciliation accumulates token totals across assistant messages", async () => {
  const messages = [
    assistantMessage("a1", "first turn", { input: 10, output: 20 }),
    assistantMessage("a2", "second turn", { input: 100, output: 200 }),
  ]
  const { runtime, store } = runtimeFixture({ session: { messages: async () => ({ data: messages }) } })
  await seedGoal(store)

  await runtime.syncSession("s1")

  assert.equal(store.read("s1")?.goal.tokensUsed, 330)
  assert.deepEqual(store.read("s1")?.goal.assistantTokenTotals, [
    { messageId: "a1", total: 30 },
    { messageId: "a2", total: 300 },
  ])
})

test("direct streaming updates add positive deltas once across turns", async () => {
  const { runtime, store } = runtimeFixture({})
  await seedGoal(store)
  const message = (id: string, total: number): SessionMessage => ({
    info: { id, role: "assistant", sessionID: "s1", tokens: { output: total } },
    parts: [{ type: "text", text: `${id} progress` }],
  })

  await runtime.handleEvent(messageEvent(message("a1", 10)))
  await runtime.handleEvent(messageEvent(message("a1", 30)))
  await runtime.handleEvent(messageEvent(message("a1", 20)))
  await runtime.handleEvent(messageEvent(message("a2", 40)))
  await runtime.handleEvent(
    messageEvent({
      info: { id: "u1", role: "user", sessionID: "s1", tokens: { output: 100 } },
      parts: [{ type: "text", text: "user message" }],
    }),
  )
  await runtime.flushSession("s1")

  assert.equal(store.read("s1")?.goal.tokensUsed, 70)
})

test("an id-less direct event reconciles tokens through the stable host message id", async () => {
  const stable = assistantMessage("a1", "progress", { input: 10, output: 20 })
  const client: OpencodeClient = {
    session: { messages: async () => ({ data: [stable] }) },
  }
  const { runtime, store } = runtimeFixture(client)
  await seedGoal(store)

  await runtime.handleEvent(
    messageEvent({
      info: { role: "assistant", sessionID: "s1", tokens: { input: 10, output: 20 } },
      parts: [{ type: "text", text: "progress" }],
    }),
  )
  await runtime.flushSession("s1")

  assert.equal(store.read("s1")?.goal.tokensUsed, 30)
  assert.deepEqual(store.read("s1")?.goal.assistantTokenTotals, [{ messageId: "a1", total: 30 }])
})

test("one scheduler commit coalesces one hundred streaming updates and terminal output flushes immediately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-stream-coalesce-"))
  const stateFilePath = join(directory, "state.json")
  const options = resolveOptions({
    stateFilePath,
    persistState: true,
    registerTools: false,
    toastNotifications: false,
    sessionTitle: false,
  })
  const store = new GoalStore(stateFilePath, true)
  let scheduled = 0
  let cancelled = 0
  const runtime = new GoalRuntime({}, store, options, {
    setTimeout: () => {
      scheduled += 1
      return scheduled
    },
    clearTimeout: () => { cancelled += 1 },
  })
  await store.replace(createGoal("s1", "coalesce streaming output", null))

  for (let index = 1; index <= 100; index += 1) {
    await runtime.handleEvent(messageEvent(assistantMessage("a1", `partial ${index}`, { output: index })))
  }
  const beforeFlush = JSON.parse(await readFile(stateFilePath, "utf8")) as { lastSequence: number }
  assert.equal(beforeFlush.lastSequence, 1)
  assert.equal(scheduled, 1)
  await runtime.flushSession("s1")
  const afterFlush = JSON.parse(await readFile(stateFilePath, "utf8")) as { lastSequence: number }
  assert.equal(afterFlush.lastSequence, 2)
  assert.equal(store.read("s1")?.goal.tokensUsed, 100)
  assert.equal(store.read("s1")?.goal.lastAssistantText, "partial 100")
  assert.equal(cancelled, 1)

  await runtime.handleEvent(messageEvent(assistantMessage(
    "a1",
    "Done\n[goal:evidence] streamed result verified\n[goal:complete]",
    { output: 100 },
  )))
  const terminal = JSON.parse(await readFile(stateFilePath, "utf8")) as { lastSequence: number; goals: StoredGoal[] }
  assert.equal(terminal.lastSequence, 3)
  assert.equal(terminal.goals[0]?.status, "complete")
})

test("pending reconciliation flushes before replacement and dispose", async () => {
  let scheduled = 0
  const options = resolveOptions({ persistState: false, registerTools: false })
  const store = new GoalStore(options.stateFilePath, false)
  const runtime = new GoalRuntime({}, store, options, {
    setTimeout: () => ++scheduled,
    clearTimeout: () => undefined,
  })
  await store.replace(createGoal("s1", "old goal", null))
  await runtime.handleEvent(messageEvent(assistantMessage("a1", "old preview", { output: 5 })))
  await store.replace(createGoal("s1", "replacement goal", null))
  assert.equal(store.read("s1")?.goal.objective, "replacement goal")
  assert.equal(store.read("s1")?.goal.tokensUsed, 0)

  await runtime.handleEvent(messageEvent(assistantMessage("a2", "replacement preview", { output: 7 })))
  await runtime.dispose()
  assert.equal(store.read("s1")?.goal.lastAssistantText, "replacement preview")
  assert.equal(store.read("s1")?.goal.tokensUsed, 7)
})

test("session.deleted flushes and clears without invoking title-clear observers", async () => {
  let clearNotifications = 0
  const options = resolveOptions({ persistState: false, registerTools: false })
  const store = new GoalStore(
    options.stateFilePath,
    false,
    undefined,
    () => { clearNotifications += 1 },
  )
  const runtime = new GoalRuntime({}, store, options, {
    setTimeout: () => 1,
    clearTimeout: () => undefined,
  })
  await store.replace(createGoal("s1", "deleted session goal", null))
  await runtime.handleEvent(messageEvent(assistantMessage("a1", "pending before deletion", { output: 3 })))
  await runtime.handleEvent({ event: { type: "session.deleted", properties: { sessionID: "s1" } } })
  assert.equal(store.read("s1"), undefined)
  assert.equal(clearNotifications, 0)
})

test("aggregate token usage triggers near-budget wrap-up", async () => {
  let prompt = ""
  const messages = [
    assistantMessage("a1", "first substantive turn", { output: 40 }),
    assistantMessage("a2", "second substantive turn", { output: 46 }),
  ]
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: messages }),
      promptAsync: async (input) => {
        prompt = input.body.parts[0]?.text ?? ""
        return {}
      },
    },
  }
  const { runtime, store } = runtimeFixture(client, { tokenBudget: 100, budgetWrapupRatio: 0.85 })
  await seedGoal(store, "ship the migration", 100)

  await runtime.handleEvent(idleEvent())

  assert.equal(store.read("s1")?.goal.tokensUsed, 86)
  assert.equal(store.read("s1")?.goal.budgetWrapupSent, true)
  assert.match(prompt, /concise handoff/)
})

test("aggregate token usage triggers the exact hard limit", async () => {
  let prompt = ""
  let prompts = 0
  const messages = [
    assistantMessage("a1", "first substantive turn", { output: 40 }),
    assistantMessage("a2", "second substantive turn", { output: 60 }),
  ]
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: messages }),
      promptAsync: async (input) => {
        prompts += 1
        prompt = input.body.parts[0]?.text ?? ""
        return {}
      },
    },
  }
  const { runtime, store } = runtimeFixture(client, { tokenBudget: 100 })
  await seedGoal(store, "ship the migration", 100)

  await runtime.handleEvent(idleEvent())

  assert.equal(store.read("s1")?.goal.tokensUsed, 100)
  assert.equal(store.read("s1")?.goal.status, "active")
  assert.equal(store.read("s1")?.goal.budgetWrapupPending, true)
  assert.equal(store.read("s1")?.goal.budgetWrapupBaselineAssistantMessageId, "a2")
  assert.match(prompt, /concise handoff/)

  messages.push(assistantMessage("a3", "Final handoff", { output: 7 }))
  await runtime.handleEvent(idleEvent())

  assert.equal(store.read("s1")?.goal.tokensUsed, 107)
  assert.equal(store.read("s1")?.goal.status, "budgetLimited")
  assert.equal(store.read("s1")?.goal.budgetWrapupPending, false)
  assert.equal(store.read("s1")?.goal.lastAssistantMessageId, "a3")
  assert.equal(prompts, 1)
})

test("provider-wait expiry clears the wait before continuation", async () => {
  let prompts = 0
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [] }),
      promptAsync: async () => {
        prompts += 1
        return {}
      },
    },
  }
  const { runtime, store } = runtimeFixture(client)
  await seedGoal(store)
  await updateGoal(store, (draft) => {
    draft.usageLimitedUntil = Math.floor(Date.now() / 1000)
    draft.usageLimitedReason = "rate limit"
  })

  await runtime.handleEvent(idleEvent())

  assert.equal(prompts, 1)
  assert.equal(store.read("s1")?.goal.usageLimitedUntil, 0)
  assert.equal(store.read("s1")?.goal.usageLimitedReason, "")
})

test("accepted hard-limit wrap-up remains active until complete, blocked, or plain output is observed", async () => {
  const cases = [
    {
      name: "complete",
      response: "Done\n[goal:evidence] bun test passed\n[goal:complete]",
      expectedStatus: "complete",
    },
    {
      name: "blocked",
      response: "Registry credentials are unavailable.\n[goal:blocked]",
      expectedStatus: "blocked",
    },
    { name: "plain", response: "Final handoff with remaining work.", expectedStatus: "budgetLimited" },
  ] as const

  for (const item of cases) {
    const messages = [assistantMessage("a1", "Work before the limit.", { output: 1 })]
    let prompts = 0
    const client: OpencodeClient = {
      session: {
        messages: async () => ({ data: messages }),
        promptAsync: async () => {
          prompts += 1
          return {}
        },
      },
    }
    const { runtime, store } = runtimeFixture(client, { tokenBudget: 100 })
    await seedGoal(store, "ship the migration", 100)
    await updateGoal(store, (draft) => {
      draft.tokensUsed = 100
    })

    await runtime.handleEvent(idleEvent())
    const pending = store.read("s1")?.goal
    assert.equal(pending?.status, "active", item.name)
    assert.equal(pending?.budgetWrapupPending, true, item.name)
    assert.equal(pending?.budgetWrapupLimitReason, "Token budget reached.", item.name)
    assert.equal(pending?.budgetWrapupBaselineAssistantMessageId, "a1", item.name)
    assert.equal(pending?.continuationCount, 1, item.name)
    assert.equal(pending?.budgetWrapupSent, true, item.name)

    const response = assistantMessage("a2", item.response, { output: 9 })
    messages.push(response)
    await runtime.handleEvent(messageEvent(response))
    assert.equal(store.read("s1")?.goal.status, "active", item.name)
    assert.equal(store.read("s1")?.goal.budgetWrapupPending, true, item.name)

    await runtime.handleEvent(idleEvent())
    const terminal = store.read("s1")?.goal
    assert.equal(terminal?.status, item.expectedStatus, item.name)
    assert.equal(terminal?.budgetWrapupPending, false, item.name)
    assert.equal(terminal?.budgetWrapupLimitReason, "", item.name)
    assert.equal(terminal?.budgetWrapupBaselineAssistantMessageId, "", item.name)
    assert.equal(terminal?.tokensUsed, 110, item.name)
    assert.equal(terminal?.lastAssistantMessageId, "a2", item.name)
    if (item.name === "complete") assert.equal(terminal?.lastEvidence, "bun test passed")
    if (item.name === "blocked") assert.equal(terminal?.blockedReason, "Registry credentials are unavailable.")

    const historyLength = terminal?.history.length
    await runtime.handleEvent(messageEvent(response))
    await runtime.handleEvent(idleEvent())
    assert.equal(store.read("s1")?.goal.history.length, historyLength, item.name)
    assert.equal(prompts, 1, item.name)
  }
})

test("hard duration and turn limits each allow exactly one accepted final wrap-up", async () => {
  const cases = [
    {
      name: "duration",
      options: { maxDurationSeconds: 10 },
      prepare: (goal: StoredGoal) => {
        goal.timeUsedSeconds = 10
        goal.activeStartedAtSeconds = null
      },
      reason: "Duration budget reached.",
    },
    {
      name: "turn",
      options: { maxTurns: 2 },
      prepare: (goal: StoredGoal) => {
        goal.continuationCount = 2
      },
      reason: "Auto-continue turn budget reached.",
    },
  ] as const

  for (const item of cases) {
    const messages: SessionMessage[] = []
    let prompts = 0
    const client: OpencodeClient = {
      session: {
        messages: async () => ({ data: messages }),
        promptAsync: async () => {
          prompts += 1
          return {}
        },
      },
    }
    const { runtime, store } = runtimeFixture(client, item.options)
    await seedGoal(store)
    await updateGoal(store, item.prepare)

    await runtime.handleEvent(idleEvent())
    assert.equal(store.read("s1")?.goal.status, "active", item.name)
    assert.equal(store.read("s1")?.goal.budgetWrapupPending, true, item.name)
    assert.equal(store.read("s1")?.goal.budgetWrapupLimitReason, item.reason, item.name)

    messages.push(assistantMessage("a-final", "Final handoff."))
    await runtime.handleEvent(idleEvent())
    assert.equal(store.read("s1")?.goal.status, "budgetLimited", item.name)
    assert.equal(store.read("s1")?.goal.budgetWrapupPending, false, item.name)
    assert.equal(prompts, 1, item.name)
  }
})

test("usage waits and transient failures leave the hard-limit wrap-up unsent until acceptance", async () => {
  const cases = [
    {
      name: "usage wait",
      error: { message: "Rate limit reached", statusCode: 429 },
      assertFirst: (goal: StoredGoal) => {
        assert.ok(goal.usageLimitedUntil > Math.floor(Date.now() / 1000))
        assert.equal(goal.promptFailureCount, 0)
      },
    },
    {
      name: "transient failure",
      error: { message: "temporary transport failure" },
      assertFirst: (goal: StoredGoal) => {
        assert.equal(goal.usageLimitedUntil, 0)
        assert.equal(goal.promptFailureCount, 1)
      },
    },
  ] as const

  for (const item of cases) {
    let prompts = 0
    const messages: SessionMessage[] = []
    const client: OpencodeClient = {
      session: {
        messages: async () => ({ data: messages }),
        promptAsync: async () => {
          prompts += 1
          return prompts === 1 ? { error: item.error } : {}
        },
      },
    }
    const { runtime, store } = runtimeFixture(client, { tokenBudget: 100 })
    await seedGoal(store, "ship", 100)
    await updateGoal(store, (draft) => {
      draft.tokensUsed = 100
    })

    await runtime.handleEvent(idleEvent())
    const first = store.read("s1")?.goal
    assert.ok(first)
    item.assertFirst(first)
    assert.equal(first.status, "active", item.name)
    assert.equal(first.continuationCount, 0, item.name)
    assert.equal(first.budgetWrapupSent, false, item.name)
    assert.equal(Boolean(first.budgetWrapupPending), false, item.name)

    await updateGoal(store, (draft) => {
      draft.usageLimitedUntil = 0
      draft.usageLimitedReason = ""
    })
    await runtime.handleEvent(idleEvent())
    const accepted = store.read("s1")?.goal
    assert.equal(accepted?.continuationCount, 1, item.name)
    assert.equal(accepted?.budgetWrapupSent, true, item.name)
    assert.equal(accepted?.budgetWrapupPending, true, item.name)
    assert.equal(accepted?.promptFailureCount, 0, item.name)
    assert.equal(prompts, 2, item.name)
  }
})

test("pending restart reconciliation ignores predating output and never retries an accepted wrap-up", async () => {
  const predating = assistantMessage(
    "a1",
    "Old completion claim\n[goal:evidence] stale evidence\n[goal:complete]",
  )
  const baseline = assistantMessage("a2", "Latest output before enqueue.")
  let prompts = 0
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: [predating, baseline] }),
      promptAsync: async () => {
        prompts += 1
        return {}
      },
    },
  }
  const { runtime, store } = runtimeFixture(client)
  await seedGoal(store)
  await updateGoal(store, (draft) => {
    draft.tokensUsed = 100
    draft.budgetWrapupSent = true
    draft.budgetWrapupPending = true
    draft.budgetWrapupLimitReason = "Token budget reached."
    draft.budgetWrapupBaselineAssistantMessageId = "a2"
  })

  await runtime.handleEvent(idleEvent())
  const terminal = store.read("s1")?.goal
  assert.equal(terminal?.status, "budgetLimited")
  assert.equal(terminal?.lastEvidence, "")
  assert.equal(terminal?.budgetWrapupPending, false)
  assert.equal(prompts, 0)
  assert.ok(terminal?.history.some((entry) => entry.type === "budgetWrapupInterrupted"))

  await runtime.handleEvent(idleEvent())
  assert.equal(prompts, 0)
})

test("pending restart reconciliation observes a response already present in the transcript", async () => {
  const messages = [
    assistantMessage("a1", "Latest output before enqueue."),
    assistantMessage("a2", "Recovered handoff.", { output: 11 }),
  ]
  let prompts = 0
  const client: OpencodeClient = {
    session: {
      messages: async () => ({ data: messages }),
      promptAsync: async () => {
        prompts += 1
        return {}
      },
    },
  }
  const { runtime, store } = runtimeFixture(client)
  await seedGoal(store)
  await updateGoal(store, (draft) => {
    draft.budgetWrapupSent = true
    draft.budgetWrapupPending = true
    draft.budgetWrapupLimitReason = "Duration budget reached."
    draft.budgetWrapupBaselineAssistantMessageId = "a1"
  })

  await runtime.handleEvent(idleEvent())

  const terminal = store.read("s1")?.goal
  assert.equal(terminal?.status, "budgetLimited")
  assert.equal(terminal?.lastAssistantMessageId, "a2")
  assert.equal(terminal?.tokensUsed, 11)
  assert.equal(terminal?.budgetWrapupPending, false)
  assert.equal(prompts, 0)
})
