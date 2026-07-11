import { codePointLength, truncateCodePoints } from "./goal-contract.ts"

export const DOCTOR_PACKAGE_SPEC = "@samuelfarkas/opencode-goal"
export const DOCTOR_RELEASE_CHECK = "bun run release:check"
export const DOCTOR_HOST_SMOKE = "OPENCODE_BIN=/path/to/opencode bun run smoke:host"

const REASON_CODE_POINTS = 700
const OUTPUT_CODE_POINTS = 24 * 1024
const MINIMUM_VERSION = [1, 17, 9] as const

export type DoctorCapabilityStatus = "available" | "unavailable" | "registered-unverified" | "unknown"

export type DoctorCapabilityKey =
  | "package"
  | "opencode"
  | "configuration"
  | "transcript"
  | "prompt"
  | "session-status"
  | "session-title"
  | "toast"
  | "app-log"
  | "tool-factory"
  | "persistence"
  | "state-snapshot"
  | "result-archive"
  | "system-hook"
  | "compaction-hook"
  | "autocontinue-hook"

export type DoctorCapability = {
  key: DoctorCapabilityKey
  label: string
  status: DoctorCapabilityStatus
  reason: string
  affectsReadiness: boolean
}

export type DoctorReport = {
  ready: boolean
  capabilities: DoctorCapability[]
}

export type DoctorFileObservation = {
  status: "available" | "unavailable"
  reason: string
}

export type DoctorPersistenceObservation = {
  enabled: boolean
  path: string
  projectLocal: boolean
  state: DoctorFileObservation
  archive: DoctorFileObservation
}

export type DoctorObservation = {
  packageVersion?: string
  supportedOpenCodeRange?: string
  openCodeVersion?: string
  openCodeError?: string
  configurationStatus: DoctorCapabilityStatus
  configurationReason: string
  registerTools?: boolean
  toolFactoryAvailable: boolean
  persistence?: DoctorPersistenceObservation
  hooks: {
    system: boolean
    compaction: boolean
    autocontinue: boolean
  }
}

const CAPABILITY_ORDER: readonly DoctorCapabilityKey[] = [
  "package",
  "opencode",
  "configuration",
  "transcript",
  "prompt",
  "session-status",
  "session-title",
  "toast",
  "app-log",
  "tool-factory",
  "persistence",
  "state-snapshot",
  "result-archive",
  "system-hook",
  "compaction-hook",
  "autocontinue-hook",
]

export function doctorErrorMessage(error: unknown): string {
  return truncateCodePoints(error instanceof Error ? error.message : String(error), REASON_CODE_POINTS)
}

function parseVersion(value: string): readonly [number, number, number] | undefined {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return undefined
  const parts = match.slice(1).map(Number)
  const major = parts[0]
  const minor = parts[1]
  const patch = parts[2]
  return major === undefined || minor === undefined || patch === undefined ? undefined : [major, minor, patch]
}

function compatibleOpenCodeVersion(value: string): boolean {
  const version = parseVersion(value)
  if (!version || version[0] !== 1) return false
  if (version[1] !== MINIMUM_VERSION[1]) return version[1] > MINIMUM_VERSION[1]
  return version[2] >= MINIMUM_VERSION[2]
}

function capability(
  key: DoctorCapabilityKey,
  label: string,
  status: DoctorCapabilityStatus,
  reason: string,
  affectsReadiness = false,
): DoctorCapability {
  return {
    key,
    label,
    status,
    reason: truncateCodePoints(reason.replace(/\s+/g, " ").trim(), REASON_CODE_POINTS),
    affectsReadiness,
  }
}

