// Any command, such as a Playwright spec or a scenetest scene, run once per repeat per target.
//
// conditions.command: the command (required)
// conditions.metric: the number it reports that the verdict reads; durationMs when absent
//
// The command runs with HARNESS_BASE_URL, HARNESS_URL, HARNESS_PATH, HARNESS_TARGET and
// HARNESS_VANTAGE set, and may write a JSON object of numbers to the file HARNESS_METRICS names.
// A command that exits non-zero fails the case.
//
// To read a different metric per case, copy this file under another name and change `primary`:
// the verdict reads one metric per probe, so that comparisons always measure the same thing.

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export default {
  describe: "A command of your own, timed",
  primary: "durationMs",
  repeats: 3,
  sequential: true,

  async measure(ctx) {
    const command = ctx.conditions.command
    if (!command) throw new Error("command needs conditions.command")
    const dir = mkdtempSync(join(tmpdir(), "harness-command-"))
    const file = join(dir, "metrics.json")
    try {
      const started = performance.now()
      await ctx.exec(String(command), { HARNESS_METRICS: file })
      const durationMs = performance.now() - started
      let reported = {}
      try {
        reported = JSON.parse(readFileSync(file, "utf8"))
      } catch {}
      return { metrics: { durationMs, ...reported } }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
}
