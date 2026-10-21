import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { CacheClass } from "./cache.ts"
import { caseKey, writeSorted } from "./config.ts"
import type { Observation } from "./db.ts"
import { casesOf, type Project } from "./project.ts"
import { reasonOf } from "./report.ts"
import { runBatch } from "./run.ts"
import { callChange, summarise, type PerfCall, type Summary } from "./stats.ts"
import { evaluate, warmTimings } from "./verdict.ts"

export const EXPERIMENTS_FILE = "portside.experiments.json"

export type Measurement = {
  phase: "before" | "after"
  batch: number
  at: string
  gitSha: string | null
  note?: string
}

export type CaseResult = {
  key: string
  direction: string
  before: { target?: Summary; reference?: Summary }
  after: { target?: Summary; reference?: Summary }
  driftMs?: number
  deltaMs?: number
  change: PerfCall | "unmeasured"
  cache?: { before: CacheClass; after: CacheClass }
  broken?: string
}

export type Experiment = {
  id: string
  theory: string
  routes: string[]
  target: string
  reference: string
  createdAt: string
  measurements: Measurement[]
  result?: {
    cases: CaseResult[]
    better: number
    worse: number
    noise: number
    broken: number
  }
  decision?: { verdict: "keep" | "discard"; why: string; at: string }
}

type Ledger = { version: 1; experiments: Experiment[] }

export function readLedger(root: string): Ledger {
  const file = join(root, EXPERIMENTS_FILE)
  if (!existsSync(file)) return { version: 1, experiments: [] }
  return JSON.parse(readFileSync(file, "utf8")) as Ledger
}

const save = (root: string, ledger: Ledger) => writeSorted(join(root, EXPERIMENTS_FILE), ledger)

const overlaps = (a: string[], b: string[]) =>
  a.some((x) => b.some((y) => x === y || x.startsWith(y) || y.startsWith(x)))

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)

function referenceFor(project: Project, target: string, against?: string): string {
  if (against) {
    if (!project.config.targets[against]) throw new Error(`No target "${against}"`)
    return against
  }
  if (target !== project.config.baseline) return project.config.baseline
  const other = Object.keys(project.config.targets).find((t) => t !== target)
  if (!other) throw new Error("An experiment needs a second target to measure drift against")
  return other
}

export type StartOptions = {
  theory: string
  routes: string[]
  target: string
  against?: string
  id?: string
  repeats?: number
  note?: string
}

/**
 * Lists the experiments already tried on these routes, then measures the before batch. Read
 * `related` before changing anything: it is the record of what was tried and why it was kept or
 * thrown away.
 */
export async function startExperiment(project: Project, opts: StartOptions) {
  if (!opts.theory.trim()) throw new Error("An experiment needs a theory")
  if (opts.routes.length === 0) throw new Error("An experiment needs at least one --route")
  if (!project.config.targets[opts.target]) throw new Error(`No target "${opts.target}"`)
  const known = Object.keys(project.lock.routes)
  for (const r of opts.routes) {
    if (!known.some((p) => p === r || p.startsWith(r)))
      throw new Error(`No route in the lock matches ${r}`)
  }
  const ledger = readLedger(project.root)
  const date = new Date().toISOString().slice(0, 10)
  let id = opts.id ?? `${date}-${slug(opts.theory)}`
  if (!opts.id)
    for (let n = 2; ledger.experiments.some((e) => e.id === id); n++)
      id = `${date}-${slug(opts.theory)}-${n}`
  if (ledger.experiments.some((e) => e.id === id))
    throw new Error(`An experiment ${id} already exists`)

  const related = ledger.experiments.filter((e) => overlaps(e.routes, opts.routes))
  const reference = referenceFor(project, opts.target, opts.against)
  const result = await measure(project, id, [opts.target, reference], opts.routes, opts.repeats)
  const experiment: Experiment = {
    id,
    theory: opts.theory,
    routes: opts.routes,
    target: opts.target,
    reference,
    createdAt: new Date().toISOString(),
    measurements: [
      {
        phase: "before",
        batch: result.batch,
        at: new Date().toISOString(),
        gitSha: result.gitSha,
        note: opts.note,
      },
    ],
  }
  ledger.experiments.push(experiment)
  save(project.root, ledger)
  return { experiment, related }
}

async function measure(
  project: Project,
  id: string,
  targets: string[],
  routes: string[],
  repeats?: number,
) {
  const result = await runBatch(project, {
    targets: [...new Set(targets)],
    label: `exp:${id}`,
    routes: (p) => routes.some((r) => p === r || p.startsWith(r)),
    repeats,
  })
  return { batch: result.batch, gitSha: project.store.run(result.batch)?.gitSha ?? null }
}

function find(ledger: Ledger, id: string): Experiment {
  const found = ledger.experiments.find((e) => e.id === id)
  if (!found) throw new Error(`No experiment ${id}. \`portside experiment list\` shows them.`)
  return found
}

