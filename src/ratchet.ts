import { caseKey, type Expect, type FieldSpec } from "./config.ts"
import { casesOf, probeOf, type Project } from "./project.ts"
import { commonRecord } from "./record.ts"
import { callChange, summarise, type Summary } from "./stats.ts"
import { probeInfo, statusOf, vantagesOf } from "./status.ts"

export type Change = {
  key: string
  field: string
  vantage?: string
  from?: unknown
  to?: unknown
  source?: string
  skipped?: string
}

const now = () => new Date().toISOString()

export type LockOptions = {
  from: string
  vantages?: string[]
  runId?: number
  only?: (key: string, pattern: string) => boolean
  force?: boolean
  reason?: string
  dryRun?: boolean
}

/**
 * Writes what a target does today into the lock: the record its probe returned, and the primary
 * metric's distribution from each vantage. A locked case keeps its lock unless `force` is set,
 * and forcing takes a reason.
 */
export async function lock(project: Project, opts: LockOptions): Promise<Change[]> {
  if (opts.force && !opts.reason) throw new Error("Re-locking a locked case needs --reason")
  const probes = await probeInfo(project)
  const run = opts.runId !== undefined ? project.store.run(opts.runId) : undefined
  if (opts.runId !== undefined && !run) throw new Error(`No run ${opts.runId}`)
  const vantages = run ? [run.vantage] : vantagesOf(project, opts.vantages)
  const byVantage = new Map(
    vantages.map((v) => [
      v,
      run ? project.store.observationsOf(run.id) : project.store.latestFor(opts.from, v),
    ]),
  )
  const source = run ? `run ${run.id}` : opts.from
  const changes: Change[] = []

  for (const [pattern, route, caseId, def] of casesOf(project.lock)) {
    const key = caseKey(pattern, caseId)
    if (opts.only && !opts.only(key, pattern)) continue
    if (def.expect && !opts.force) {
      changes.push({ key, field: "*", skipped: "already locked (use --force --reason to re-lock)" })
      continue
    }
    const name = probeOf(project.config, def)
    const ok = [...byVantage.values()]
      .flat()
      .filter((o) => o.route === pattern && o.caseId === caseId && route.samples.includes(o.sample))
      .filter((o) => o.record && !o.error)
    const hash = ok[0]?.probeHash
    const current = probes.get(name)?.hash
    if (ok.length === 0) {
      changes.push({ key, field: "*", skipped: `no observations from ${source}` })
      continue
    }
    if (current && hash !== current) {
      changes.push({
        key,
        field: "*",
        skipped: `measured with an older ${name}; run it again first`,
      })
      continue
    }
    const record = {
      ...commonRecord(ok.filter((o) => o.probeHash === hash).map((o) => o.record!))!,
    }
    const status = typeof record["status"] === "number" ? (record["status"] as number) : undefined
    delete record["status"]
    const timing: Record<string, Summary> = {}
    for (const [v, list] of byVantage) {
      const s = summarise(
        list
          .filter(
            (o) => o.route === pattern && o.caseId === caseId && o.probeHash === hash && !o.error,
          )
          .flatMap((o) => o.primary),
      )
      if (s) timing[v] = s
    }
    const expect: Expect = {
      probe: { name, hash: hash as string },
      status,
      record,
      metric: probes.get(name)?.primary,
      timing,
      max: def.expect?.max ?? {},
      lockedFrom: source,
      lockedAt: now(),
    }
    changes.push({
      key,
      field: "*",
      from: def.expect ? brief(def.expect) : undefined,
      to: brief(expect),
      source,
    })
    if (opts.dryRun) continue
    def.history.push({
      at: expect.lockedAt as string,
      by: "lock",
      field: "*",
      from: def.expect ? brief(def.expect) : undefined,
      to: brief(expect),
      reason: opts.reason,
    })
    def.expect = expect
  }
  if (!opts.dryRun) project.saveLock()
  return changes
}

function brief(e: Expect) {
  return {
    probe: e.probe ? `${e.probe.name}@${e.probe.hash}` : undefined,
    status: e.status,
    timing: Object.fromEntries(Object.entries(e.timing).map(([v, s]) => [v, s.median])),
  }
}

