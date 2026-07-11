import { isRecord } from "./records.ts"
import { promptErrorFromMessage, promptErrorFromValue } from "./usage-window.ts"
import type { PromptError } from "./usage-window.ts"
import type { EventEnvelope, SessionMessage } from "./types.ts"

export type GoalRuntimeEvent =
  | { type: "messageUpdated"; sessionID: string | undefined; message: SessionMessage | undefined }
  | { type: "partChanged"; sessionID: string | undefined }
  | { type: "activity"; sessionID: string | undefined }
  | { type: "idle"; sessionID: string | undefined }
  | { type: "sessionDeleted"; sessionID: string | undefined }
  | { type: "promptError"; sessionID: string | undefined; error: PromptError | undefined }

function property(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

function stringProperty(value: unknown, key: string): string | undefined {
  const found = property(value, key)
  return typeof found === "string" ? found : undefined
}

function eventSessionId(properties: Record<string, unknown> | undefined): string | undefined {
  const direct = properties?.sessionID
  if (typeof direct === "string") return direct
  return stringProperty(properties?.info, "sessionID") ?? stringProperty(properties?.part, "sessionID")
}

function eventMessage(properties: Record<string, unknown> | undefined): SessionMessage | undefined {
  const message = properties?.message
  if (typeof message === "object" && message !== null) return message as SessionMessage
  if (typeof properties?.info === "object" || Array.isArray(properties?.parts)) return properties as SessionMessage
  return undefined
}

function eventError(properties: Record<string, unknown> | undefined): PromptError | undefined {
  return promptErrorFromValue(properties?.error) ?? promptErrorFromMessage(properties?.message)
}

function isIdleEvent(event: EventEnvelope["event"]): boolean {
  return (
    event?.type === "session.idle" ||
    (event?.type === "session.status" &&
      stringProperty(event.properties?.status, "type") === "idle")
  )
}

export function normalizeGoalEvent({ event }: EventEnvelope): GoalRuntimeEvent | undefined {
  if (!event) return undefined
  if (event.type === "message.updated") {
    const message = eventMessage(event.properties)
    return {
      type: "messageUpdated",
      sessionID: eventSessionId(event.properties) ?? message?.info?.sessionID,
      message,
    }
  }
  if (event.type === "message.part.updated") {
    return { type: "partChanged", sessionID: eventSessionId(event.properties) }
  }
  if (event.type === "session.error") {
    return { type: "promptError", sessionID: eventSessionId(event.properties), error: eventError(event.properties) }
  }
  if (event.type === "session.deleted") {
    return { type: "sessionDeleted", sessionID: eventSessionId(event.properties) }
  }
  if (isIdleEvent(event)) {
    return { type: "idle", sessionID: eventSessionId(event.properties) }
  }
  if (event.type === "session.status") {
    return { type: "activity", sessionID: eventSessionId(event.properties) }
  }
  return undefined
}
