import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { judgedByLock, readConfig, referenceOf, tracksOf } from "../src/config.ts"
import { discover } from "../src/discover/index.ts"
import { planOf, priorityRoutes } from "../src/plan.ts"
import { openProject, type Project } from "../src/project.ts"
import { regionOf, rowsFromCsv, survey } from "../src/survey.ts"
import { makeProject } from "./fixtures/project.ts"

let dir: string
let project: Project

const SOURCE = `export default {
  describe: "a fake analytics export",
  async rows(ctx) {
    if (ctx.options.site !== "example.com") throw new Error("options did not arrive")
    return [
      { path: "/", views: 500, entries: 300, country: "GB" },
      { path: "/event/london/1", views: 300, entries: 250, country: "GB" },
      { path: "/event/paris/2", views: 100, entries: 90, country: "FR" },
      { path: "/about", views: 60, entries: 5, country: "US" },
      { path: "/pricing", views: 40, entries: 30, country: "US" },
    ]
  },
}`

beforeAll(() => {
  dir = makeProject({
    baseline: "legacy",
    targets: { legacy: { url: "http://127.0.0.1:9" }, port: { url: "http://127.0.0.1:9" } },
    survey: { sources: { fake: { site: "example.com" } } },
  })
  mkdirSync(join(dir, "harness/sources"), { recursive: true })
  writeFileSync(join(dir, "harness/sources/fake.mjs"), SOURCE)
  writeFileSync(join(dir, "harness/sources/_off.mjs"), "throw new Error('never loaded')")
  project = openProject(dir)
  const route = (samples: string[]) => ({
    samples,
    source: "manual",
    cases: { default: { history: [] } },
  })
  project.lock.routes["/"] = route(["/"])
  project.lock.routes["/event/:city/:id"] = route(["/event/london/1"])
  project.lock.routes["/about"] = route(["/about"])
  project.saveLock()
})

afterAll(() => {
  project?.store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("the survey", () => {
  it("says where readers go, where they land and where they are", async () => {
    const report = await survey(project)
    expect(report.sources).toEqual([{ name: "fake", rows: 5 }])
    expect(report.routes.map((r) => r.route)).toEqual(["/", "/event/:city/:id", "/about"])
    expect(report.routes[1]).toMatchObject({
      views: 400,
      entries: 340,
      share: 0.4,
      entryShare: 0.504,
    })
    expect(report.uncovered).toEqual([{ path: "/pricing", views: 40, entries: 30 }])
    expect(report.regions).toEqual({ weur: 0.9, nam: 0.1 })
  })

  it("weighs the inventory by it", () => {
    expect(project.lock.routes["/event/:city/:id"]!.weight).toBe(400)
    expect(project.lock.routes["/"]!.traffic).toMatchObject({ share: 0.5, entryShare: 0.444 })
  })

  it("picks the routes that hold most of the views and of the entries", () => {
    expect(priorityRoutes(project)).toEqual(["/", "/event/:city/:id"])
  })

  it("adds routes for the traffic no route covered", async () => {
    const report = await discover(project, { traffic: true })
    expect(report.added).toEqual(["/pricing"])
  })

  it("reads analytics exports by their column names", () => {
    const rows = rowsFromCsv(
      'Page,Pageviews,Entrances,Country\n/a,"1,200",30,DE\nhttps://x.example/b,5,1,JP\n',
    )
    expect(rows).toEqual([
      { path: "/a", views: 1200, entries: 30, country: "DE" },
      { path: "/b", views: 5, entries: 1, country: "JP" },
    ])
    expect([regionOf("de"), regionOf("JP"), regionOf("ZZ")]).toEqual(["weur", "apac", "other"])
  })

  it("plans the port from where the project stands", async () => {
    let plan = await planOf(project)
    expect(plan.phases.map((p) => p.id)).toEqual([
      "survey",
      "inventory",
      "profile",
      "parity:port",
      "improve",
      "launch",
    ])
    expect(plan.phase).toBe("survey")
    expect(plan.phases[0]!.checks.find((c) => c.text.includes("region"))!.ok).toBe(false)
    project.config.regions = { weur: 0.9, nam: 0.1 }
    plan = await planOf(project)
    expect(plan.phases[0]!.done).toBe(true)
    expect(plan.phase).toBe("profile")
    const profile = plan.phases.find((p) => p.id === "profile")!
    expect(profile.checks.find((c) => c.text.includes("no vantage"))!.text).toContain("weur")
  })
})

describe("tracks", () => {
  it("judge each port against its own track, and only production by the lock", () => {
    const d = makeProject({
      baseline: "current",
      targets: {
        current: { url: "https://www.example.com" },
        "current-dev": { url: "http://localhost:3000", vantages: ["local"] },
        "port-dev": { url: "http://localhost:3001", vantages: ["local"] },
        port: { url: "https://port.example.com" },
      },
      tracks: [
        { name: "dev", baseline: "current-dev", port: "port-dev" },
        { name: "production", baseline: "current", port: "port" },
      ],
    })
    const config = readConfig(d)
    expect(tracksOf(config).map((t) => t.name)).toEqual(["dev", "production"])
    expect(referenceOf(config, "port-dev")).toBe("current-dev")
    expect(referenceOf(config, "current-dev")).toBe("current-dev")
    expect(referenceOf(config, "port")).toBe("current")
    expect(judgedByLock(config, "port-dev")).toBe(false)
    expect(judgedByLock(config, "port")).toBe(true)
    rmSync(d, { recursive: true, force: true })
  })

  it("plan dev parity before production parity", async () => {
    const d = makeProject({
      baseline: "current",
      targets: {
        current: { url: "http://127.0.0.1:9" },
        "current-dev": { url: "http://127.0.0.1:9" },
        "port-dev": { url: "http://127.0.0.1:9" },
        port: { url: "http://127.0.0.1:9" },
      },
      tracks: [
        { name: "dev", baseline: "current-dev", port: "port-dev" },
        { name: "production", baseline: "current", port: "port" },
      ],
    })
    const p = openProject(d)
    const plan = await planOf(p)
    expect(plan.phases.map((x) => x.id)).toEqual([
      "survey",
      "inventory",
      "profile",
      "parity:dev",
      "parity:production",
      "improve",
      "launch",
    ])
    expect(plan.phases[2]!.title).toContain("current-dev, current")
    expect(plan.readiness.track).toBe("production")
    p.store.close()
    rmSync(d, { recursive: true, force: true })
  })
})
