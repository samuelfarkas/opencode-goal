import type { ThreadGoalStatus } from "./types.ts"

export type MarkerVerdict =
  | { status: "complete"; evidence: string }
  | { status: "blocked"; reason: string }
  | { status: "missing-evidence" }
  | { status: "missing-blocker" }
  | { status: "none" }

export type MarkerConfig = {
  completionMarker: string
  blockedMarker: string
  evidenceMarker: string
}

function finalNonEmptyLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? ""
}

function lineBeforeFinal(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.length >= 2 ? lines[lines.length - 2] ?? "" : ""
}

export function markerVerdict(text: string, config: MarkerConfig): MarkerVerdict {
  const finalLine = finalNonEmptyLine(text)
  if (finalLine === config.completionMarker) {
    const evidence = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith(config.evidenceMarker))
      .map((line) => line.slice(config.evidenceMarker.length).trim())
      .filter(Boolean)
      .at(-1)
    return evidence ? { status: "complete", evidence } : { status: "missing-evidence" }
  }
  if (finalLine === config.blockedMarker) {
    const reason = lineBeforeFinal(text)
    return reason && reason !== config.blockedMarker ? { status: "blocked", reason } : { status: "missing-blocker" }
  }
  return { status: "none" }
}

export function isTerminalStatus(status: ThreadGoalStatus): boolean {
  return status === "blocked" || status === "budgetLimited" || status === "complete"
}
