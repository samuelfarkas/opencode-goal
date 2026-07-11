import assert from "node:assert/strict"
import test from "node:test"
import { clearGoalSessionTitle, goalSessionTitle, goalStatusToast, notifyGoalStatusChange, updateGoalSessionTitle } from "../src/notify.ts"
import { GoalStore, createGoal } from "../src/store.ts"
import type { OpencodeClient, ThreadGoalStatus } from "../src/types.ts"

test("goalStatusToast distinguishes a created goal from a resumed one", () => {
  const goal = createGoal("s1", "ship the feature", null)
  assert.deepEqual(goalStatusToast(goal, undefined), { message: "Goal: ship the feature", variant: "info" })
  assert.deepEqual(goalStatusToast(goal, "paused"), { message: "Goal resumed: ship the feature", variant: "info" })
})

test("goalStatusToast maps terminal and limited states", () => {
  const goal = createGoal("s1", "ship", null)
  goal.status = "complete"
  assert.equal(goalStatusToast(goal, "active")?.variant, "success")
  goal.status = "blocked"
  goal.blockedReason = "missing credentials"
  assert.deepEqual(goalStatusToast(goal, "active"), { message: "⚠ Goal blocked: missing credentials", variant: "error" })
  goal.status = "budgetLimited"
  assert.equal(goalStatusToast(goal, "active")?.variant, "warning")
})

test("goalStatusToast collapses whitespace and truncates long objectives", () => {
  const goal = createGoal("s1", `${"x".repeat(200)}   spill`, null)
  const toast = goalStatusToast(goal, undefined)
  assert.ok(toast)
  const message = toast ? toast.message : ""
  assert.ok(message.length < 100)
  assert.ok(message.endsWith("…"))
})

test("GoalStore fires the status listener once per real transition, never on same-status writes", async () => {
  const events: Array<{ status: ThreadGoalStatus; previous: ThreadGoalStatus | undefined }> = []
  const store = new GoalStore("", false, (goal, previous) => events.push({ status: goal.status, previous }))

  const created = await store.replace(createGoal("s1", "do it", null)) // undefined -> active
  const counted = await store.update("s1", created.revision, (draft) => {
    draft.tokensUsed = 4242
    return { commit: true, value: undefined }
  }) // active -> active (must stay quiet)
  if (!counted.applied) throw new Error("token update was not applied")
  await store.update("s1", counted.snapshot.revision, (draft) => {
    draft.status = "complete"
    return { commit: true, value: undefined }
  }) // active -> complete

  assert.deepEqual(events, [
    { status: "active", previous: undefined },
    { status: "complete", previous: "active" },
  ])
})

test("a re-created goal on the same thread after clear notifies again", async () => {
  const events: ThreadGoalStatus[] = []
  const store = new GoalStore("", false, (goal) => events.push(goal.status))
  await store.replace(createGoal("s1", "first", null))
  await store.clear("s1")
  await store.replace(createGoal("s1", "second", null))
  assert.deepEqual(events, ["active", "active"])
})

test("GoalStore.clear fires the clear listener with the goal; set/clear survive throwing listeners", async () => {
  const cleared: string[] = []
  const store = new GoalStore(
    "",
    false,
    () => {
      throw new Error("status listener boom")
    },
    (goal) => {
      cleared.push(goal.threadId)
      throw new Error("clear listener boom")
    },
  )
  // A throwing status listener must not break replace().
  await store.replace(createGoal("s1", "do it", null))
  // A throwing clear listener must not break clear(), and must receive the goal.
  assert.equal(await store.clear("s1"), true)
  assert.deepEqual(cleared, ["s1"])
  // Clearing a non-existent goal does not fire the clear listener.
  assert.equal(await store.clear("nope"), false)
  assert.deepEqual(cleared, ["s1"])
})

test("conflicting status transitions notify only for the committed revision", async () => {
  const events: Array<{ status: ThreadGoalStatus; previous: ThreadGoalStatus | undefined }> = []
  const store = new GoalStore("", false, (goal, previous) => events.push({ status: goal.status, previous }))
  const created = await store.replace(createGoal("s1", "do it", null))

  const results = await Promise.all([
    store.update("s1", created.revision, (draft) => {
      draft.status = "complete"
      return { commit: true, value: undefined }
    }),
    store.update("s1", created.revision, (draft) => {
      draft.status = "paused"
      return { commit: true, value: undefined }
    }),
  ])

  assert.equal(results.filter((result) => result.applied).length, 1)
  assert.deepEqual(events, [
    { status: "active", previous: undefined },
    { status: "complete", previous: "active" },
  ])
})

