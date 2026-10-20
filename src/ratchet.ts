import type { CacheClass } from "./cache.ts"
import { caseKey, type Expect } from "./config.ts"
import type { Observation } from "./db.ts"
import { casesOf, type Project } from "./project.ts"
import { commonRecord } from "./record.ts"
import { callChange, summarise, type Summary } from "./stats.ts"
import { evaluate, warmTimings } from "./verdict.ts"

export type Change = {
  key: string
  field: string
  from?: unknown
  to?: unknown
  source?: string
  skipped?: string
}

const now = () => new Date().toISOString()

function majority(observations: Observation[]): CacheClass {
  const known = observations.map((o) => o.cache).filter((c) => c !== "unknown")
  if (known.length === 0) return "unknown"
  return known.filter((c) => c === "cached").length * 2 >= known.length ? "cached" : "uncached"
}

export type LockOptions = {
  from: string
  runId?: number
  only?: (key: string, pattern: string) => boolean
  force?: boolean
  reason?: string
  dryRun?: boolean
}

export function lock(project: Project, opts: LockOptions): Change[] {
  if (opts.force && !opts.reason) throw new Error("Re-locking a locked case needs --reason")
  const observations =
    opts.runId !== undefined
      ? project.store.observationsOf(opts.runId)
      : project.store.latestFor(opts.from)
  const source = opts.runId !== undefined ? `run ${opts.runId}` : opts.from
  const changes: Change[] = []

  for (const [pattern, route, caseId, def] of casesOf(project.lock)) {
    const key = caseKey(pattern, caseId)
    if (opts.only && !opts.only(key, pattern)) continue
    const seen = observations.filter(
      (o) => o.route === pattern && o.caseId === caseId && route.samples.includes(o.sample),
    )
    const ok = seen.filter((o) => o.record && !o.error)
    if (ok.length === 0) {
      changes.push({ key, field: "*", skipped: `no observations from ${source}` })
      continue
    }
    if (def.expect && !opts.force) {
      changes.push({ key, field: "*", skipped: "already locked (use --force --reason to re-lock)" })
      continue
    }
    const record = { ...commonRecord(ok.map((o) => o.record!))! }
    const status = record["status"] as number
    delete record["status"]
    const cache = majority(ok)
    const timings = summarise(ok.flatMap(warmTimings))
    const expect: Expect = {
      status,
      record,
      cache: cache === "unknown" ? undefined : cache,
      ttfb: timings,
      lockedFrom: source,
      lockedAt: now(),
    }
    changes.push({ key, field: "*", from: def.expect, to: expect, source })
    if (opts.dryRun) continue
    def.history.push({
      at: expect.lockedAt as string,
      by: "lock",
      field: "*",
      from: def.expect ? summariseExpect(def.expect) : undefined,
      to: summariseExpect(expect),
      reason: opts.reason,
    })
    def.expect = expect
  }
  if (!opts.dryRun) project.saveLock()
  return changes
}

function summariseExpect(e: Expect) {
  return { status: e.status, cache: e.cache, ttfb: e.ttfb?.median, ttfbMax: e.ttfbMax }
}

