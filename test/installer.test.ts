import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { GOAL_LIMITS } from "../src/goal-contract.ts"

const installer = resolve("scripts/install-opencode-plugin.mjs")
const cli = resolve("src/cli.ts")
const packageVersion = (JSON.parse(await readFile(resolve("package.json"), "utf8")) as { version: string }).version
const releaseSpec = `@samuelfarkas/opencode-goal@https://github.com/samuelfarkas/opencode-goal/releases/download/v${packageVersion}/samuelfarkas-opencode-goal-${packageVersion}.tgz`

type CommandResult = { code: number; stdout: string; stderr: string }

function execFileResult(
  file: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        reject(error)
        return
      }
      resolvePromise({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr })
    })
  })
}

async function runInstaller(
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return execFileResult(process.execPath, [installer, ...args], options)
}

async function runCli(
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return execFileResult(process.execPath, [cli, ...args], options)
}

async function fakeOpenCode(directory: string, version = "1.17.18"): Promise<string> {
  const path = join(directory, "fake-opencode.mjs")
  await writeFile(path, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)})\n`)
  await chmod(path, 0o755)
  return path
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
}

test("installer preserves unrelated plugin entries and replaces stale string and tuple specs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-goal-installer-"))
  const configPath = join(dir, "opencode.json")
  const spec = "@samuelfarkas/opencode-goal@file:/tmp/local-goal.tgz"
  const staleSpec = "@samuelfarkas/opencode-goal@file:/tmp/old-local-goal.tgz"
  const otherGoalSpec = "@samuelfarkas/opencode-legacy-goal@file:/tmp/other-goal.tgz"
  const unrelatedTuple = ["unrelated-plugin", { enabled: true, nested: [1, 2] }]
  const unknownEntry = { custom: "preserve me" }

  await writeFile(
    configPath,
    `${JSON.stringify({
      plugin: [
        "existing-plugin",
        unrelatedTuple,
        unknownEntry,
        staleSpec,
        [staleSpec, { legacy: true }],
        otherGoalSpec,
      ],
      command: {
        goal: {
          description: "Custom goal description.",
          template: "$ARGUMENTS",
          agent: "build",
          model: "anthropic/claude-sonnet-4",
        },
      },
    })}\n`,
  )

  assert.equal((await runInstaller(["--config", configPath, "--spec", spec])).code, 0)
  assert.equal((await runInstaller(["--config", configPath, "--spec", spec])).code, 0)

  const config = await readJson(configPath)
  assert.equal(config.$schema, "https://opencode.ai/config.json")
  assert.deepEqual(config.plugin, ["existing-plugin", unrelatedTuple, unknownEntry, otherGoalSpec, spec])
  assert.deepEqual(config.command, {
    goal: {
      description: "Custom goal description.",
      template: "$ARGUMENTS",
      agent: "build",
      model: "anthropic/claude-sonnet-4",
    },
  })
})

test("installer rejects invalid arguments before creating a config", async () => {
  const cases: ReadonlyArray<readonly string[]> = [
    ["--config"],
    ["--config", "--global"],
    ["--config", "one.json", "--config", "two.json"],
    ["--spec"],
    ["--spec", "--global"],
    ["--spec", "one", "--spec", "two"],
    ["--global", "--global"],
    ["--global", "--config", "opencode.json"],
    ["--unknown"],
    ["positional"],
    ["--help", "--help"],
  ]

  for (const [index, args] of cases.entries()) {
    const dir = await mkdtemp(join(tmpdir(), `opencode-goal-installer-invalid-${index}-`))
    const result = await runInstaller(args, { cwd: dir })
    assert.notEqual(result.code, 0, args.join(" "))
    assert.match(result.stderr, /Usage: opencode-goal/)
    assert.deepEqual(await readdir(dir), [])
  }
})

test("installer preserves existing mode and restricts a new config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-goal-installer-mode-"))
  const existing = join(dir, "existing.json")
  const created = join(dir, "new", "opencode.json")
  await writeFile(existing, "{}\n")
  await chmod(existing, 0o640)

  assert.equal((await runInstaller(["--config", existing])).code, 0)
  assert.equal((await lstat(existing)).mode & 0o777, 0o640)
  assert.deepEqual((await readJson(existing)).plugin, [releaseSpec])

  assert.equal((await runInstaller(["--config", created])).code, 0)
  assert.equal((await lstat(created)).mode & 0o177, 0)
})

test("compiled CLI dispatch preserves implicit and explicit installer behavior", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-cli-install-"))
  const implicit = join(directory, "implicit.json")
  const explicit = join(directory, "explicit.json")

  assert.equal((await runCli(["--config", implicit])).code, 0)
  assert.equal((await runCli(["install", "--config", explicit])).code, 0)
  assert.deepEqual(await readJson(implicit), await readJson(explicit))
})

test("doctor reads valid configuration and state without changing filesystem bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-doctor-readonly-"))
  const binary = await fakeOpenCode(directory)
  const configPath = join(directory, "opencode.json")
  const statePath = join(directory, "state.json")
  const archivePath = `${statePath}.archive.json`
  const config = `${JSON.stringify({
    plugin: [["@samuelfarkas/opencode-goal", { stateFilePath: "state.json", persistState: true, registerTools: true }]],
  }, null, 2)}\n`
  const state = `${JSON.stringify({ version: 2, lastSequence: 0, goals: [] })}\n`
  const archive = `${JSON.stringify({ version: 1, lastSequence: 0, entries: [] })}\n`
  await writeFile(configPath, config)
  await writeFile(statePath, state)
  await writeFile(archivePath, archive)
  const beforeEntries = await readdir(directory)

  const result = await runCli(["doctor", "--config", configPath, "--opencode-bin", binary], { cwd: directory })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /^OpenCode Goal Doctor: READY/)
  assert.match(result.stdout, /\[available\] Plugin configuration/)
  assert.match(result.stdout, /\[available\] Persistence: project-local path validated/)
  assert.match(result.stdout, /\[available\] State snapshot/)
  assert.match(result.stdout, /\[available\] Result archive/)
  assert.match(result.stdout, /\[unknown\] Transcript reads/)
  assert.match(result.stdout, /\[registered-unverified\] Compaction autocontinue hook/)
  assert.equal(await readFile(configPath, "utf8"), config)
  assert.equal(await readFile(statePath, "utf8"), state)
  assert.equal(await readFile(archivePath, "utf8"), archive)
  assert.deepEqual(await readdir(directory), beforeEntries)
})

test("doctor does not create missing state and reports unsafe or corrupt inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-doctor-invalid-"))
  const binary = await fakeOpenCode(directory)
  const configPath = join(directory, "opencode.json")
  const missingState = join(directory, "missing.json")
  await writeFile(configPath, `${JSON.stringify({
    plugin: [["@samuelfarkas/opencode-goal", { stateFilePath: missingState }]],
  })}\n`)
  const beforeMissing = await readdir(directory)
  const missing = await runCli(["doctor", "--config", configPath, "--opencode-bin", binary], { cwd: directory })
  assert.equal(missing.code, 0, missing.stderr)
  assert.match(missing.stdout, /missing\.json is not present; no probe file was created/)
  assert.deepEqual(await readdir(directory), beforeMissing)

  const target = join(directory, "target.json")
  const linkedState = join(directory, "linked.json")
  await writeFile(target, `${JSON.stringify({ version: 2, lastSequence: 0, goals: [] })}\n`)
  await symlink(target, linkedState, "file")
  await writeFile(configPath, `${JSON.stringify({
    plugin: [["@samuelfarkas/opencode-goal", { stateFilePath: linkedState }]],
  })}\n`)
  const linked = await runCli(["doctor", "--config", configPath, "--opencode-bin", binary], { cwd: directory })
  assert.equal(linked.code, 1)
  assert.match(linked.stdout, /^OpenCode Goal Doctor: DEGRADED/)
  assert.match(linked.stdout, /\[unavailable\] State snapshot: .*symbolic link/)
  assert.match(linked.stdout, /\[available\] Result archive: .*not present/)

  const invalidState = join(directory, "invalid-state.json")
  await writeFile(invalidState, `${JSON.stringify({ version: 2, lastSequence: 0, goals: [], extra: true })}\n`)
  await writeFile(configPath, `${JSON.stringify({
    plugin: [["@samuelfarkas/opencode-goal", { stateFilePath: invalidState }]],
  })}\n`)
  const invalidSchema = await runCli(["doctor", "--config", configPath, "--opencode-bin", binary], { cwd: directory })
  assert.equal(invalidSchema.code, 1)
  assert.match(invalidSchema.stdout, /\[unavailable\] State snapshot: .*invalid persisted schema/)

  const oversizedState = join(directory, "oversized-state.json")
  await writeFile(oversizedState, "x".repeat(GOAL_LIMITS.snapshotBytes + 1))
  await writeFile(configPath, `${JSON.stringify({
    plugin: [["@samuelfarkas/opencode-goal", { stateFilePath: oversizedState }]],
  })}\n`)
  const oversized = await runCli(["doctor", "--config", configPath, "--opencode-bin", binary], { cwd: directory })
  assert.equal(oversized.code, 1)
  assert.match(oversized.stdout, new RegExp(`\\[unavailable\\] State snapshot: .*exceeds ${GOAL_LIMITS.snapshotBytes} bytes`))

  const stateDirectory = join(directory, "state-directory")
  await mkdir(stateDirectory)
  await writeFile(configPath, `${JSON.stringify({
    plugin: [["@samuelfarkas/opencode-goal", { stateFilePath: stateDirectory }]],
  })}\n`)
  const nonRegular = await runCli(["doctor", "--config", configPath, "--opencode-bin", binary], { cwd: directory })
  assert.equal(nonRegular.code, 1)
  assert.match(nonRegular.stdout, /\[unavailable\] State snapshot: .*not a regular file/)

  const validState = join(directory, "valid-with-bad-archive.json")
  await writeFile(validState, `${JSON.stringify({ version: 2, lastSequence: 0, goals: [] })}\n`)
  await writeFile(`${validState}.archive.json`, "{ corrupt archive\n")
  await writeFile(configPath, `${JSON.stringify({
    plugin: [["@samuelfarkas/opencode-goal", { stateFilePath: validState }]],
  })}\n`)
  const corruptArchive = await runCli(["doctor", "--config", configPath, "--opencode-bin", binary], { cwd: directory })
  assert.equal(corruptArchive.code, 1)
  assert.match(corruptArchive.stdout, /\[unavailable\] Result archive: .*invalid JSON/)

  await writeFile(configPath, `${JSON.stringify({
    plugin: [["@samuelfarkas/opencode-goal", { stateFilePath: "../outside.json" }]],
  })}\n`)
  const unsafePath = await runCli(["doctor", "--config", configPath, "--opencode-bin", binary], { cwd: directory })
  assert.equal(unsafePath.code, 1)
  assert.match(unsafePath.stdout, /\[unavailable\] Plugin configuration: .*relative paths must stay within plugin directory/)

  const redirectedDirectory = join(directory, "redirected")
  const outsideDirectory = await mkdtemp(join(tmpdir(), "opencode-goal-doctor-outside-"))
  await symlink(outsideDirectory, redirectedDirectory, "dir")
  await writeFile(configPath, `${JSON.stringify({
    plugin: [["@samuelfarkas/opencode-goal", { stateFilePath: "redirected/state.json" }]],
  })}\n`)
  const unsafeDirectory = await runCli(["doctor", "--config", configPath, "--opencode-bin", binary], { cwd: directory })
  assert.equal(unsafeDirectory.code, 1)
  assert.match(unsafeDirectory.stdout, /\[unavailable\] Plugin configuration: .*directory component is a symbolic link/)

  await writeFile(configPath, "{ invalid config\n")
  const malformed = await runCli(["doctor", "--config", configPath, "--opencode-bin", binary], { cwd: directory })
  assert.equal(malformed.code, 1)
  assert.match(malformed.stdout, /\[unavailable\] Plugin configuration: .*invalid strict JSON/)

  const missingBinary = await runCli(["doctor", "--opencode-bin", join(directory, "does-not-exist")], { cwd: directory })
  assert.equal(missingBinary.code, 1)
  assert.match(missingBinary.stdout, /\[unavailable\] OpenCode binary/)

  const malformedVersionBinary = await fakeOpenCode(directory, "not-a-version")
  const malformedVersion = await runCli(["doctor", "--opencode-bin", malformedVersionBinary], { cwd: directory })
  assert.equal(malformedVersion.code, 1)
  assert.match(malformedVersion.stdout, /\[unavailable\] OpenCode binary: not-a-version is outside/)
})

test("installer leaves malformed JSON and the destination unchanged on failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-goal-installer-failure-"))
  const malformed = join(dir, "malformed.json")
  const original = "{ malformed json\n"
  await writeFile(malformed, original)

  const malformedResult = await runInstaller(["--config", malformed])
  assert.notEqual(malformedResult.code, 0)
  assert.equal(await readFile(malformed, "utf8"), original)

  const valid = join(dir, "valid.json")
  const validOriginal = "{\n  \"custom\": true\n}\n"
  await writeFile(valid, validOriginal)
  const failed = await runInstaller(["--config", valid], {
    env: { ...process.env, OPENCODE_GOAL_INSTALLER_TEST_FAIL_BEFORE_RENAME: "1" },
  })
  assert.notEqual(failed.code, 0)
  assert.equal(await readFile(valid, "utf8"), validOriginal)
  assert.equal((await readdir(dir)).some((name) => name.endsWith(".tmp")), false)
})

test("installer rejects non-regular destinations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-goal-installer-directory-"))
  const destination = join(dir, "opencode.json")
  await mkdir(destination)

  const result = await runInstaller(["--config", destination])
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /not a regular file/)
})

test("packed installer preserves tuples and rejects a missing value", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-goal-installer-packed-"))
  const packDir = join(dir, "pack")
  await mkdir(packDir)
  const packed = await execFileResult(process.execPath, ["pm", "pack", "--destination", packDir], { cwd: resolve(".") })
  assert.equal(packed.code, 0, packed.stderr)
  const tarballName = (await readdir(packDir)).find((name) => name.endsWith(".tgz"))
  if (!tarballName) throw new Error("missing packed tarball")

  const installed = join(dir, "installed")
  await mkdir(installed)
  const extracted = await execFileResult("tar", ["-xzf", join(packDir, tarballName), "-C", installed, "--strip-components=1"])
  assert.equal(extracted.code, 0, extracted.stderr)
  const packedInstaller = join(installed, "scripts", "install-opencode-plugin.mjs")
  const configPath = join(dir, "consumer", "opencode.json")
  await mkdir(join(dir, "consumer"))
  await writeFile(configPath, `${JSON.stringify({ plugin: [["other-plugin", { keep: true }]] })}\n`)

  const installedResult = await execFileResult(process.execPath, [packedInstaller, "--config", configPath])
  assert.equal(installedResult.code, 0, installedResult.stderr)
  assert.deepEqual((await readJson(configPath)).plugin, [["other-plugin", { keep: true }], releaseSpec])

  const before = await readFile(configPath, "utf8")
  const missing = await execFileResult(process.execPath, [packedInstaller, "--config"])
  assert.notEqual(missing.code, 0)
  assert.match(missing.stderr, /Usage: opencode-goal/)
  assert.equal(await readFile(configPath, "utf8"), before)
})
