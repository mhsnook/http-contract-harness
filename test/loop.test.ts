import { existsSync, readFileSync, rmSync } from "node:fs"
import type { Server } from "node:http"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { LEDGER_FILE } from "../src/config.ts"
import {
  addFinding,
  decideExperiment,
  listExperiments,
  measureExperiment,
  startExperiment,
} from "../src/ledger.ts"
import { openProject, type Project } from "../src/project.ts"
import { lock } from "../src/ratchet.ts"
import { runBatch } from "../src/run.ts"
import { serveRunner } from "../src/runner.ts"
import { CHROMIUM, makeProject } from "./fixtures/project.ts"
import { site, type Knobs } from "./fixtures/site.ts"

const hasBrowser = existsSync(CHROMIUM)

let dir: string
let servers: Server[]
let project: Project
let port: Knobs
let runner: { url: string; close(): Promise<void> }

const purge = `node -e "fetch(new URL('/__purge?path=' + encodeURIComponent(process.env.HARNESS_PATH), process.env.HARNESS_URL))"`
const command = `node -e "require('fs').writeFileSync(process.env.HARNESS_METRICS, JSON.stringify({ items: process.env.HARNESS_TARGET === 'port' ? 2 : 1 }))"`

const observed = (target: string, route: string, caseId: string, vantage = "local") =>
  project.store.latestFor(target, vantage).filter((o) => o.route === route && o.caseId === caseId)

beforeAll(async () => {
  const [a, b] = await Promise.all([site("legacy"), site("port")])
  servers = [a.server, b.server]
  port = b.knobs
  runner = await serveRunner({
    port: 0,
    host: "127.0.0.1",
    token: "secret",
    region: "weur",
    browser: { executablePath: CHROMIUM },
    cwd: process.cwd(),
  })
  dir = makeProject({
    baseline: "legacy",
    targets: {
      legacy: { url: a.url, options: { purge } },
      port: { url: b.url, options: { purge } },
    },
    vantages: {
      local: { browser: { executablePath: CHROMIUM } },
      eu: { url: runner.url, token: "${HARNESS_TEST_TOKEN}", region: "weur" },
    },
    run: { repeats: 4, concurrency: 2 },
  })
  process.env.HARNESS_TEST_TOKEN = "secret"
  project = openProject(dir)
  const route = (samples: string[], cases: Record<string, object> = {}) => ({
    samples,
    source: "manual",
    cases: {
      default: { history: [] },
      ...Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, { ...v, history: [] }])),
    },
  })
  project.lock.routes["/about"] = route(["/about"], {
    revalidate: { probe: "http", conditions: { cache: "revalidate" } },
    load: { probe: "page" },
    reload: { probe: "page", conditions: { reload: true } },
    navigate: { probe: "navigate", conditions: { from: "/" } },
    command: { probe: "command", conditions: { command } },
  })
  project.lock.routes["/event/:city/:id"] = route(["/event/london/1"], {
    cold: { probe: "http", conditions: { cache: "cold" } },
  })
  project.lock.routes["/sticky"] = route(["/sticky"], {
    cold: { probe: "http", conditions: { cache: "cold" } },
  })
  project.saveLock()
})

