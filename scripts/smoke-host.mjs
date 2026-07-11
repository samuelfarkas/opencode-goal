#!/usr/bin/env node
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const minimumVersion = "1.17.9"
const cli = process.env.OPENCODE_BIN ?? "opencode"
const expectedIndex = process.argv.indexOf("--expect-version")
const expectedVersion = expectedIndex === -1 ? undefined : process.argv[expectedIndex + 1]

function run(file, args, cwd, env = process.env) {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { cwd, env }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\n${stdout}${stderr}`
        reject(error)
        return
      }
      resolvePromise(stdout.trim())
    })
  })
}

function versionParts(value) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) throw new Error(`unexpected OpenCode version: ${value}`)
  return match.slice(1).map(Number)
}

function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < a.length; index += 1) {
    const difference = a[index] - b[index]
    if (difference !== 0) return difference
  }
  return 0
}

const version = await run(cli, ["--version"], packageRoot)
if (compareVersions(version, minimumVersion) < 0 || versionParts(version)[0] >= 2) {
  throw new Error(`OpenCode ${version} is outside the supported >=${minimumVersion} <2 range`)
}
if (expectedVersion && version !== expectedVersion) {
  throw new Error(`expected OpenCode ${expectedVersion}, found ${version}`)
}
console.log(`PASS host version: ${version} satisfies >=${minimumVersion} <2`)

const root = await mkdtemp(join(tmpdir(), "opencode-goal-host-smoke-"))
try {
  const configPath = join(root, "opencode.json")
  const pluginUrl = pathToFileURL(join(packageRoot, "build", "index.js")).href
  const hostEnv = {
    ...process.env,
    XDG_CACHE_HOME: join(root, ".xdg", "cache"),
    XDG_CONFIG_HOME: join(root, ".xdg", "config"),
    XDG_DATA_HOME: join(root, ".xdg", "data"),
    XDG_STATE_HOME: join(root, ".xdg", "state"),
  }
  await run(process.execPath, [join(packageRoot, "scripts", "install-opencode-plugin.mjs"), "--config", configPath, "--spec", pluginUrl], root)
  const output = await run(cli, ["debug", "config"], root, hostEnv)
  const config = JSON.parse(output)
  if (!Array.isArray(config.plugin) || !config.plugin.includes(pluginUrl)) {
    throw new Error("OpenCode resolved config did not retain the packaged plugin")
  }
  if (config.command?.goal?.template !== "$ARGUMENTS") {
    throw new Error("OpenCode resolved config did not expose the /goal command")
  }
  console.log("PASS host plugin load: resolved disposable config")

  const module = await import(pluginUrl)
  const hooks = await module.default({ directory: root }, { persistState: false, registerTools: false })
  for (const hook of [
    "config",
    "command.execute.before",
    "experimental.chat.system.transform",
    "experimental.session.compacting",
    "experimental.compaction.autocontinue",
    "event",
  ]) {
    if (typeof hooks[hook] !== "function") throw new Error(`plugin is missing ${hook}`)
  }
  console.log("PASS host hooks: command and experimental capabilities are present")

  const doctor = await run(
    process.execPath,
    [join(packageRoot, "build", "cli.js"), "doctor", "--opencode-bin", cli],
    root,
    hostEnv,
  )
  if (
    !doctor.includes("OpenCode Goal Doctor: READY") ||
    !doctor.includes(`[available] OpenCode binary: ${version}`) ||
    !doctor.includes("[registered-unverified] Compaction autocontinue hook")
  ) {
    throw new Error(`host doctor returned unexpected output\n${doctor}`)
  }
  console.log("PASS host doctor: read-only capability report matches local host")

  const written = JSON.parse(await readFile(configPath, "utf8"))
  if (written.command !== undefined) {
    throw new Error("disposable config persisted a command that should be injected by the plugin")
  }
  console.log("PASS host cleanup: no credentials, command, model, agent, or project state used")
} finally {
  await rm(root, { recursive: true, force: true })
}
