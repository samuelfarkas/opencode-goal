#!/usr/bin/env node
import { execFile } from "node:child_process"
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const packageName = "@samuelfarkas/opencode-goal"

function run(file, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { cwd: options.cwd, env: options.env }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\n${stdout}${stderr}`
        reject(error)
        return
      }
      resolvePromise({ stdout, stderr })
    })
  })
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "opencode-goal-package-smoke-"))
  try {
    const packDir = join(root, "pack")
    await run(process.execPath, ["pm", "pack", "--destination", packDir], { cwd: packageRoot })
    const tarballName = (await readdir(packDir)).find((name) => name.endsWith(".tgz"))
    if (!tarballName) throw new Error("package smoke did not produce a tarball")
    const tarball = join(packDir, tarballName)

    const listing = (await run("tar", ["-tzf", tarball])).stdout.split("\n")
    for (const expected of [
      "package/build/index.js",
      "package/build/index.d.ts",
      "package/LICENSE",
      "package/scripts/install-opencode-plugin.mjs",
      "package/package.json",
    ]) {
      if (!listing.includes(expected)) throw new Error(`packed artifact is missing ${expected}`)
    }
    for (const forbidden of [
      "package/docs/",
      "package/examples/bunfig.local-registry.toml",
      "package/examples/opencode.tarball.json",
    ]) {
      if (listing.some((entry) => entry === forbidden || entry.startsWith(forbidden))) {
        throw new Error(`packed artifact contains non-public distribution material: ${forbidden}`)
      }
    }
    console.log("PASS package files: imports, declarations, and bin are present")

    const consumer = join(root, "consumer")
    await mkdir(consumer, { recursive: true })
    await writeFile(join(root, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`)
    const installedPackage = join(root, "node_modules", "@samuelfarkas", "opencode-goal")
    await mkdir(installedPackage, { recursive: true })
    await run("tar", ["-xzf", tarball, "-C", installedPackage, "--strip-components=1"])

    // A consumer supplies the declared optional host peer. Link the host type
    // graph explicitly so this check never succeeds through workspace hoisting.
    let workspaceNodeModules
    for (const candidate of [resolve(packageRoot, "node_modules"), resolve(packageRoot, "../../node_modules")]) {
      try {
        await access(join(candidate, "typescript", "bin", "tsc"))
        workspaceNodeModules = candidate
        break
      } catch {
        // Try the containing workspace after the standalone package root.
      }
    }
    if (!workspaceNodeModules) throw new Error("package smoke could not locate installed development dependencies")
    const opencodeScope = join(root, "node_modules", "@opencode-ai")
    await mkdir(opencodeScope, { recursive: true })
    await symlink(join(workspaceNodeModules, "@opencode-ai", "plugin"), join(opencodeScope, "plugin"), "dir")
    const typesScope = join(root, "node_modules", "@types")
    await mkdir(typesScope, { recursive: true })
    await symlink(join(workspaceNodeModules, "@types", "bun"), join(typesScope, "bun"), "dir")

    const importScript = join(root, "import-smoke.mjs")
    await writeFile(
      importScript,
      `import root, { OpenCodeGoalPlugin } from ${JSON.stringify(packageName)}\n` +
        `import server from ${JSON.stringify(`${packageName}/server`)}\n` +
        `if (typeof root !== "function" || root !== OpenCodeGoalPlugin || server !== root) throw new Error("unexpected plugin exports")\n`,
    )
    await run(process.execPath, [importScript], { cwd: root })
    console.log("PASS package imports: root and server expose the default plugin")

    await writeFile(
      join(root, "consumer.ts"),
      `import plugin, { OpenCodeGoalPlugin } from ${JSON.stringify(packageName)}\n` +
        `import server from ${JSON.stringify(`${packageName}/server`)}\n` +
        `const rootPlugin: typeof OpenCodeGoalPlugin = plugin\n` +
        `const serverPlugin: typeof OpenCodeGoalPlugin = server\n` +
        `void rootPlugin\nvoid serverPlugin\n`,
    )
    await writeFile(
      join(root, "tsconfig.json"),
      `${JSON.stringify({
        compilerOptions: {
          target: "ES2024",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: ["bun"],
        },
        files: ["consumer.ts"],
      }, null, 2)}\n`,
    )
    await run(resolve(workspaceNodeModules, "typescript/bin/tsc"), ["-p", join(root, "tsconfig.json")], { cwd: root })
    const declarations = await readFile(join(installedPackage, "build", "types.d.ts"), "utf8")
    if (declarations.includes("@opencode-ai/sdk")) {
      throw new Error("packed declarations directly reference undeclared @opencode-ai/sdk")
    }
    console.log("PASS package declarations: strict external consumer typechecks")

    const manifest = JSON.parse(await readFile(join(root, "node_modules", "@samuelfarkas", "opencode-goal", "package.json"), "utf8"))
    if (manifest.publishConfig?.access !== "public") {
      throw new Error("packed manifest is not configured for public package access")
    }
    if (manifest.dependencies?.["@opencode-ai/plugin"] !== ">=1.17.9 <2") {
      throw new Error("packed manifest must install @opencode-ai/plugin as a runtime dependency")
    }
    for (const internalScript of ["pack:local", "registry:start", "registry:publish"]) {
      if (manifest.scripts?.[internalScript] !== undefined) {
        throw new Error(`packed manifest exposes internal distribution script ${internalScript}`)
      }
    }
    const binRelative = manifest.bin?.["opencode-goal"]
    if (typeof binRelative !== "string") throw new Error("packed manifest is missing opencode-goal bin")
    const bin = join(root, "node_modules", "@samuelfarkas", "opencode-goal", binRelative)
    await access(bin)
    await chmod(bin, 0o755)
    const fakeOpenCode = join(root, "fake-opencode.mjs")
    await writeFile(fakeOpenCode, "#!/usr/bin/env node\nconsole.log('1.17.18')\n")
    await chmod(fakeOpenCode, 0o755)
    const doctor = await run(process.execPath, [bin, "doctor", "--opencode-bin", fakeOpenCode], { cwd: consumer })
    if (
      !doctor.stdout.includes("OpenCode Goal Doctor: READY") ||
      !doctor.stdout.includes("[unknown] Transcript reads") ||
      !doctor.stdout.includes("[registered-unverified] System prompt hook")
    ) {
      throw new Error(`packaged doctor returned unexpected output\n${doctor.stdout}${doctor.stderr}`)
    }
    console.log("PASS package doctor: read-only capability report is available")
    const configPath = join(consumer, "opencode.json")
    await run(process.execPath, [bin, "--config", configPath, "--spec", `file:${tarball}`], { cwd: consumer })
    const config = JSON.parse(await readFile(configPath, "utf8"))
    if (config.plugin?.at(-1) !== `file:${tarball}` || config.command !== undefined) {
      throw new Error("packaged installer wrote unexpected config")
    }
    const packedPlugin = await import(pathToFileURL(join(installedPackage, "build", "index.js")).href)
    const hooks = await packedPlugin.default({ directory: consumer }, { persistState: false, registerTools: false })
    await hooks.config(config)
    if (config.command?.goal?.template !== "$ARGUMENTS") {
      throw new Error("packed plugin config hook did not register /goal")
    }
    console.log("PASS package bin: installer writes plugin-only config and the plugin registers /goal")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
