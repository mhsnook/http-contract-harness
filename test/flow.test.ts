import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import type { Server } from "node:http"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { readLock } from "../src/config.ts"
import { discover } from "../src/discover/index.ts"
import { openProject, type Project } from "../src/project.ts"
import { lock, loosen, ratchet } from "../src/ratchet.ts"
import { runBatch } from "../src/run.ts"
import { serve } from "../src/server/server.ts"
import { compareRefs, statusOf } from "../src/status.ts"
import type { CaseVerdict } from "../src/verdict.ts"
import { makeProject } from "./fixtures/project.ts"
import { site } from "./fixtures/site.ts"

let dir: string
let servers: Server[]
let project: Project

const verdict = async (target: string, key: string): Promise<CaseVerdict> => {
  const [entry] = await statusOf(project, { targets: [target] })
  const found = entry!.evaluation.routes.flatMap((r) => r.cases).find((c) => c.key === key)
  if (!found) throw new Error(`no verdict for ${key}`)
  return found
}
const both = () => runBatch(project, { targets: ["legacy", "port"] })

beforeAll(async () => {
  const [legacy, port] = await Promise.all([site("legacy"), site("port")])
  servers = [legacy.server, port.server]
  dir = makeProject({
    baseline: "legacy",
    targets: { legacy: { url: legacy.url }, port: { url: port.url } },
    run: { repeats: 4, concurrency: 2 },
    allow: [
      {
        id: "edge-cache-control",
        why: "The new host keeps the shared policy at the edge and tells browsers to revalidate",
        field: "cache-control",
        path: "^/api/",
        expected: "^public, ",
        actual: "^private, max-age=0",
      },
      {
        id: "never-used",
        why: "Here to be reported as unused",
        field: "status",
        path: "^/nowhere$",
      },
    ],
  })
  project = openProject(dir)
})

