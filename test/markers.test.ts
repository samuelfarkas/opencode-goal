import assert from "node:assert/strict"
import test from "node:test"
import { markerVerdict } from "../src/markers.ts"

const config = {
  completionMarker: "[goal:complete]",
  blockedMarker: "[goal:blocked]",
  evidenceMarker: "[goal:evidence]",
}

test("completion requires a final marker and evidence", () => {
  assert.deepEqual(
    markerVerdict("Done\n[goal:evidence] tests passed\n[goal:complete]", config),
    { status: "complete", evidence: "tests passed" },
  )
  assert.deepEqual(markerVerdict("Done\n[goal:complete]", config), { status: "missing-evidence" })
  assert.deepEqual(markerVerdict("Done\n[goal:evidence] tests passed\n[goal:complete] extra", config), { status: "none" })
})

test("blocked requires a concrete line before the final marker", () => {
  assert.deepEqual(
    markerVerdict("Need the production token.\n[goal:blocked]", config),
    { status: "blocked", reason: "Need the production token." },
  )
  assert.deepEqual(markerVerdict("[goal:blocked]", config), { status: "missing-blocker" })
})