export function ratchet(project: Project, opts: { dryRun?: boolean } = {}): Change[] {
  const { config } = project
  const best = new Map<string, { ttfb?: [Summary, string]; cache?: string }>()

  for (const [name, target] of Object.entries(config.targets)) {
    if (!target.ratchet) continue
    const evaluation = evaluate({
      config,
      lock: project.lock,
      target: name,
      observations: project.store.latestFor(name),
    })
    for (const route of evaluation.routes) {
      for (const c of route.cases) {
        if (c.reference !== "lock" || c.contract.state !== "pass") continue
        const entry = best.get(c.key) ?? {}
        const actual = c.perf.actual
        const expect = project.lock.routes[route.route]?.cases[c.caseId]?.expect
        const beats =
          actual && expect
            ? expect.ttfb
              ? callChange(expect.ttfb, actual, config.perf.threshold, config.perf.minDeltaMs) ===
                "better"
              : expect.ttfbMax !== undefined && actual.p75 < expect.ttfbMax
            : false
        if (actual && beats && (!entry.ttfb || actual.median < entry.ttfb[0].median)) {
          entry.ttfb = [actual, name]
        }
        if (c.cache.actual === "cached") entry.cache ??= name
        best.set(c.key, entry)
      }
    }
  }

  const changes: Change[] = []
  for (const [pattern, , caseId, def] of casesOf(project.lock)) {
    const key = caseKey(pattern, caseId)
    const found = best.get(key)
    const expect = def.expect
    if (!found || !expect) continue
    if (found.ttfb) {
      const [summary, by] = found.ttfb
      const from = expect.ttfb?.median ?? expect.ttfbMax
      changes.push({ key, field: "ttfb", from, to: summary.median, source: by })
      if (!opts.dryRun) {
        def.history.push({
          at: now(),
          by: "ratchet",
          field: "ttfb",
          from,
          to: summary.median,
          reason: `beaten by ${by}`,
        })
        expect.ttfb = summary
      }
    }
    if (found.cache && expect.cache !== "cached") {
      changes.push({ key, field: "cache", from: expect.cache, to: "cached", source: found.cache })
      if (!opts.dryRun) {
        def.history.push({
          at: now(),
          by: "ratchet",
          field: "cache",
          from: expect.cache,
          to: "cached",
          reason: `cached on ${found.cache}`,
        })
        expect.cache = "cached"
      }
    }
  }
  if (!opts.dryRun && changes.length > 0) project.saveLock()
  return changes
}

export type LoosenOptions = {
  /** A ceiling on the median in place of the locked distribution, or `none` to stop judging TTFB. */
  ttfb?: number | "none"
  cache?: "uncached" | "none"
  drop?: string[]
  set?: Record<string, string>
  reason: string
}

export function loosen(project: Project, key: string, opts: LoosenOptions): Change[] {
  if (!opts.reason?.trim()) throw new Error("loosen needs --reason")
  const hash = key.lastIndexOf("#")
  const pattern = hash === -1 ? key : key.slice(0, hash)
  const caseId = hash === -1 ? "default" : key.slice(hash + 1)
  const def = project.lock.routes[pattern]?.cases[caseId]
  if (!def?.expect) throw new Error(`${caseKey(pattern, caseId)} has no lock to loosen`)
  const expect = def.expect
  const changes: Change[] = []
  const note = (field: string, from: unknown, to: unknown) => {
    changes.push({ key: caseKey(pattern, caseId), field, from, to })
    def.history.push({ at: now(), by: "loosen", field, from, to, reason: opts.reason })
  }
  if (opts.ttfb !== undefined) {
    const to = opts.ttfb === "none" ? undefined : opts.ttfb
    note("ttfb", expect.ttfbMax ?? expect.ttfb?.median, to ?? "none")
    delete expect.ttfb
    expect.ttfbMax = to
  }
  if (opts.cache) {
    const to = opts.cache === "none" ? undefined : opts.cache
    note("cache", expect.cache, to)
    expect.cache = to
  }
  for (const field of opts.drop ?? []) {
    if (field === "status") throw new Error("status cannot be dropped; set it with --set status=…")
    note(field, expect.record[field], undefined)
    delete expect.record[field]
  }
  for (const [field, value] of Object.entries(opts.set ?? {})) {
    const typed = field === "status" ? Number(value) : value
    note(field, field === "status" ? expect.status : expect.record[field], typed)
    if (field === "status") expect.status = typed as number
    else expect.record[field] = typed
  }
  if (changes.length === 0)
    throw new Error("Nothing to loosen: pass --ttfb, --cache, --drop or --set")
  project.saveLock()
  return changes
}
