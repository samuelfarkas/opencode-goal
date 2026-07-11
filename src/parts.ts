import { GOAL_LIMITS, codePointLength } from "./goal-contract.ts"
import type { MessagePart, SessionMessage, StoredGoal, TextPart } from "./types.ts"

export function textPart(text: string): TextPart {
  return { type: "text", text }
}

export function partText(parts: readonly MessagePart[] | undefined): string {
  return (parts ?? [])
    .filter((part): part is TextPart => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

export function messageRole(message: SessionMessage | undefined): string {
  if (!message) return ""
  if (typeof message.info?.role === "string") return message.info.role
  if (typeof message.role === "string") return message.role
  return ""
}

export function messageId(message: SessionMessage | undefined): string {
  const id = typeof message?.info?.id === "string" ? message.info.id : ""
  return codePointLength(id) <= GOAL_LIMITS.identifierCodePoints ? id : ""
}

export function latestAssistant(messages: readonly SessionMessage[]): SessionMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (messageRole(message) === "assistant") return message
  }
  return undefined
}

export function hasToolPart(message: SessionMessage | undefined): boolean {
  return (message?.parts ?? []).some((part) => part.type === "tool" || part.type === "tool-invocation" || part.type === "subtask")
}

export function outputTokens(message: SessionMessage | undefined): number {
  const info = message?.info
  const output = info && "tokens" in info ? info.tokens?.output ?? 0 : 0
  return Number.isSafeInteger(output) && output >= 0 ? output : 0
}

export function totalTokens(message: SessionMessage | undefined): number {
  const info = message?.info
  const tokens = info && "tokens" in info ? info.tokens : undefined
  if (!tokens) return 0
  const values = [
    tokens.input ?? 0,
    tokens.output ?? 0,
    tokens.reasoning ?? 0,
    tokens.cache?.read ?? 0,
    tokens.cache?.write ?? 0,
  ]
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return 0
  const total = values.reduce((sum, value) => sum + value, 0)
  return Number.isSafeInteger(total) ? total : 0
}

export function applyAssistantTokenTotal(
  goal: StoredGoal,
  message: SessionMessage | undefined,
  maxRecentMessages: number,
): { changed: boolean; delta: number } {
  if (messageRole(message) !== "assistant") return { changed: false, delta: 0 }
  const id = messageId(message)
  if (!id) return { changed: false, delta: 0 }
  const rawTotal = totalTokens(message)
  const observedTotal = Number.isSafeInteger(rawTotal) ? Math.max(0, rawTotal) : 0
  const totals = goal.assistantTokenTotals ?? []
  goal.assistantTokenTotals = totals
  const index = totals.findIndex((entry) => entry.messageId === id)
  const previousTotal = index === -1 ? 0 : totals[index]?.total ?? 0
  const nextTotal = Math.max(previousTotal, observedTotal)
  const delta = nextTotal - previousTotal

  if (index === -1) totals.push({ messageId: id, total: nextTotal })
  else if (totals[index]) totals[index].total = nextTotal
  const limit = Math.max(1, Math.floor(maxRecentMessages))
  const beforeTrim = totals.length
  if (totals.length > limit) {
    totals.splice(0, totals.length - limit)
  }
  if (delta > 0) goal.tokensUsed = Math.min(Number.MAX_SAFE_INTEGER, goal.tokensUsed + delta)
  return { changed: index === -1 || delta > 0 || totals.length !== beforeTrim, delta }
}
