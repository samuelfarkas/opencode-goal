#!/usr/bin/env node
import { randomUUID } from "node:crypto"
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { homedir } from "node:os"

const PACKAGE_SPEC = "@samuelfarkas/opencode-goal"
const PACKAGE_VERSION = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version
const RELEASE_SPEC = `${PACKAGE_SPEC}@https://github.com/samuelfarkas/opencode-goal/releases/download/v${PACKAGE_VERSION}/samuelfarkas-opencode-goal-${PACKAGE_VERSION}.tgz?download=1`
const rawArgs = process.argv.slice(2)
const usage = `Usage: opencode-goal [--global] [--config <path>] [--spec <plugin-spec>]

Adds the registry-free GitHub release of ${PACKAGE_SPEC} to OpenCode config.
The plugin registers /goal at load time.

Options:
  --global       Write ~/.config/opencode/opencode.json
  --config PATH  Write a specific opencode.json path
  --spec SPEC    Override the package spec for development or testing
`

class ArgumentError extends Error {}

function parseArgs(args) {
  const parsed = { help: false, global: false, config: undefined, spec: undefined }
  const seen = new Set()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const canonical = argument === "-h" ? "--help" : argument
    if (!["--help", "--global", "--config", "--spec"].includes(canonical)) {
      throw new ArgumentError(`Unknown argument: ${argument}`)
    }
    if (seen.has(canonical)) throw new ArgumentError(`Duplicate argument: ${canonical}`)
    seen.add(canonical)

    if (canonical === "--help") {
      parsed.help = true
      continue
    }
    if (canonical === "--global") {
      parsed.global = true
      continue
    }

    const value = args[index + 1]
    if (!value || value.startsWith("-")) throw new ArgumentError(`Missing value for ${canonical}`)
    if (canonical === "--config") parsed.config = value
    else parsed.spec = value
    index += 1
  }
  if (parsed.global && parsed.config) throw new ArgumentError("--global cannot be combined with --config")
  return parsed
}

function isGoalPluginSpec(value) {
  if (typeof value !== "string") return false
  const packageEnd = value.startsWith("@") ? value.indexOf("@", 1) : value.indexOf("@")
  const name = packageEnd === -1 ? value : value.slice(0, packageEnd)
  return name === PACKAGE_SPEC
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

async function readConfig(path) {
  try {
    const info = await lstat(path)
    if (!info.isFile()) throw new Error(`Config destination is not a regular file: ${path}`)
    return asObject(JSON.parse(await readFile(path, "utf8")))
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return {}
    throw error
  }
}

async function destinationMode(path) {
  try {
    const info = await lstat(path)
    if (!info.isFile()) throw new Error(`Config destination is not a regular file: ${path}`)
    return info.mode & 0o7777
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return 0o600
    throw error
  }
}

async function writeConfig(path, config) {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const mode = await destinationMode(path)
  const temp = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temp, "wx", mode)
    await handle.chmod(mode)
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8" })
    await handle.sync()
    await handle.close()
    handle = undefined
    if (process.env.OPENCODE_GOAL_INSTALLER_TEST_FAIL_BEFORE_RENAME === "1") {
      throw new Error("Simulated failure before config rename")
    }
    await rename(temp, path)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

function pluginIdentity(entry) {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0]
  return undefined
}

function addPlugin(config, schema, pluginSpec) {
  const plugins = Array.isArray(config.plugin)
    ? config.plugin.filter((item) => !isGoalPluginSpec(pluginIdentity(item)))
    : []
  plugins.push(pluginSpec)
  config.$schema ??= schema
  config.plugin = plugins
}

async function main() {
  const parsed = parseArgs(rawArgs)
  if (parsed.help) {
    console.log(usage)
    return
  }

  const pluginSpec = parsed.spec ?? RELEASE_SPEC
  const configPath = parsed.config
    ? resolve(parsed.config)
    : parsed.global
    ? join(homedir(), ".config", "opencode", "opencode.json")
    : join(resolve(process.cwd()), ".opencode", "opencode.json")

  const config = await readConfig(configPath)
  addPlugin(config, "https://opencode.ai/config.json", pluginSpec)

  await writeConfig(configPath, config)
  console.log(`Installed ${pluginSpec} server plugin in ${configPath}`)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  if (error instanceof ArgumentError) console.error(`\n${usage}`)
  process.exitCode = 1
}
