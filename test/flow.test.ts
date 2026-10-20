import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Server } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { CONFIG_FILE, readLock } from "../src/config.ts"
import { discover } from "../src/discover/index.ts"
import { openProject, type Project } from "../src/project.ts"
import { lock, loosen, ratchet } from "../src/ratchet.ts"
import { runBatch, runTarget } from "../src/run.ts"
import { serve } from "../src/server/server.ts"
import { compareRefs, statusOf } from "../src/status.ts"
import type { CaseVerdict } from "../src/verdict.ts"
import { site } from "./fixtures/site.ts"

let dir: string
let servers: Server[]
let project: Project

const verdict = (target: string, key: string): CaseVerdict => {
  const evaluation = statusOf(project, [target])[0]!.evaluation
  const found = evaluation.routes.flatMap((r) => r.cases).find((c) => c.key === key)
  if (!found) throw new Error(`no verdict for ${key}`)
  return found
}

beforeAll(async () => {
  const [legacy, port] = await Promise.all([site("legacy"), site("port")])
  servers = [legacy.server, port.server]
  dir = mkdtempSync(join(tmpdir(), "portside-"))
  writeFileSync(
    join(dir, CONFIG_FILE),
    JSON.stringify({
      baseline: "legacy",
      targets: { legacy: { url: legacy.url }, port: { url: port.url } },
      probe: { repeats: 4, concurrency: 2 },
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
    }),
  )
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
    const again = await discover(project, { sitemap: true })
    expect(again.added).toEqual([])
    expect(again.samplesAdded).toEqual([])
  })

  it("takes routes and conditional cases by hand", () => {
    project.lock.routes["/old"] = {
      samples: ["/old"],
      source: "manual",
      cases: { default: { history: [] } },
    }
    project.lock.routes["/api/data"] = {
      samples: ["/api/data"],
      source: "manual",
      cases: { default: { history: [] } },
    }
    project.lock.routes["/missing"] = {
      samples: ["/missing"],
      source: "manual",
      cases: { default: { history: [] } },
    }
    project.lock.routes["/event/:event/:event2"]!.cases["es-cookie"] = {
      headers: { cookie: "locale=es" },
      history: [],
    }
    project.saveLock()
  })

  it("judges the port against the legacy site before anything is locked", async () => {
    const batch = await runBatch(project, { targets: ["legacy", "port"] })
    expect(batch.runs.map((r) => r.target)).toEqual(["legacy", "port"])
    expect(verdict("legacy", "/old#default").reference).toBe("none")
    const old = verdict("port", "/old#default")
    expect(old.reference).toBe("baseline")
    expect(old.contract.diffs).toMatchObject([{ field: "status", expected: 301, actual: 308 }])
  })

  it("locks what the legacy site does", () => {
    const changes = lock(project, { from: "legacy" })
    expect(changes.filter((c) => c.skipped)).toEqual([])
    const lockFile = readLock(dir)
    const event = lockFile.routes["/event/:event/:event2"]!.cases
    expect(event["default"]!.expect).toMatchObject({ status: 200, cache: "cached" })
    expect(event["es-cookie"]!.expect).toMatchObject({
      status: 307,
      record: { location: "/es/event/{event}/{event2}" },
    })
    expect(lockFile.routes["/blog/:blog"]!.cases["default"]!.expect!.cache).toBe("uncached")
    expect(lock(project, { from: "legacy" }).every((c) => c.skipped)).toBe(true)
    expect(() => lock(project, { from: "legacy", force: true })).toThrow(/reason/)
  })

  it("holds the port to the lock", () => {
    expect(verdict("legacy", "/event/:event/:event2#default").state).toBe("pass")

    expect(verdict("port", "/old#default").state).toBe("fail")

    const once = verdict("port", "/event/:event/:event2#default")
    expect(once.perf).toMatchObject({
      state: "warn",
      against: "legacy",
      paired: true,
      call: "worse",
    })
    expect(once.perf.note).toMatch(/run again to confirm/)
  })

  it("fails a slowdown once a second batch confirms it", async () => {
    await runBatch(project, { targets: ["legacy", "port"] })
    const event = verdict("port", "/event/:event/:event2#default")
    expect(event.perf).toMatchObject({
      state: "fail",
      against: "legacy",
      paired: true,
      call: "worse",
    })
    expect(event.cache).toMatchObject({ state: "fail", expected: "cached", actual: "uncached" })

    expect(verdict("port", "/event/:event/:event2#es-cookie").state).toBe("pass")

    const api = verdict("port", "/api/data#default")
    expect(api.contract.diffs).toMatchObject([
      { field: "cache-control", allowed: "edge-cache-control" },
    ])
    expect(api.contract.state).toBe("pass")

    // Both sides 404; only the content type differs, and an error is judged on its status alone.
    expect(verdict("port", "/missing#default").contract.state).toBe("pass")

    const { evaluation } = statusOf(project, ["port"])[0]!
    expect(evaluation.unusedAllowances).toEqual(["never-used"])
    expect(evaluation.routes[0]!.state).toBe("fail")
  })

  it("forgives an uncached route that is fast enough, when the route allows it", () => {
    const blog = project.lock.routes["/blog/:blog"]!.cases["default"]!.expect!
    blog.cache = "cached"
    expect(verdict("port", "/blog/:blog#default").cache).toMatchObject({ state: "warn" })
    project.lock.routes["/blog/:blog"]!.cachePolicy = "must-match"
    expect(verdict("port", "/blog/:blog#default").cache.state).toBe("fail")
    delete project.lock.routes["/blog/:blog"]!.cachePolicy
    blog.cache = "uncached"
  })

  it("tells the legacy site when the port is faster, and ratchets the record down", () => {
    const legacy = verdict("legacy", "/blog/:blog#default").perf
    expect(legacy).toMatchObject({ state: "warn", against: "port", paired: true })
    expect(legacy.note).toMatch(/carry it back/)

    const before = project.lock.routes["/blog/:blog"]!.cases["default"]!.expect!.ttfb!.median
    const changes = ratchet(project)
    const blog = changes.find((c) => c.key === "/blog/:blog#default" && c.field === "ttfb")
    expect(blog).toMatchObject({ source: "port" })
    expect(blog!.to as number).toBeLessThan(before)
    expect(changes.some((c) => c.key === "/old#default")).toBe(false)
  })

  it("only warns on timings measured at another time", async () => {
    await runTarget(project, { target: "port", routes: (p) => p.startsWith("/event/") })
    const event = verdict("port", "/event/:event/:event2#default").perf
    expect(event).toMatchObject({ state: "warn", against: "lock", paired: false, call: "worse" })
  })

  it("loosens only with a reason, and keeps it", () => {
    expect(() => loosen(project, "/blog/:blog#default", { ttfb: 200, reason: "" })).toThrow(
      /reason/,
    )
    loosen(project, "/blog/:blog#default", {
      ttfb: 200,
      reason: "legacy is frozen; 200ms is fine here",
    })
    const history = readLock(dir).routes["/blog/:blog"]!.cases["default"]!.history
    expect(history.map((h) => h.by)).toEqual(["lock", "ratchet", "loosen"])
    expect(history.at(-1)!.reason).toBe("legacy is frozen; 200ms is fine here")
    expect(verdict("legacy", "/blog/:blog#default").perf).toMatchObject({ state: "pass", max: 200 })
  })

  it("compares two runs head to head, for trying a strategy out", async () => {
    await runTarget(project, { target: "port", label: "experiment", routes: (p) => p === "/" })
    const result = compareRefs(project, "legacy", "port@experiment")
    const routes = result.evaluation.routes.filter((r) => r.cases.some((c) => c.observed))
    expect(routes.map((r) => r.route)).toEqual(["/"])
  })

  it("re-running one route updates it without hiding the rest", () => {
    expect(verdict("port", "/old#default").observed).toBe(true)
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
        const e = error as { status: number; stdout: string; stderr: string }
        return { code: e.status, stdout: e.stdout, stderr: e.stderr }
      }
    }
    const status = run("status", "--json")
    expect(status.code).toBe(0)
    expect(JSON.parse(status.stdout).map((t: { target: string }) => t.target)).toEqual([
      "legacy",
      "port",
    ])
    expect(run("status", "--gate", "--target", "port").code).toBe(1)
    expect(run("status", "--gate", "--target", "legacy").code).toBe(0)
    expect(run("show", "/old").stdout).toContain("status: 301 → 308")
    expect(run("status", "--markdown").stdout).toContain("| `/old#default` |")
    expect(run("nonsense").code).toBe(2)
  })

  it("serves the dashboard and its state", async () => {
    const server = await serve(project, { port: 0, host: "127.0.0.1" })
    try {
      const html = await (await fetch(server.url)).text()
      expect(html).toContain("<title>Portside</title>")
      const state = await (await fetch(`${server.url}/api/state`)).json()
      expect(state.status.map((s: { target: string }) => s.target)).toEqual(["legacy", "port"])
      const route = await (
        await fetch(`${server.url}/api/route?pattern=${encodeURIComponent("/old")}`)
      ).json()
      expect(route.observations.port[0].status).toBe(308)
    } finally {
      await server.close()
    }
  })

  it("writes a lock two people would write the same way", () => {
    const text = readFileSync(join(dir, "portside.lock.json"), "utf8")
    const keys = Object.keys(JSON.parse(text).routes)
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)))
  })
})
