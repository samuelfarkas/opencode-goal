import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { lstat, open, readFile, realpath } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { GOAL_LIMITS, validateArchiveEntry, validatePersistedGoal } from "./goal-contract.ts"
import { OpenCodeGoalPlugin } from "./index.ts"
import { resolveOptions } from "./options.ts"
import { isRecord } from "./records.ts"
import { loadToolFactory } from "./tools.ts"
import { DOCTOR_PACKAGE_SPEC, doctorErrorMessage } from "./doctor-report.ts"
import type {
  DoctorCapabilityStatus,
  DoctorFileObservation,
  DoctorObservation,
  DoctorPersistenceObservation,
} from "./doctor-report.ts"
import type { GoalPluginOptions, Hooks } from "./types.ts"

const CONFIG_BYTES = 1024 * 1024

export type DoctorDependencies = {
  packageMetadata: () => Promise<unknown>
  openCodeVersion: (binary: string) => Promise<{ version?: string; error?: string }>
  toolFactoryAvailable: () => Promise<boolean>
  hooks: (directory: string) => Promise<DoctorObservation["hooks"]>
  nowSeconds: () => number
}

export type ConfigurationObservation = {
  status: DoctorCapabilityStatus
  reason: string
  registerTools?: boolean
  persistence?: DoctorPersistenceObservation
}

function errorCode(error: unknown): string | number | undefined {
  if (!isRecord(error)) return undefined
  const code = error.code
  return typeof code === "string" || typeof code === "number" ? code : undefined
}

function goalPluginIdentity(value: unknown): string | undefined {
  if (typeof value === "string") return value
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : undefined
}

function isGoalPluginSpec(value: string): boolean {
  const packageEnd = value.startsWith("@") ? value.indexOf("@", 1) : value.indexOf("@")
  return (packageEnd === -1 ? value : value.slice(0, packageEnd)) === DOCTOR_PACKAGE_SPEC
}

function parsePluginOptions(value: unknown): GoalPluginOptions {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error("opencode-goal tuple options must be an object")
  const result: GoalPluginOptions = {}
  if ("stateFilePath" in value) {
    if (typeof value.stateFilePath !== "string") throw new Error("stateFilePath must be a string")
    result.stateFilePath = value.stateFilePath
  }
  for (const key of ["persistState", "registerTools"] as const) {
    if (!(key in value)) continue
    if (typeof value[key] !== "boolean") throw new Error(`${key} must be a boolean`)
    result[key] = value[key]
  }
  return result
}

async function readPrivateRegularFile(path: string, maximumBytes: number): Promise<string | undefined> {
  if (!constants.O_NOFOLLOW) throw new Error("platform does not support no-follow file reads")
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stats = await handle.stat()
    if (!stats.isFile()) throw new Error("is not a regular file")
    if (stats.nlink !== 1) throw new Error("has multiple hard links")
    if (stats.size > maximumBytes) throw new Error(`exceeds ${maximumBytes} bytes`)
    return await handle.readFile("utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined
    if (errorCode(error) === "ELOOP") throw new Error("is a symbolic link")
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function resolvePersistencePath(options: ReturnType<typeof resolveOptions>): Promise<string> {
  const configuredRoot = resolve(options.stateFileTrustRoot)
  if (!options.stateFileProjectLocal) {
    try {
      const canonicalRoot = await realpath(configuredRoot)
      const stats = await lstat(canonicalRoot)
      if (!stats.isDirectory()) throw new Error("explicit persistence parent is not a directory")
      return join(canonicalRoot, basename(options.stateFilePath))
    } catch (error) {
      if (errorCode(error) === "ENOENT") return options.stateFilePath
      throw error
    }
  }

  const canonicalRoot = await realpath(configuredRoot)
  const rootStats = await lstat(canonicalRoot)
  if (!rootStats.isDirectory()) throw new Error("trusted project path is not a directory")
  const configuredRelative = relative(configuredRoot, options.stateFilePath)
  if (
    configuredRelative === ".." ||
    configuredRelative.startsWith(`..${sep}`) ||
    configuredRelative.startsWith(sep)
  ) throw new Error("project-local path escapes its trusted root")

  const statePath = resolve(canonicalRoot, configuredRelative)
  const parentRelative = relative(canonicalRoot, dirname(statePath))
  let current = canonicalRoot
  for (const component of parentRelative.split(sep).filter(Boolean)) {
    current = join(current, component)
    try {
      const stats = await lstat(current)
      if (stats.isSymbolicLink()) throw new Error(`${current} directory component is a symbolic link`)
      if (!stats.isDirectory()) throw new Error(`${current} directory component is not a directory`)
    } catch (error) {
      if (errorCode(error) === "ENOENT") break
      throw error
    }
  }
  return statePath
}

function validStateShape(value: unknown, nowSeconds: number): boolean {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || !Array.isArray(value.goals)) return false
  const allowed = value.version === 1 ? ["version", "goals"] : ["version", "lastSequence", "goals"]
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false
  if (value.goals.length > GOAL_LIMITS.goalsPerSnapshot) return false
  if (value.version === 2 && (!Number.isSafeInteger(value.lastSequence) || (value.lastSequence as number) < 0)) return false
  return value.goals.every((goal, index) => validatePersistedGoal(goal, nowSeconds, `goals[${index}]`).ok)
}

function validArchiveShape(value: unknown, nowSeconds: number): boolean {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.lastSequence) ||
    (value.lastSequence as number) < 0 ||
    !Array.isArray(value.entries) ||
    value.entries.length > GOAL_LIMITS.archiveEntries
  ) return false
  if (Object.keys(value).some((key) => !["version", "lastSequence", "entries"].includes(key))) return false
  const ids = new Set<string>()
  for (const [index, entry] of value.entries.entries()) {
    const result = validateArchiveEntry(entry, nowSeconds, `entries[${index}]`)
    if (!result.ok || ids.has(result.value.id)) return false
    ids.add(result.value.id)
  }
  return true
}

