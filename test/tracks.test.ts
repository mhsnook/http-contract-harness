import { rmSync } from "node:fs"
import type { Server } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startSite, type Fixes } from "../src/demo/sites.ts"
import { planOf } from "../src/plan.ts"
import { openProject, type Project } from "../src/project.ts"
import { runBatch } from "../src/run.ts"
import { statusOf } from "../src/status.ts"
import type { CaseVerdict } from "../src/verdict.ts"
import { makeProject } from "./fixtures/project.ts"

let dir: string
let servers: Server[]
let project: Project
const fixes: Fixes = { redirect: false, eventCache: false, prerender: false }

const verdict = async (target: string, key: string): Promise<CaseVerdict> => {
  const [entry] = await statusOf(project, { targets: [target] })
  const found = entry!.evaluation.routes.flatMap((r) => r.cases).find((c) => c.key === key)
  if (!found) throw new Error(`no verdict for ${key}`)
  return found
}

beforeAll(async () => {
  const [current, currentDev, portDev] = await Promise.all(
    (["current", "current-dev", "port-dev"] as const).map((k) => startSite(k, fixes)),
  )
  servers = [current!.server, currentDev!.server, portDev!.server]
  dir = makeProject({
    baseline: "current",
    targets: {
      current: { url: current!.url },
      "current-dev": { url: currentDev!.url, options: { purge: false } },
      "port-dev": { url: portDev!.url, options: { purge: false } },
    },
    tracks: [{ name: "dev", baseline: "current-dev", port: "port-dev" }],
    run: { repeats: 4, concurrency: 2 },
  })
  project = openProject(dir)
  const route = (samples: string[], cases: Record<string, object> = {}) => ({
    samples,
    source: "manual",
    cases: { default: { history: [] }, ...cases },
  })
  project.lock.routes["/blog/:slug"] = route(["/blog/a-year-of-protests"])
  project.lock.routes["/old-events"] = route(["/old-events"])
  project.lock.routes["/event/:city/:id"] = route(["/event/london/nhs-rally"], {
    cold: { probe: "http", conditions: { cache: "cold" }, history: [] },
  })
  project.saveLock()
  await runBatch(project, { targets: ["current-dev", "port-dev"] })
  await runBatch(project, { targets: ["current-dev", "port-dev"] })
})

afterAll(() => {
  project?.store.close()
  for (const s of servers) s.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("the dev track", () => {
  it("judges the port against the current site's dev server, batch by batch", async () => {
    const redirect = await verdict("port-dev", "/old-events#default")
    expect(redirect.reference).toBe("baseline")
    expect(redirect.contract.diffs.map((d) => [d.field, d.expected, d.actual])).toContainEqual([
      "status",
      301,
      308,
    ])
    const blog = await verdict("port-dev", "/blog/:slug#default")
    expect(blog.perf).toMatchObject({ against: "current-dev", paired: true, call: "better" })
  })

  it("treats the current site's dev server as the reference, and asks it to carry back a win", async () => {
    const blog = await verdict("current-dev", "/blog/:slug#default")
    expect(blog.reference).toBe("self")
    expect(blog.contract.state).toBe("pass")
    expect(blog.perf).toMatchObject({ state: "warn", against: "port-dev" })
    expect(blog.perf.note).toContain("carry it back")
  })

  it("lists a change to carry back without holding the port's phases open", async () => {
    const improve = (await planOf(project)).phases.find((p) => p.id === "improve")!
    const carry = improve.checks.find((c) => c.note)
    expect(carry?.text).toContain("/blog/:slug#default to current-dev from port-dev")
    expect(improve.checks.filter((c) => !c.ok && !c.note)).toEqual([])
  })

  it("measures a cold case on a server with nothing to purge", async () => {
    const cold = await verdict("port-dev", "/event/:city/:id#cold")
    expect(cold.contract.diffs.filter((d) => d.field === "error")).toEqual([])
    expect(cold.observed).toBe(true)
  })

  it("counts the port as measured only once it has observations", async () => {
    const parity = (await planOf(project)).phases.find((p) => p.id === "parity:dev")!
    expect(parity.checks[0]).toMatchObject({ ok: true })
    const fresh = makeProject({
      baseline: "current",
      targets: { current: { url: "http://127.0.0.1:9" }, port: { url: "http://127.0.0.1:9" } },
    })
    const empty = openProject(fresh)
    empty.lock.routes["/"] = {
      samples: ["/"],
      source: "manual",
      cases: { default: { history: [] } },
    }
    empty.saveLock()
    const plan = await planOf(empty)
    expect(plan.phases.find((p) => p.id === "parity:port")!.checks[0]).toMatchObject({
      ok: false,
      text: "port not measured yet",
    })
    empty.store.close()
    rmSync(fresh, { recursive: true, force: true })
  })
})
