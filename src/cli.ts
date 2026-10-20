#!/usr/bin/env node
// node:sqlite prints an ExperimentalWarning on every command until Node marks it stable. The
// filter has to be installed before anything imports it, hence the dynamic import below.
const emitWarning = process.emitWarning
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message
  if (text.includes("SQLite")) return
  return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest)
}) as typeof process.emitWarning

const { cli } = await import("./main.ts")
await cli(process.argv.slice(2))
