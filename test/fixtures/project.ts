import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONFIG_FILE } from "../../src/config.ts"

export const STARTERS = join(import.meta.dirname, "../../starters")
export const CHROMIUM =
  process.env.HARNESS_CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"

/** A project directory with the starter probes copied in, as `hch init` leaves it. */
export function makeProject(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-"))
  mkdirSync(join(dir, "harness"), { recursive: true })
  cpSync(join(STARTERS, "probes"), join(dir, "harness/probes"), { recursive: true })
  writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(config, null, 2))
  return dir
}