afterAll(() => {
  project?.store.close()
  for (const s of servers) s.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("a port, route by route", () => {
  it("discovers the inventory from the sitemap", async () => {
    const report = await discover(project, { sitemap: true })
    expect(report.added.sort()).toEqual(
      ["/", "/about", "/blog/:blog", "/event/:event/:event2"].sort(),
    )
    expect(project.lock.routes["/event/:event/:event2"]!.samples).toEqual([
      "/event/london/1",
      "/event/paris/2",
      "/event/rome/3",
    ])
    expect((await discover(project, { sitemap: true })).added).toEqual([])
  })

  it("takes routes and conditional cases by hand", () => {
    const route = (samples: string[]) => ({
      samples,
      source: "manual",
      cases: { default: { history: [] } },
    })
    project.lock.routes["/old"] = route(["/old"])
    project.lock.routes["/api/data"] = route(["/api/data"])
    project.lock.routes["/missing"] = route(["/missing"])
    project.lock.routes["/event/:event/:event2"]!.cases["es-cookie"] = {
      headers: { cookie: "locale=es" },
      history: [],
    }
    project.saveLock()
  })

  it("judges the port against the legacy site before anything is locked", async () => {
    const result = await both()
    expect(result.batches.map((b) => b.vantage)).toEqual(["local"])
    expect(result.observations.every((o) => o.probe === "http" && o.probeHash.length === 12)).toBe(
      true,
    )
    expect((await verdict("legacy", "/old#default")).reference).toBe("none")
    const old = await verdict("port", "/old#default")
    expect(old.reference).toBe("baseline")
    expect(old.contract.diffs).toMatchObject([{ field: "status", expected: 301, actual: 308 }])
  })

  it("locks what the legacy site does, with the probe that measured it", async () => {
    const changes = await lock(project, { from: "legacy" })
    expect(changes.filter((c) => c.skipped)).toEqual([])
    const event = readLock(dir).routes["/event/:event/:event2"]!.cases
    expect(event["default"]!.expect).toMatchObject({
      status: 200,
      record: { cache: "cached" },
      probe: { name: "http" },
      metric: "ttfb",
    })
    expect(event["default"]!.expect!.timing["local"]!.n).toBeGreaterThan(0)
    expect(event["es-cookie"]!.expect).toMatchObject({
      status: 307,
      record: { location: "/es/event/{event}/{event2}" },
    })
    expect((await lock(project, { from: "legacy" })).every((c) => c.skipped)).toBe(true)
    await expect(lock(project, { from: "legacy", force: true })).rejects.toThrow(/reason/)
  })

  it("holds the port to the lock", async () => {
    expect((await verdict("legacy", "/event/:event/:event2#default")).state).toBe("pass")
    expect((await verdict("port", "/old#default")).state).toBe("fail")

    const once = await verdict("port", "/event/:event/:event2#default")
    expect(once.perf).toMatchObject({
      state: "warn",
      against: "legacy",
      paired: true,
      call: "worse",
      metric: "ttfb",
    })

    const api = await verdict("port", "/api/data#default")
    expect(api.contract.diffs).toMatchObject([
      { field: "cache-control", allowed: "edge-cache-control" },
    ])
    expect(api.contract.state).toBe("pass")
    expect((await verdict("port", "/missing#default")).contract.state).toBe("pass")
    expect(
      (await statusOf(project, { targets: ["port"] }))[0]!.evaluation.unusedAllowances,
    ).toEqual(["never-used"])
  })

  it("fails a slowdown and a lost cache once a second batch confirms the slowdown", async () => {
    await both()
    const event = await verdict("port", "/event/:event/:event2#default")
    expect(event.perf).toMatchObject({ state: "fail", paired: true })
    expect(event.contract.diffs.length).toBeGreaterThan(0)
    for (const d of event.contract.diffs) {
      expect(d).toMatchObject({
        field: "cache",
        expected: "cached",
        actual: "uncached",
        policy: "if-slower",
      })
    }
    expect(event.contract.state).toBe("fail")
  })

  it("forgives a field the probe marks if-slower while the route is fast, unless the case insists", async () => {
    const blog = project.lock.routes["/blog/:blog"]!.cases["default"]!
    blog.expect!.record["cache"] = "cached"
    const forgiven = await verdict("port", "/blog/:blog#default")
    expect(forgiven.perf.state).toBe("pass")
    expect(forgiven.contract.state).toBe("warn")
    blog.fields = { cache: "must-match" }
    expect((await verdict("port", "/blog/:blog#default")).contract.state).toBe("fail")
    delete blog.fields
    blog.expect!.record["cache"] = "uncached"
  })

  it("tells the legacy site when the port is faster, and ratchets the timing down per vantage", async () => {
    const legacy = (await verdict("legacy", "/blog/:blog#default")).perf
    expect(legacy).toMatchObject({ state: "warn", against: "port", paired: true })
    expect(legacy.note).toMatch(/carry it back/)
    const before =
      project.lock.routes["/blog/:blog"]!.cases["default"]!.expect!.timing["local"]!.median
    const changes = await ratchet(project)
    const blog = changes.find((c) => c.key === "/blog/:blog#default" && c.field === "timing")
    expect(blog).toMatchObject({ source: "port", vantage: "local" })
    expect(blog!.to as number).toBeLessThan(before)
  })

  it("counts a move up a field's order as better, and the ratchet keeps it", async () => {
    const home = project.lock.routes["/"]!.cases["default"]!
    home.expect!.record["cache"] = "uncached"
    const v = await verdict("port", "/#default")
    expect(v.contract.diffs).toMatchObject([{ field: "cache", improved: true }])
    expect(v.contract.state).toBe("pass")
    const changes = await ratchet(project)
    expect(changes.find((c) => c.key === "/#default" && c.field === "cache")).toMatchObject({
      to: "cached",
    })
    expect(home.expect!.record["cache"]).toBe("cached")
  })

  it("loosens only with a reason, and keeps it", async () => {
    expect(() => loosen(project, "/blog/:blog#default", { max: 200, reason: "" })).toThrow(/reason/)
    loosen(project, "/blog/:blog#default", {
      max: 200,
      reason: "legacy is frozen; 200ms is fine here",
    })
    const history = readLock(dir).routes["/blog/:blog"]!.cases["default"]!.history
    expect(history.map((h) => h.by)).toEqual(["lock", "ratchet", "loosen"])
    expect((await verdict("legacy", "/blog/:blog#default")).perf).toMatchObject({
      state: "pass",
      max: 200,
    })
  })

  it("stops comparing a case once its probe changes, until it is measured and locked again", async () => {
    const file = join(dir, "portside/probes/http.mjs")
    const original = readFileSync(file, "utf8")
    appendFileSync(file, "\n// counting changed\n")
    await runBatch(project, { targets: ["legacy", "port"], routes: (p) => p === "/old" })
    const stale = await verdict("port", "/old#default")
    expect(stale.stale).toMatch(/locked with http@/)
    expect(stale.state).toBe("unknown")
    const relock = await lock(project, {
      from: "legacy",
      force: true,
      reason: "the http probe changed",
      only: (k) => k === "/old#default",
    })
    expect(relock.filter((c) => !c.skipped)).toHaveLength(1)
    expect((await verdict("port", "/old#default")).state).toBe("fail")
    writeFileSync(file, original)
    await runBatch(project, { targets: ["legacy", "port"], routes: (p) => p === "/old" })
    await lock(project, {
      from: "legacy",
      force: true,
      reason: "the http probe changed back",
      only: (k) => k === "/old#default",
    })
    expect((await verdict("port", "/old#default")).stale).toBeUndefined()
  })

  it("compares labelled runs head to head", async () => {
    await runBatch(project, { targets: ["port"], label: "experiment", routes: (p) => p === "/" })
    const result = await compareRefs(project, "legacy", "port@experiment")
    expect(
      result.evaluation.routes.filter((r) => r.cases.some((c) => c.observed)).map((r) => r.route),
    ).toEqual(["/"])
  })

  it("runs from the command line, with JSON for agents", () => {
    const cli = join(import.meta.dirname, "../src/cli.ts")
    const run = (...args: string[]) => {
      try {
        return {
          code: 0,
          stdout: execFileSync(process.execPath, [cli, ...args], {
            cwd: dir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }),
        }
      } catch (error) {
        const e = error as { status: number; stdout: string }
        return { code: e.status, stdout: e.stdout }
      }
    }
    const status = run("status", "--json")
    expect(status.code).toBe(0)
    expect(
      JSON.parse(status.stdout).map(
        (t: { target: string; vantage: string }) => `${t.target}/${t.vantage}`,
      ),
    ).toEqual(["legacy/local", "port/local"])
    expect(run("status", "--gate", "--target", "port").code).toBe(1)
    expect(run("show", "/old").stdout).toContain("status: 301 → 308")
    expect(run("status", "--markdown").stdout).toContain("| `/old#default` |")
    expect(
      JSON.parse(run("probe", "list", "--json").stdout).map((p: { name: string }) => p.name),
    ).toEqual(["command", "http", "navigate", "page"])
    expect(JSON.parse(run("plan", "--json").stdout).phase).toBe("survey")
    expect(run("nonsense").code).toBe(2)
  })

  it("serves the dashboard and its state", async () => {
    const server = await serve(project, { port: 0, host: "127.0.0.1" })
    try {
      expect(await (await fetch(server.url)).text()).toContain("<title>Portside</title>")
      const state = await (await fetch(`${server.url}/api/state`)).json()
      expect(state.status.map((s: { target: string }) => s.target)).toEqual(["legacy", "port"])
      expect(state.plan.phases).toHaveLength(6)
      const route = await (
        await fetch(`${server.url}/api/route?pattern=${encodeURIComponent("/old")}`)
      ).json()
      expect(route.observations["port/local"][0].status).toBe(308)
    } finally {
      await server.close()
    }
  })
})
