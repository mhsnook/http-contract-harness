import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import type { Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { CONFIG_FILE } from "../src/config.ts"
import {
  EXPERIMENTS_FILE,
  decideExperiment,
  listExperiments,
  measureExperiment,
  startExperiment,
} from "../src/experiments.ts"
import { openProject, type Project } from "../src/project.ts"
import { lock } from "../src/ratchet.ts"
import { runBatch } from "../src/run.ts"
import { site, type Knobs } from "./fixtures/site.ts"

const CHROMIUM =
  process.env.PORTSIDE_CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
const hasBrowser = existsSync(CHROMIUM)

let dir: string
let servers: Server[]
let project: Project
let port: Knobs

const purge = `node -e "fetch(new URL('/__purge?path=' + encodeURIComponent(process.env.PORTSIDE_PATH), process.env.PORTSIDE_URL))"`
const scene = `node -e "require('fs').writeFileSync(process.env.PORTSIDE_METRICS, JSON.stringify({ items: process.env.PORTSIDE_TARGET === 'port' ? 2 : 1, path: process.env.PORTSIDE_PATH.length }))"`

const observed = (target: string, route: string, caseId: string) =>
  project.store.latestFor(target).filter((o) => o.route === route && o.caseId === caseId)

beforeAll(async () => {
  const [a, b] = await Promise.all([site("legacy"), site("port")])
  servers = [a.server, b.server]
  port = b.knobs
  dir = mkdtempSync(join(tmpdir(), "portside-loop-"))
  writeFileSync(
    join(dir, CONFIG_FILE),
    JSON.stringify({
      baseline: "legacy",
      targets: { legacy: { url: a.url, purge }, port: { url: b.url, purge } },
      probe: { repeats: 4, concurrency: 2 },
      browser: { executablePath: CHROMIUM, repeats: 2, quietMs: 100 },
      scenes: { count: { command: scene, primary: "durationMs", repeats: 2 } },
    }),
  )
  project = openProject(dir)
  const routes = project.lock.routes
  const route = (samples: string[], cases: Record<string, object> = {}) => ({
    samples,
    source: "manual",
    cases: {
      default: { history: [] },
      ...Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, { ...v, history: [] }])),
    },
  })
  routes["/about"] = route(["/about"], {
    revalidate: { direction: "revalidate" },
    load: { direction: "load" },
    reload: { direction: "reload" },
    navigate: { direction: "navigate", from: "/" },
    scene: { direction: "scene", scene: "count" },
  })
  routes["/event/:city/:id"] = route(["/event/london/1"], { cold: { direction: "cold" } })
  routes["/sticky"] = route(["/sticky"], { cold: { direction: "cold" } })
  project.saveLock()
})

afterAll(() => {
  project?.store.close()
  for (const s of servers) s.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("directions", { timeout: 60_000 }, () => {
  it("measures every direction on every target in one batch", async () => {
    const result = await runBatch(project, {
      targets: ["legacy", "port"],
      routes: (p) => p !== "/about" || hasBrowser,
    })
    const errors = result.observations.filter((o) => o.error && o.route !== "/sticky")
    expect(errors.map((o) => `${o.route}#${o.caseId}: ${o.error}`)).toEqual([])
  })

  it("revalidates with the ETag the first answer carried, as a browser refresh does", () => {
    const [o] = observed("legacy", "/about", "revalidate")
    expect(o).toMatchObject({
      status: 304,
      direction: "revalidate",
      cacheSignal: "revalidated: 304 Not Modified",
    })
    expect(o!.ttfb).toHaveLength(4)
  })

  it("purges before each cold request and confirms the request missed", () => {
    const [legacy] = observed("legacy", "/event/:city/:id", "cold")
    expect(legacy!.cacheSignal).toBe(
      "cold: 4 misses confirmed, 0 with no cache header, 0 purges that did not take",
    )
    expect(legacy!.ttfb).toHaveLength(4)
  })

  it("refuses to call a request cold when the cache still answered", () => {
    const [sticky] = observed("legacy", "/sticky", "cold")
    expect(sticky!.error).toBe("the purge never took: 4 answers were hits")
  })

  it("runs a person's own scene against each target and keeps what it reports", () => {
    const [legacy] = observed("legacy", "/about", "scene")
    const [other] = observed("port", "/about", "scene")
    expect(legacy!.metrics["items"]).toEqual([1, 1])
    expect(other!.metrics["items"]).toEqual([2, 2])
    expect(legacy!.ttfb).toEqual(legacy!.metrics["durationMs"])
  })

  it.skipIf(!hasBrowser)("loads, reloads and navigates in a real browser", () => {
    const [load] = observed("legacy", "/about", "load")
    expect(load!.status).toBe(200)
    expect(load!.metrics["load"]).toHaveLength(2)
    const [reload] = observed("port", "/about", "reload")
    expect(reload!.metrics["ttfb"]).toHaveLength(2)
    const [nav] = observed("legacy", "/about", "navigate")
    expect(nav!.status).toBe(200)
    expect(nav!.metrics["navMs"]).toHaveLength(2)
    expect(nav!.ttfb).toEqual(nav!.metrics["navMs"])
  })
})

describe("the experiment loop", { timeout: 60_000 }, () => {
  it("records a theory, measures before and after, and corrects for drift", async () => {
    lock(project, { from: "legacy" })
    port.eventDelay = 80
    const { experiment, related } = await startExperiment(project, {
      theory: "Serve the event page without the 80ms render",
      routes: ["/event/:city/:id"],
      target: "port",
    })
    expect(related).toEqual([])
    expect(experiment.reference).toBe("legacy")

    port.eventDelay = 0
    const { experiment: measured } = await measureExperiment(project, experiment.id)
    const event = measured.result!.cases.find((c) => c.key === "/event/:city/:id#default")!
    expect(event.change).toBe("better")
    expect(event.deltaMs!).toBeLessThan(-50)
    expect(typeof event.driftMs).toBe("number")
    expect(measured.result!.broken).toBe(0)
  })

  it("keeps the decision and its reason in a committed file", () => {
    const [experiment] = listExperiments(project)
    expect(() => decideExperiment(project, experiment!.id, "keep", "")).toThrow(/why/)
    decideExperiment(project, experiment!.id, "keep", "The render was the whole cost; cached now")
    const file = JSON.parse(readFileSync(join(dir, EXPERIMENTS_FILE), "utf8"))
    expect(file.experiments[0].decision).toMatchObject({
      verdict: "keep",
      why: "The render was the whole cost; cached now",
    })
  })

  it("shows what was already tried before the next experiment on the same route", async () => {
    const { related } = await startExperiment(project, {
      theory: "Try it again",
      routes: ["/event"],
      target: "port",
    })
    expect(related.map((e) => e.decision?.verdict)).toEqual(["keep"])
  })

  it("will not keep a change that broke the contract", async () => {
    const { experiment } = await startExperiment(project, {
      theory: "Render the about page from a different template",
      routes: ["/about"],
      target: "port",
    })
    project.lock.routes["/about"]!.cases["default"]!.expect!.status = 201
    await measureExperiment(project, experiment.id)
    expect(() => decideExperiment(project, experiment.id, "keep", "faster")).toThrow(
      /broke the contract/,
    )
    decideExperiment(project, experiment.id, "discard", "it broke the page")
    project.lock.routes["/about"]!.cases["default"]!.expect!.status = 200
  })
})