const orderOf = (spec: FieldSpec | undefined) =>
  spec && typeof spec === "object" ? spec.order : undefined

/**
 * Tightens every lock a ratcheting target now beats while meeting its contract: a primary-metric
 * distribution clearly faster than the locked one from the same vantage, or a field moved up its
 * probe's `order`. Never loosens.
 */
export async function ratchet(
  project: Project,
  opts: { dryRun?: boolean } = {},
): Promise<Change[]> {
  const { config } = project
  const probes = await probeInfo(project)
  const timing = new Map<string, [Summary, string]>()
  const fields = new Map<string, [string, string | number, string]>()
  const ratcheting = Object.entries(config.targets)
    .filter(([, t]) => t.ratchet)
    .map(([n]) => n)

  for (const { target, vantage, evaluation } of await statusOf(project, { targets: ratcheting })) {
    for (const route of evaluation.routes) {
      for (const c of route.cases) {
        if (c.reference !== "lock" || c.stale) continue
        if (c.contract.state === "fail") continue
        const expect = project.lock.routes[route.route]?.cases[c.caseId]?.expect
        const actual = c.perf.actual
        const locked = expect?.timing[vantage]
        if (
          actual &&
          locked &&
          callChange(locked, actual, config.perf.threshold, config.perf.minDeltaMs) === "better"
        ) {
          const k = `${c.key} ${vantage}`
          const prev = timing.get(k)
          if (!prev || actual.median < prev[0].median) timing.set(k, [actual, target])
        }
        for (const d of c.contract.diffs) {
          if (d.improved && d.actual !== undefined)
            fields.set(`${c.key} ${d.field}`, [d.field, d.actual, target])
        }
      }
    }
  }

  const changes: Change[] = []
  for (const [pattern, route, caseId, def] of casesOf(project.lock)) {
    const key = caseKey(pattern, caseId)
    const expect = def.expect
    if (!expect) continue
    for (const [k, [summary, by]] of timing) {
      if (!k.startsWith(`${key} `)) continue
      const vantage = k.slice(key.length + 1)
      const from = expect.timing[vantage]?.median
      changes.push({ key, field: "timing", vantage, from, to: summary.median, source: by })
      if (opts.dryRun) continue
      def.history.push({
        at: now(),
        by: "ratchet",
        field: `timing/${vantage}`,
        from,
        to: summary.median,
        reason: `beaten by ${by}`,
      })
      expect.timing[vantage] = summary
    }
    const spec = (field: string) =>
      def.fields?.[field] ??
      route.fields?.[field] ??
      probes.get(probeOf(config, def))?.fields?.[field]
    for (const [k, [field, value, by]] of fields) {
      if (!k.startsWith(`${key} `) || !orderOf(spec(field))) continue
      const from = field === "status" ? expect.status : expect.record[field]
      changes.push({ key, field, from, to: value, source: by })
      if (opts.dryRun) continue
      def.history.push({
        at: now(),
        by: "ratchet",
        field,
        from,
        to: value,
        reason: `reached on ${by}`,
      })
      expect.record[field] = value
    }
  }
  if (!opts.dryRun && changes.length > 0) project.saveLock()
  return changes
}

export type LoosenOptions = {
  // A ceiling on the primary metric's median in place of the locked distribution, or `none` to
  // stop judging timing.
  max?: number | "none"
  vantage?: string
  drop?: string[]
  set?: Record<string, string>
  reason: string
}

/** The one way to lower a bar by hand. It always records why, beside the case, in the lock. */
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
  if (opts.max !== undefined) {
    const scope = opts.vantage ?? "*"
    const from =
      expect.max[scope] ?? (opts.vantage ? expect.timing[opts.vantage]?.median : undefined)
    if (opts.max === "none") {
      note(`timing/${scope}`, from, "none")
      if (opts.vantage) delete expect.timing[opts.vantage]
      else expect.timing = {}
      delete expect.max[scope]
    } else {
      note(`max/${scope}`, from, opts.max)
      if (opts.vantage) delete expect.timing[opts.vantage]
      else expect.timing = {}
      expect.max[scope] = opts.max
    }
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
  if (changes.length === 0) throw new Error("Nothing to loosen: pass --max, --drop or --set")
  project.saveLock()
  return changes
}