test("notifyGoalStatusChange forwards a mapped payload to client.tui.showToast, preserving its receiver", () => {
  const calls: Array<{ body: unknown }> = []
  let receiver: unknown = "unset"
  const tui = {
    showToast(input: { body: unknown }) {
      // The generated SDK method relies on `this`; a detached call loses it.
      receiver = this
      calls.push(input)
      return Promise.resolve(true)
    },
  }
  const client = { tui } as unknown as OpencodeClient
  notifyGoalStatusChange(client, createGoal("s1", "ship", null), undefined)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.body, { title: "Goal", message: "Goal: ship", variant: "info" })
  assert.equal(receiver, tui)
})

test("goalSessionTitle leads with a status glyph and the objective", () => {
  const goal = createGoal("s1", "fix the flaky checkout test", null)
  assert.equal(goalSessionTitle(goal), "⟳ fix the flaky checkout test")
  goal.status = "complete"
  assert.equal(goalSessionTitle(goal), "✓ fix the flaky checkout test")
  goal.status = "blocked"
  assert.equal(goalSessionTitle(goal), "✗ fix the flaky checkout test")
})

test("goalSessionTitle truncates long objectives to a session-title length", () => {
  const goal = createGoal("s1", "x".repeat(200), null)
  const title = goalSessionTitle(goal)
  assert.ok(title.length <= 56)
  assert.ok(title.startsWith("⟳ "))
  assert.ok(title.endsWith("…"))
})

test("goalSessionTitle truncates on code points without splitting surrogate pairs", () => {
  const goal = createGoal("s1", "😀".repeat(60), null)
  const title = goalSessionTitle(goal)
  // strip valid surrogate pairs; nothing left may be a lone surrogate
  assert.ok(!/[\uD800-\uDFFF]/.test(title.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")))
  assert.ok(title.startsWith("⟳ "))
  assert.ok(title.endsWith("…"))
})

test("clearGoalSessionTitle drops the glyph, leaving the bare objective", () => {
  const calls: Array<{ path: { id: string }; body: { title?: string } }> = []
  const session = {
    update(input: { path: { id: string }; body: { title?: string } }) {
      calls.push(input)
      return Promise.resolve(true)
    },
  }
  const client = { session } as unknown as OpencodeClient
  const goal = createGoal("s3", "fix it", null)
  goal.status = "complete"
  clearGoalSessionTitle(client, goal)
  assert.deepEqual(calls, [{ path: { id: "s3" }, body: { title: "fix it" } }])
})

test("updateGoalSessionTitle sets the title via client.session.update, preserving its receiver", () => {
  const calls: Array<{ path: { id: string }; body: { title?: string } }> = []
  let receiver: unknown = "unset"
  const session = {
    update(input: { path: { id: string }; body: { title?: string } }) {
      // The generated SDK method relies on `this`; a detached call loses it.
      receiver = this
      calls.push(input)
      return Promise.resolve(true)
    },
  }
  const client = { session } as unknown as OpencodeClient
  updateGoalSessionTitle(client, createGoal("s9", "ship it", null))
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { path: { id: "s9" }, body: { title: "⟳ ship it" } })
  assert.equal(receiver, session)
})

test("updateGoalSessionTitle is a safe no-op without a session.update surface", () => {
  const goal = createGoal("s1", "ship", null)
  let threw = false
  try {
    updateGoalSessionTitle(undefined, goal)
    updateGoalSessionTitle({}, goal)
    updateGoalSessionTitle({ session: {} }, goal)
  } catch {
    threw = true
  }
  assert.equal(threw, false)
})

test("notifyGoalStatusChange is a safe no-op without a toast surface", () => {
  const goal = createGoal("s1", "ship", null)
  let threw = false
  try {
    notifyGoalStatusChange(undefined, goal, undefined)
    notifyGoalStatusChange({}, goal, undefined)
  } catch {
    threw = true
  }
  assert.equal(threw, false)
})
