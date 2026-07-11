import { GOAL_LIMITS, truncateCodePoints } from "./goal-contract.ts"
import { isRecord } from "./records.ts"
import { touchGoal } from "./store.ts"
import type { GoalClock, StoredGoal } from "./types.ts"

export type PromptError = {
  name?: string
  message?: string
  statusCode?: number
  headers?: Record<string, string>
}

export type UsageLimitWait = {
  detail: string
  waitSeconds: number
}

function property(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

function stringProperty(value: unknown, key: string): string | undefined {
  const found = property(value, key)
  return typeof found === "string" ? truncateCodePoints(found, GOAL_LIMITS.detailCodePoints) : undefined
}

function numberProperty(value: unknown, key: string): number | undefined {
  const found = property(value, key)
  return typeof found === "number" ? found : undefined
}

function headersProperty(value: unknown, key: string): Record<string, string> | undefined {
  const found = property(value, key)
  if (!isRecord(found)) return undefined
  const headers: Record<string, string> = {}
  for (const [header, headerValue] of Object.entries(found)) {
    if (typeof headerValue === "string") {
      headers[truncateCodePoints(header.toLowerCase(), GOAL_LIMITS.markerCodePoints)] =
        truncateCodePoints(headerValue, GOAL_LIMITS.detailCodePoints)
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

export function promptErrorFromValue(value: unknown): PromptError | undefined {
  if (!isRecord(value)) return undefined
  const data = property(value, "data")
  const result: PromptError = {}
  const name = stringProperty(value, "name")
  const directMessage = stringProperty(value, "message")
  const dataMessage = stringProperty(data, "message")
  const directStatusCode = numberProperty(value, "statusCode")
  const dataStatusCode = numberProperty(data, "statusCode")
  const directHeaders = headersProperty(value, "responseHeaders")
  const dataHeaders = headersProperty(data, "responseHeaders")
  const message = directMessage ?? dataMessage
  const statusCode = directStatusCode ?? dataStatusCode
  const headers = directHeaders ?? dataHeaders
  if (name) result.name = name
  if (message) result.message = message
  if (statusCode !== undefined) result.statusCode = statusCode
  if (headers) result.headers = headers
  return Object.keys(result).length > 0 ? result : undefined
}

export function promptErrorFromUnknown(error: unknown): PromptError {
  const promptError = promptErrorFromValue(error)
  if (promptError) return promptError
  if (error instanceof Error) {
    return {
      name: truncateCodePoints(error.name, GOAL_LIMITS.markerCodePoints),
      message: truncateCodePoints(error.message, GOAL_LIMITS.detailCodePoints),
    }
  }
  return { message: truncateCodePoints(String(error), GOAL_LIMITS.detailCodePoints) }
}

export function promptErrorFromMessage(message: unknown): PromptError | undefined {
  return typeof message === "string" ? { message } : undefined
}

export function promptErrorDetail(error: PromptError | undefined): string {
  return truncateCodePoints(
    [error?.message, error?.name, error?.statusCode === undefined ? "" : String(error.statusCode)]
      .filter(Boolean)
      .join(" ") || "unknown error",
    GOAL_LIMITS.detailCodePoints,
  )
}

export function isProviderUsageLimit(error: PromptError | undefined): boolean {
  if (error?.statusCode === 429) return true
  const detail = `${error?.name ?? ""} ${promptErrorDetail(error)}`.toLowerCase()
  const looksLikeContextLimit =
    /\b(context|input|prompt)\b.{0,30}\b(limit|length|too large|maximum|max)\b/.test(detail) ||
    /\b(limit|length|too large|maximum|max)\b.{0,30}\b(context|input|prompt)\b/.test(detail)
  if (looksLikeContextLimit && !/\b(rate|usage|quota|budget|429|too many requests)\b/.test(detail)) return false

  return (
    /\b429\b/.test(detail) ||
    /\brate[- ]?limit(?:ed|s)?\b/.test(detail) ||
    /\busage limit(?:ed)?\b/.test(detail) ||
    /\bquota\b/.test(detail) ||
    /\bbudget\b/.test(detail) ||
    /\btoo many requests\b/.test(detail) ||
    /\b(window\b.{0,40}\blimit|limit\b.{0,40}\bwindow)\b/.test(detail) ||
    /\b(exceeded\b.{0,40}\blimit|limit\b.{0,40}\bexceeded)\b/.test(detail)
  )
}

function durationAmountToSeconds(amount: number, unit: string): number {
  if (unit.startsWith("h")) return amount * 60 * 60
  if (unit === "m" || unit.startsWith("min")) return amount * 60
  if (unit.startsWith("ms") || unit.startsWith("mill")) return amount / 1000
  return amount
}

function parseDurationSeconds(value: string): number {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return 0
  if (/^\d+$/.test(normalized)) return Number(normalized)
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000))
  let seconds = 0
  for (const match of normalized.matchAll(/(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/g)) {
    const amount = Number(match[1])
    const unit = match[2] ?? ""
    if (!Number.isFinite(amount) || amount <= 0) continue
    seconds += durationAmountToSeconds(amount, unit)
  }
  return Math.ceil(seconds)
}

function headerWaitSeconds(headers: Record<string, string> | undefined): number {
  if (!headers) return 0
  const waits = [
    headers["retry-after"],
    headers["x-ratelimit-reset-requests"],
    headers["x-ratelimit-reset-tokens"],
  ].map((value) => (value ? parseDurationSeconds(value) : 0))
  return Math.max(0, ...waits)
}

export function parseWaitSeconds(error: PromptError | undefined, fallbackSeconds: number): number {
  const headerWait = headerWaitSeconds(error?.headers)
  if (headerWait > 0) return headerWait
  const detail = promptErrorDetail(error).toLowerCase()
  const unitMatch = detail.match(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/)
  if (unitMatch) {
    const amount = Number(unitMatch[1])
    const unit = unitMatch[2] ?? ""
    if (Number.isFinite(amount) && amount > 0) {
      return Math.ceil(durationAmountToSeconds(amount, unit))
    }
  }

  const retryAfterMatch = detail.match(/\bretry[- ]after\s*:?\s*(\d+)\b/)
  if (retryAfterMatch) {
    const seconds = Number(retryAfterMatch[1])
    if (Number.isInteger(seconds) && seconds > 0) return seconds
  }

  return fallbackSeconds
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export function usageWaitRemaining(goal: StoredGoal, clock: GoalClock = nowSeconds): number {
  return Math.max(0, goal.usageLimitedUntil - clock())
}

export function clearUsageLimitWait(goal: StoredGoal, detail: string, clock?: GoalClock): boolean {
  if (goal.usageLimitedUntil === 0 && !goal.usageLimitedReason) return false
  goal.usageLimitedUntil = 0
  goal.usageLimitedReason = ""
  touchGoal(goal, "usageLimitWaitCleared", detail, clock)
  return true
}

export function applyUsageLimitWait(
  goal: StoredGoal,
  error: PromptError | undefined,
  fallbackSeconds: number,
  clock: GoalClock = nowSeconds,
): UsageLimitWait | undefined {
  if (!isProviderUsageLimit(error)) return undefined

  const detail = promptErrorDetail(error)
  const parsedWaitSeconds = parseWaitSeconds(error, fallbackSeconds)
  const now = clock()
  const waitSeconds = Number.isSafeInteger(parsedWaitSeconds) && parsedWaitSeconds > 0
    ? Math.min(parsedWaitSeconds, Number.MAX_SAFE_INTEGER - now)
    : fallbackSeconds
  goal.status = "active"
  goal.usageLimitedUntil = now + waitSeconds
  goal.usageLimitedReason = detail
  goal.promptFailureCount = 0
  touchGoal(goal, "usageLimitWait", `Waiting ${waitSeconds}s for provider usage window to reset: ${detail}`, clock)
  return { detail, waitSeconds }
}
