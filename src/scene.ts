import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Measured } from "./browser.ts"

export type SceneDef = { command: string; primary: string }

/**
 * Runs a person's own scene, such as a Playwright spec or a scenetest scene, against one target.
 * The command gets PORTSIDE_BASE_URL, PORTSIDE_TARGET, PORTSIDE_PATH and PORTSIDE_METRICS, a file
 * it may write a JSON object of numbers to; `durationMs` is the wall time either way.
 */
export function runScene(
  scene: SceneDef,
  env: { baseURL: string; target: string; path: string },
  cwd: string,
): Promise<Measured> {
  const dir = mkdtempSync(join(tmpdir(), "portside-scene-"))
  const metricsFile = join(dir, "metrics.json")
  const started = performance.now()
  return new Promise<Measured>((resolve, reject) => {
    const child = spawn(scene.command, {
      cwd,
      shell: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        PORTSIDE_BASE_URL: env.baseURL,
        PORTSIDE_TARGET: env.target,
        PORTSIDE_PATH: env.path,
        PORTSIDE_METRICS: metricsFile,
      },
    })
    let stderr = ""
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)))
    child.on("error", reject)
    child.on("close", (code) => {
      const durationMs = performance.now() - started
      try {
        if (code !== 0) {
          reject(new Error(`scene exited ${code}: ${stderr.trim().split("\n").pop() ?? ""}`))
          return
        }
        let reported: Record<string, number> = {}
        try {
          reported = JSON.parse(readFileSync(metricsFile, "utf8"))
        } catch {}
        const metrics: Record<string, number> = { durationMs, ...reported }
        resolve({ primary: metrics[scene.primary] ?? durationMs, metrics })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
}