export async function measureExperiment(
  project: Project,
  id: string,
  opts: { note?: string; repeats?: number } = {},
) {
  const ledger = readLedger(project.root)
  const experiment = find(ledger, id)
  if (experiment.decision)
    throw new Error(`${id} was decided (${experiment.decision.verdict}); start a new one`)
  const before = experiment.measurements.find((m) => m.phase === "before")
  const result = await measure(
    project,
    id,
    [experiment.target, experiment.reference],
    experiment.routes,
    opts.repeats,
  )
  const warnings: string[] = []
  if (before?.gitSha && result.gitSha === before.gitSha) {
    warnings.push(
      `git HEAD is still ${result.gitSha}, as it was for the before batch. If the change was deployed from elsewhere, ignore this.`,
    )
  }
  experiment.measurements.push({
    phase: "after",
    batch: result.batch,
    at: new Date().toISOString(),
    gitSha: result.gitSha,
    note: opts.note,
  })
  experiment.result = compute(project, experiment)
  save(project.root, ledger)
  return { experiment, warnings }
}

const shift = (s: Summary, by: number): Summary => ({
  n: s.n,
  min: s.min - by,
  p25: s.p25 - by,
  median: s.median - by,
  p75: s.p75 - by,
  max: s.max - by,
})

function majorityCache(list: Observation[]): CacheClass {
  const known = list.map((o) => o.cache).filter((c) => c !== "unknown")
  if (known.length === 0) return "unknown"
  return known.filter((c) => c === "cached").length * 2 >= known.length ? "cached" : "uncached"
}

/**
 * The reference target is untouched by the experiment, so whatever its median did between the two
 * batches is drift, and the target's own change is corrected by it before it is called.
 */
export function compute(
  project: Project,
  experiment: Experiment,
): NonNullable<Experiment["result"]> {
  const before = experiment.measurements.find((m) => m.phase === "before")
  const after = experiment.measurements.filter((m) => m.phase === "after").at(-1)
  if (!before || !after) throw new Error(`${experiment.id} has no before and after batches yet`)
  const all = project.store.inBatches([before.batch, after.batch])
  const pick = (batch: number, target: string, key: string) =>
    all.filter(
      (o) => o.batch === batch && o.target === target && caseKey(o.route, o.caseId) === key,
    )

  const afterTarget = all.filter((o) => o.batch === after.batch && o.target === experiment.target)
  const afterReference = all.filter(
    (o) => o.batch === after.batch && o.target === experiment.reference,
  )
  const verdicts = evaluate({
    config: project.config,
    lock: project.lock,
    target: experiment.target,
    observations: afterTarget,
    reference: afterReference,
    peers: [...afterTarget, ...afterReference],
  })
  const contract = new Map(verdicts.routes.flatMap((r) => r.cases).map((c) => [c.key, c]))

  const { threshold, minDeltaMs } = project.config.perf
  const cases: CaseResult[] = []
  for (const [pattern, , caseId, def] of casesOf(project.lock)) {
    if (!experiment.routes.some((r) => pattern === r || pattern.startsWith(r))) continue
    const key = caseKey(pattern, caseId)
    const sum = (list: Observation[]) => summarise(list.flatMap(warmTimings))
    const b = {
      target: sum(pick(before.batch, experiment.target, key)),
      reference: sum(pick(before.batch, experiment.reference, key)),
    }
    const a = {
      target: sum(pick(after.batch, experiment.target, key)),
      reference: sum(pick(after.batch, experiment.reference, key)),
    }
    const verdict = contract.get(key)
    const broken = verdict && verdict.contract.state === "fail" ? reasonOf(verdict) : undefined
    const result: CaseResult = {
      key,
      direction: def.direction ?? "hit",
      before: b,
      after: a,
      change: "unmeasured",
      broken,
      cache: {
        before: majorityCache(pick(before.batch, experiment.target, key)),
        after: majorityCache(pick(after.batch, experiment.target, key)),
      },
    }
    if (b.target && a.target) {
      const drift = b.reference && a.reference ? a.reference.median - b.reference.median : 0
      const corrected = shift(a.target, drift)
      result.driftMs = Math.round(drift * 10) / 10
      result.deltaMs = Math.round((corrected.median - b.target.median) * 10) / 10
      result.change = callChange(b.target, corrected, threshold, minDeltaMs)
    }
    cases.push(result)
  }
  const count = (c: CaseResult["change"]) => cases.filter((x) => x.change === c).length
  return {
    cases,
    better: count("better"),
    worse: count("worse"),
    noise: count("noise"),
    broken: cases.filter((c) => c.broken).length,
  }
}

export function decideExperiment(
  project: Project,
  id: string,
  verdict: "keep" | "discard",
  why: string,
) {
  if (!why.trim()) throw new Error("A decision needs --why, so the next person or agent knows")
  const ledger = readLedger(project.root)
  const experiment = find(ledger, id)
  if (verdict === "keep" && experiment.result?.broken) {
    throw new Error(
      `${id} broke the contract on ${experiment.result.broken} cases; fix them, measure again, then keep it`,
    )
  }
  experiment.decision = { verdict, why, at: new Date().toISOString() }
  save(project.root, ledger)
  return experiment
}

export function listExperiments(
  project: Project,
  opts: { routes?: string[]; open?: boolean } = {},
) {
  return readLedger(project.root).experiments.filter(
    (e) => (!opts.routes?.length || overlaps(e.routes, opts.routes)) && (!opts.open || !e.decision),
  )
}

export function getExperiment(project: Project, id: string) {
  return find(readLedger(project.root), id)
}
