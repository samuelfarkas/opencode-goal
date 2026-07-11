#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const buildDir = new URL("../build/", import.meta.url)
const specifier = /((?:from|import)\s+["']\.\/[^"']+)\.ts(["'])/g

for (const entry of await readdir(buildDir)) {
  if (!entry.endsWith(".d.ts")) continue
  const path = join(buildDir.pathname, entry)
  const source = await readFile(path, "utf8")
  const rewritten = source.replace(specifier, "$1.js$2")
  if (rewritten !== source) await writeFile(path, rewritten)
}