export function buildDoctorReport(observation: DoctorObservation): DoctorReport {
  const packageAvailable = Boolean(observation.packageVersion && observation.supportedOpenCodeRange)
  const openCodeAvailable = Boolean(observation.openCodeVersion && compatibleOpenCodeVersion(observation.openCodeVersion))
  const configurationUnavailable = observation.configurationStatus === "unavailable"
  const toolStatus: DoctorCapabilityStatus = observation.registerTools === false
    ? "unavailable"
    : observation.toolFactoryAvailable ? "available" : "unavailable"
  const persistenceStatus: DoctorCapabilityStatus = observation.persistence
    ? observation.persistence.enabled ? "available" : "unavailable"
    : observation.configurationStatus === "unavailable" ? "unavailable" : "unknown"
  const persistenceReason = observation.persistence
    ? observation.persistence.enabled
      ? `${observation.persistence.projectLocal ? "project-local" : "explicit absolute"} path validated: ${observation.persistence.path}`
      : "disabled by plugin configuration"
    : observation.configurationStatus === "unavailable"
      ? "persistence options could not be resolved"
      : "pass --config to resolve persistence settings"
  const stateStatus = observation.persistence?.enabled
    ? observation.persistence.state.status
    : observation.persistence ? "unknown" : persistenceStatus === "unavailable" ? "unavailable" : "unknown"
  const archiveStatus = observation.persistence?.enabled
    ? observation.persistence.archive.status
    : observation.persistence ? "unknown" : persistenceStatus === "unavailable" ? "unavailable" : "unknown"
  const stateReason = observation.persistence?.enabled
    ? observation.persistence.state.reason
    : observation.persistence ? "persistence is disabled; no state file was inspected" : persistenceReason
  const archiveReason = observation.persistence?.enabled
    ? observation.persistence.archive.reason
    : observation.persistence ? "persistence is disabled; no archive file was inspected" : persistenceReason

  const rows: DoctorCapability[] = [
    capability(
      "package",
      "Package contract",
      packageAvailable ? "available" : "unavailable",
      packageAvailable
        ? `${DOCTOR_PACKAGE_SPEC} ${observation.packageVersion}; OpenCode ${observation.supportedOpenCodeRange}`
        : "package version or supported OpenCode range is unavailable",
      !packageAvailable,
    ),
    capability(
      "opencode",
      "OpenCode binary",
      openCodeAvailable ? "available" : "unavailable",
      observation.openCodeVersion
        ? openCodeAvailable
          ? `${observation.openCodeVersion} is within ${observation.supportedOpenCodeRange ?? ">=1.17.9 <2"}`
          : `${observation.openCodeVersion} is outside ${observation.supportedOpenCodeRange ?? ">=1.17.9 <2"}`
        : observation.openCodeError ?? "version could not be observed",
      !openCodeAvailable,
    ),
    capability(
      "configuration",
      "Plugin configuration",
      observation.configurationStatus,
      observation.configurationReason,
      configurationUnavailable,
    ),
    capability("transcript", "Transcript reads", "unknown", "standalone doctor has no live host client"),
    capability("prompt", "Async prompt", "unknown", "standalone doctor does not contact a host session or provider"),
    capability("session-status", "Session status", "unknown", "standalone doctor has no live host client"),
    capability("session-title", "Session title update", "unknown", "standalone doctor has no live host client"),
    capability("toast", "TUI toast", "unknown", "standalone doctor has no live host client"),
    capability("app-log", "App log", "unknown", "standalone doctor has no live host client"),
    capability(
      "tool-factory",
      "Agent tool factory",
      toolStatus,
      observation.registerTools === false
        ? "disabled by plugin configuration"
        : observation.toolFactoryAvailable
          ? observation.registerTools === true
            ? "module loaded and registration is enabled"
            : "module loaded; pass --config to confirm registration setting"
          : "@opencode-ai/plugin tool factory could not be loaded",
      observation.registerTools !== false && !observation.toolFactoryAvailable,
    ),
    capability("persistence", "Persistence", persistenceStatus, persistenceReason, configurationUnavailable),
    capability(
      "state-snapshot",
      "State snapshot",
      stateStatus,
      stateReason,
      observation.persistence?.enabled === true && stateStatus === "unavailable",
    ),
    capability(
      "result-archive",
      "Result archive",
      archiveStatus,
      archiveReason,
      observation.persistence?.enabled === true && archiveStatus === "unavailable",
    ),
    capability(
      "system-hook",
      "System prompt hook",
      observation.hooks.system ? "registered-unverified" : "unavailable",
      observation.hooks.system ? "returned by local plugin initialization; host invocation is not proven" : "hook was not returned",
      !observation.hooks.system,
    ),
    capability(
      "compaction-hook",
      "Compaction hook",
      observation.hooks.compaction ? "registered-unverified" : "unavailable",
      observation.hooks.compaction ? "returned by local plugin initialization; host invocation is not proven" : "hook was not returned",
      !observation.hooks.compaction,
    ),
    capability(
      "autocontinue-hook",
      "Compaction autocontinue hook",
      observation.hooks.autocontinue ? "registered-unverified" : "unavailable",
      observation.hooks.autocontinue ? "returned by local plugin initialization; host invocation is not proven" : "hook was not returned",
      !observation.hooks.autocontinue,
    ),
  ]
  rows.sort((left, right) => CAPABILITY_ORDER.indexOf(left.key) - CAPABILITY_ORDER.indexOf(right.key))
  return {
    ready: !rows.some((row) => row.affectsReadiness && row.status === "unavailable"),
    capabilities: rows,
  }
}

export function formatDoctorReport(report: DoctorReport): string {
  const unknownCount = report.capabilities.filter((item) => item.status === "unknown").length
  const ordered = [...report.capabilities]
    .sort((left, right) => CAPABILITY_ORDER.indexOf(left.key) - CAPABILITY_ORDER.indexOf(right.key))
  const lines = [
    `OpenCode Goal Doctor: ${report.ready ? "READY" : "DEGRADED"}`,
    `Read-only local checks complete; ${unknownCount} capabilit${unknownCount === 1 ? "y remains" : "ies remain"} unknown.`,
    "Live host-client surfaces were not probed.",
    "No model or provider was contacted.",
    "",
    ...ordered.map((item) => `[${item.status}] ${item.label}: ${item.reason}`),
    "",
    "Release verification:",
    `  ${DOCTOR_RELEASE_CHECK}`,
    `  ${DOCTOR_HOST_SMOKE}`,
  ]
  const output = lines.join("\n")
  return codePointLength(output) <= OUTPUT_CODE_POINTS ? output : truncateCodePoints(output, OUTPUT_CODE_POINTS)
}
