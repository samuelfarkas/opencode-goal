import { resolve } from "node:path"
import { isRecord } from "./records.ts"
import { buildDoctorReport, doctorErrorMessage, formatDoctorReport } from "./doctor-report.ts"
import { defaultDoctorDependencies, readDoctorConfiguration } from "./doctor-inspection.ts"
import type { DoctorDependencies } from "./doctor-inspection.ts"

export { buildDoctorReport, formatDoctorReport } from "./doctor-report.ts"
export type {
  DoctorCapability,
  DoctorCapabilityKey,
  DoctorCapabilityStatus,
  DoctorFileObservation,
  DoctorObservation,
  DoctorPersistenceObservation,
  DoctorReport,
} from "./doctor-report.ts"

export type DoctorRunResult = {
  exitCode: number
  output: string
}

type DoctorArguments = {
  help: boolean
  configPath?: string
  openCodeBinary: string
}

class DoctorArgumentError extends Error {}

export const DOCTOR_USAGE = [
  "Usage: opencode-goal doctor [--config <path>] [--opencode-bin <path>]",
  "",
  "Runs read-only local diagnostics. It does not contact a model or provider.",
  "",
  "Options:",
  "  --config PATH        Read plugin options from a strict-JSON OpenCode config",
  "  --opencode-bin PATH  Binary used only for `--version` (default: opencode)",
  "  --help               Show this help",
].join("\n")

function parseArguments(args: readonly string[]): DoctorArguments {
  let help = false
  let configPath: string | undefined
  let openCodeBinary = "opencode"
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index] ?? ""
    const argument = raw === "-h" ? "--help" : raw
    if (argument !== "--help" && argument !== "--config" && argument !== "--opencode-bin") {
      throw new DoctorArgumentError(`Unknown doctor argument: ${raw}`)
    }
    if (seen.has(argument)) throw new DoctorArgumentError(`Duplicate doctor argument: ${argument}`)
    seen.add(argument)
    if (argument === "--help") {
      help = true
      continue
    }
    const value = args[index + 1]
    if (!value || value.startsWith("-")) throw new DoctorArgumentError(`Missing value for ${argument}`)
    if (argument === "--config") configPath = resolve(value)
    else openCodeBinary = value
    index += 1
  }
  return configPath === undefined ? { help, openCodeBinary } : { help, configPath, openCodeBinary }
}

function packageObservation(value: unknown): { version?: string; range?: string } {
  if (!isRecord(value)) return {}
  const engines = isRecord(value.engines) ? value.engines : undefined
  const peers = isRecord(value.peerDependencies) ? value.peerDependencies : undefined
  const version = typeof value.version === "string" ? value.version : undefined
  const range = peers && typeof peers["@opencode-ai/plugin"] === "string"
    ? peers["@opencode-ai/plugin"]
    : engines && typeof engines.opencode === "string" ? engines.opencode : undefined
  return {
    ...(version === undefined ? {} : { version }),
    ...(range === undefined ? {} : { range }),
  }
}

export async function runDoctor(
  args: readonly string[],
  directory = process.cwd(),
  dependencies: DoctorDependencies = defaultDoctorDependencies,
): Promise<DoctorRunResult> {
  let parsed: DoctorArguments
  try {
    parsed = parseArguments(args)
  } catch (error) {
    return { exitCode: 1, output: `${doctorErrorMessage(error)}\n\n${DOCTOR_USAGE}` }
  }
  if (parsed.help) return { exitCode: 0, output: DOCTOR_USAGE }

  const nowSeconds = dependencies.nowSeconds()
  const [metadataResult, versionResult, toolResult, hooksResult, config] = await Promise.all([
    dependencies.packageMetadata().then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const, value: undefined }),
    ),
    dependencies.openCodeVersion(parsed.openCodeBinary),
    dependencies.toolFactoryAvailable().then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const, value: false }),
    ),
    dependencies.hooks(directory).then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const, value: { system: false, compaction: false, autocontinue: false } }),
    ),
    readDoctorConfiguration(parsed.configPath, directory, nowSeconds),
  ])
  const metadata = metadataResult.ok ? packageObservation(metadataResult.value) : {}
  const report = buildDoctorReport({
    ...(metadata.version === undefined ? {} : { packageVersion: metadata.version }),
    ...(metadata.range === undefined ? {} : { supportedOpenCodeRange: metadata.range }),
    ...(versionResult.version === undefined ? {} : { openCodeVersion: versionResult.version }),
    ...(versionResult.error === undefined ? {} : { openCodeError: versionResult.error }),
    configurationStatus: config.status,
    configurationReason: config.reason,
    ...(config.registerTools === undefined ? {} : { registerTools: config.registerTools }),
    toolFactoryAvailable: toolResult.value,
    ...(config.persistence === undefined ? {} : { persistence: config.persistence }),
    hooks: hooksResult.value,
  })
  return { exitCode: report.ready ? 0 : 1, output: formatDoctorReport(report) }
}
