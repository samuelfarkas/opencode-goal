#!/usr/bin/env node
import { runDoctor } from "./doctor.ts"

const command = process.argv[2]

if (command === "doctor") {
  const result = await runDoctor(process.argv.slice(3))
  console.log(result.output)
  process.exitCode = result.exitCode
} else {
  if (command === "install") process.argv.splice(2, 1)
  await import(new URL("../scripts/install-opencode-plugin.mjs", import.meta.url).href)
}