async function inspectJsonFile(
  path: string,
  maximumBytes: number,
  nowSeconds: number,
  shape: (value: unknown, loadedAtSeconds: number) => boolean,
): Promise<DoctorFileObservation> {
  try {
    const raw = await readPrivateRegularFile(path, maximumBytes)
    if (raw === undefined) return { status: "available", reason: `${path} is not present; no probe file was created` }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      return { status: "unavailable", reason: `${path} contains invalid JSON` }
    }
    return shape(value, nowSeconds)
      ? { status: "available", reason: `${path} is a valid private regular JSON file` }
      : { status: "unavailable", reason: `${path} has an invalid persisted schema` }
  } catch (error) {
    return { status: "unavailable", reason: `${path} ${doctorErrorMessage(error)}` }
  }
}

export async function readDoctorConfiguration(
  configPath: string | undefined,
  directory: string,
  nowSeconds: number,
): Promise<ConfigurationObservation> {
  if (!configPath) {
    return {
      status: "unknown",
      reason: "no config selected; pass --config to inspect plugin options and persistence",
    }
  }
  try {
    const raw = await readPrivateRegularFile(configPath, CONFIG_BYTES)
    if (raw === undefined) throw new Error("does not exist")
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error("contains invalid strict JSON")
    }
    if (!isRecord(parsed)) throw new Error("must contain a JSON object")
    if (!Array.isArray(parsed.plugin)) throw new Error("does not contain a plugin array")
    const matches = parsed.plugin.filter((entry) => {
      const identity = goalPluginIdentity(entry)
      return identity ? isGoalPluginSpec(identity) : false
    })
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? `does not contain ${DOCTOR_PACKAGE_SPEC}`
        : `contains ${DOCTOR_PACKAGE_SPEC} more than once`)
    }
    const selected = matches[0]
    const options = parsePluginOptions(Array.isArray(selected) ? selected[1] : undefined)
    const resolvedOptions = resolveOptions(options, directory)
    const stateFilePath = await resolvePersistencePath(resolvedOptions)
    const state = resolvedOptions.persistState
      ? await inspectJsonFile(stateFilePath, GOAL_LIMITS.snapshotBytes, nowSeconds, validStateShape)
      : { status: "available" as const, reason: "persistence is disabled" }
    const archive = resolvedOptions.persistState
      ? await inspectJsonFile(`${stateFilePath}.archive.json`, GOAL_LIMITS.archiveBytes, nowSeconds, validArchiveShape)
      : { status: "available" as const, reason: "persistence is disabled" }
    return {
      status: "available",
      reason: `strict-JSON config loaded from ${configPath}`,
      registerTools: resolvedOptions.registerTools,
      persistence: {
        enabled: resolvedOptions.persistState,
        path: stateFilePath,
        projectLocal: resolvedOptions.stateFileProjectLocal,
        state,
        archive,
      },
    }
  } catch (error) {
    return { status: "unavailable", reason: `${configPath} ${doctorErrorMessage(error)}` }
  }
}

async function readPackageMetadata(): Promise<unknown> {
  return JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as unknown
}

function executeVersion(binary: string): Promise<{ version?: string; error?: string }> {
  return new Promise((resolvePromise) => {
    execFile(binary, ["--version"], { timeout: 5_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) {
        resolvePromise({ error: `${binary} --version failed: ${doctorErrorMessage(error)}` })
        return
      }
      const version = stdout.trim()
      resolvePromise(version ? { version } : { error: `${binary} --version returned no version` })
    })
  })
}

async function inspectHooks(directory: string): Promise<DoctorObservation["hooks"]> {
  const hooks: Hooks = await OpenCodeGoalPlugin(
    { directory },
    { persistState: false, registerTools: false, toastNotifications: false, sessionTitle: false },
  )
  return {
    system: typeof hooks["experimental.chat.system.transform"] === "function",
    compaction: typeof hooks["experimental.session.compacting"] === "function",
    autocontinue: typeof hooks["experimental.compaction.autocontinue"] === "function",
  }
}

export const defaultDoctorDependencies: DoctorDependencies = {
  packageMetadata: readPackageMetadata,
  openCodeVersion: executeVersion,
  toolFactoryAvailable: async () => Boolean(await loadToolFactory()),
  hooks: inspectHooks,
  nowSeconds: () => Math.floor(Date.now() / 1000),
}