afterAll(async () => {
  project?.store.close()
  for (const s of servers) s.close()
  await runner?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("the starter probes", { timeout: 90_000 }, () => {
  it("measure every case on every target, interleaved, from this machine", async () => {
    const result = await runBatch(project, {
      targets: ["legacy", "port"],
      vantages: ["local"],
      routes: (p) => p !== "/about" || hasBrowser,
    })
    const errors = result.observations.filter((o) => o.error && o.route !== "/sticky")
    expect(errors.map((o) => `${o.route}#${o.caseId}: ${o.error}`)).toEqual([])
  })

  it("revalidate with the ETag a first answer carried", () => {
    const [o] = observed("legacy", "/about", "revalidate")
    expect(o).toMatchObject({ status: 304, probe: "http" })
    expect(o!.primary).toHaveLength(4)
  })

  it("purge before each cold request, and count only the requests that missed", () => {
    const [legacy] = observed("legacy", "/event/:city/:id", "cold")
    expect(legacy!.primary).toHaveLength(4)
    expect(legacy!.skipped).toEqual([])
    const [sticky] = observed("legacy", "/sticky", "cold")
    expect(sticky!.skipped).toHaveLength(4)
    expect(sticky!.error).toMatch(/no repeat counted: the purge did not take/)
  })

  it("run a person's own command per target and keep what it reports", () => {
    const [legacy] = observed("legacy", "/about", "command")
    const [other] = observed("port", "/about", "command")
    expect(legacy!.metrics["items"]).toEqual([1, 1, 1])
    expect(other!.metrics["items"]).toEqual([2, 2, 2])
    expect(legacy!.primary).toEqual(legacy!.metrics["durationMs"])
  })

  it.skipIf(!hasBrowser)("load, reload and navigate in a real browser", () => {
    expect(observed("legacy", "/about", "load")[0]!.metrics["load"]).toHaveLength(5)
    expect(observed("port", "/about", "reload")[0]!.metrics["ttfb"]).toHaveLength(5)
    const [nav] = observed("legacy", "/about", "navigate")
    expect(nav!.status).toBe(200)
    expect(nav!.primary).toEqual(nav!.metrics["navMs"])
  })
})

describe("a remote vantage", { timeout: 60_000 }, () => {
  it("runs the same probes on a runner and reports where it ran", async () => {
    const result = await runBatch(project, {
      targets: ["legacy", "port"],
      vantages: ["eu"],
      routes: (p) => p === "/event/:city/:id",
    })
    expect(result.batches).toMatchObject([{ vantage: "eu", region: "weur" }])
    const [o] = observed("port", "/event/:city/:id", "default", "eu")
    expect(o).toMatchObject({ vantage: "eu", region: "weur", probe: "http", error: null })
    const local = observed("port", "/event/:city/:id", "default", "local")[0]
    expect(o!.probeHash).toBe(local!.probeHash)
  })

  it("refuses a client without the token", async () => {
    const res = await fetch(new URL("/run", runner.url), { method: "POST", body: "{}" })
    expect(res.status).toBe(401)
  })
})

describe("the experiment loop", { timeout: 90_000 }, () => {
  it("records a theory, measures before and after, and corrects for drift", async () => {
    await lock(project, { from: "legacy", vantages: ["local"] })
    addFinding(project, {
      text: "The event page renders on every request on the port; nothing caches it",
      routes: ["/event/:city/:id"],
      tags: ["cache"],
    })
    port.eventDelay = 80
    const { experiment, related } = await startExperiment(project, {
      theory: "Serve the event page without the 80ms render",
      routes: ["/event/:city/:id"],
      target: "port",
      vantages: ["local"],
    })
    expect(related.experiments).toEqual([])
    expect(related.findings.map((f) => f.tags)).toEqual([["cache"]])
    port.eventDelay = 0
    const { experiment: measured, warnings } = await measureExperiment(project, experiment.id)
    expect(warnings.filter((w) => w.includes("probe"))).toEqual([])
    const event = measured.result!.cases.find((c) => c.key === "/event/:city/:id#default")!
    expect(event).toMatchObject({
      change: "better",
      vantage: "local",
      probe: "http",
      metric: "ttfb",
    })
    expect(event.deltaMs!).toBeLessThan(-50)
    expect(measured.result!.broken).toBe(0)
  })

  it("keeps the decision, its reason and the findings in one committed ledger", () => {
    const [experiment] = listExperiments(project)
    expect(() => decideExperiment(project, experiment!.id, "keep", "")).toThrow(/why/)
    decideExperiment(project, experiment!.id, "keep", "The render was the whole cost")
    const ledger = JSON.parse(readFileSync(join(dir, LEDGER_FILE), "utf8"))
    expect(ledger.experiments[0].decision).toMatchObject({ verdict: "keep" })
    expect(ledger.findings).toHaveLength(1)
  })

  it("shows what was already tried before the next experiment on the same route", async () => {
    const { related } = await startExperiment(project, {
      theory: "Try it again",
      routes: ["/event"],
      target: "port",
      vantages: ["local"],
    })
    expect(related.experiments.map((e) => e.decision?.verdict)).toEqual(["keep"])
  })

  it("will not keep a change that broke the contract", async () => {
    const { experiment } = await startExperiment(project, {
      theory: "Render the about page from a different template",
      routes: ["/about"],
      target: "port",
      vantages: ["local"],
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
