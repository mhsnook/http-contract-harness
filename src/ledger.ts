import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { LEDGER_FILE, caseKey, judgedByLock, referenceOf, writeSorted } from "./config.ts"
import type { Observation } from "./db.ts"
import { casesOf, probeOf, type Project } from "./project.ts"
import { reasonOf } from "./report.ts"
import { runBatch } from "./run.ts"
import { callChange, summarise, type PerfCall, type Summary } from "./stats.ts"
import { probeInfo } from "./status.ts"
import { evaluate } from "./verdict.ts"

export type Measurement = {
  phase: "before" | "after"
  batches: Record<string, number>
  at: string
  gitSha: string | null
  probes: Record<string, string>
  note?: string
}

export type CaseResult = {
  key: string
  vantage: string
  probe: string
  metric: string
  before: { target?: Summary; reference?: Summary }
  after: { target?: Summary; reference?: Summary }
  driftMs?: number
  deltaMs?: number
  change: PerfCall | "unmeasured" | "incomparable"
  fields?: { field: string; before?: string | number; after?: string | number }[]
  broken?: string
}

export type Experiment = {
  id: string
  theory: string
  routes: string[]
  target: string
  reference: string
  vantages: string[]
  createdAt: string
  measurements: Measurement[]
  result?: { cases: CaseResult[]; better: number; worse: number; noise: number; broken: number }
  decision?: { verdict: "keep" | "discard"; why: string; at: string }
}

// Something learned about the site or its stack that the next agent should not have to find out
// again: how its cache keys work, which header says where it answered, why a probe counts what it
// counts.
export type Finding = {
  id: string
  at: string
  text: string
  routes: string[]
  tags: string[]
  experiment?: string
}

export type Ledger = { version: 2; experiments: Experiment[]; findings: Finding[] }

export function readLedger(root: string): Ledger {
  const file = join(root, LEDGER_FILE)
  if (!existsSync(file)) return { version: 2, experiments: [], findings: [] }
  const ledger = JSON.parse(readFileSync(file, "utf8")) as Ledger
  return { version: 2, experiments: ledger.experiments ?? [], findings: ledger.findings ?? [] }
}

const save = (root: string, ledger: Ledger) => writeSorted(join(root, LEDGER_FILE), ledger)

export const overlaps = (a: string[], b: string[]) =>
  a.length === 0 ||
  b.length === 0 ||
  a.some((x) => b.some((y) => x === y || x.startsWith(y) || y.startsWith(x)))

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)

function uniqueId(taken: string[], text: string) {
  const base = `${new Date().toISOString().slice(0, 10)}-${slug(text)}`
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`
  return id
}

function referenceFor(project: Project, target: string, against?: string): string {
  if (against) {
    if (!project.config.targets[against]) throw new Error(`No target "${against}"`)
    return against
  }
  const own = referenceOf(project.config, target)
  if (own !== target) return own
  const other = Object.keys(project.config.targets).find((t) => t !== target)
  if (!other) throw new Error("An experiment needs a second target to measure drift against")
  return other
}

const matches = (routes: string[]) => (p: string) => routes.some((r) => p === r || p.startsWith(r))

async function measure(
  project: Project,
  e: Pick<Experiment, "id" | "target" | "reference" | "routes" | "vantages">,
  repeats?: number,
) {
  const result = await runBatch(project, {
    targets: [...new Set([e.target, e.reference])],
    vantages: e.vantages,
    label: `exp:${e.id}`,
    routes: matches(e.routes),
    repeats,
  })
  const probes = await probeInfo(project)
  return {
    batches: Object.fromEntries(result.batches.map((b) => [b.vantage, b.batch])),
    gitSha: project.store.run(result.batches[0]!.batch)?.gitSha ?? null,
    probes: Object.fromEntries([...probes].map(([n, p]) => [n, p.hash])),
  }
}

export type StartOptions = {
  theory: string
  routes: string[]
  target: string
  against?: string
  vantages?: string[]
  id?: string
  repeats?: number
  note?: string
}

/** Lists what was tried and learned on these routes, then measures the before batches. */
export async function startExperiment(project: Project, opts: StartOptions) {
  if (!opts.theory.trim()) throw new Error("An experiment needs a theory")
  if (opts.routes.length === 0) throw new Error("An experiment needs at least one --route")
  if (!project.config.targets[opts.target]) throw new Error(`No target "${opts.target}"`)
  const known = Object.keys(project.lock.routes)
  for (const r of opts.routes) {
    if (!known.some(matches([r]))) throw new Error(`No route in the lock matches ${r}`)
  }
  const ledger = readLedger(project.root)
  const id =
    opts.id ??
    uniqueId(
      ledger.experiments.map((e) => e.id),
      opts.theory,
    )
  if (ledger.experiments.some((e) => e.id === id))
    throw new Error(`An experiment ${id} already exists`)
  const vantages = opts.vantages?.length ? opts.vantages : Object.keys(project.config.vantages)
  const reference = referenceFor(project, opts.target, opts.against)
  const related = {
    experiments: ledger.experiments.filter((e) => overlaps(e.routes, opts.routes)),
    findings: ledger.findings.filter((f) => overlaps(f.routes, opts.routes)),
  }
  const base = { id, target: opts.target, reference, routes: opts.routes, vantages }
  const m = await measure(project, base, opts.repeats)
  const experiment: Experiment = {
    ...base,
    theory: opts.theory,
    createdAt: new Date().toISOString(),
    measurements: [{ phase: "before", at: new Date().toISOString(), note: opts.note, ...m }],
  }
  const fresh = readLedger(project.root)
  fresh.experiments.push(experiment)
  save(project.root, fresh)
  return { experiment, related }
}

function find(ledger: Ledger, id: string): Experiment {
  const found = ledger.experiments.find((e) => e.id === id)
  if (!found) throw new Error(`No experiment ${id}. \`hch experiment list\` shows them.`)
  return found
}

export async function measureExperiment(
  project: Project,
  id: string,
  opts: { note?: string; repeats?: number } = {},
) {
  const experiment = find(readLedger(project.root), id)
  if (experiment.decision)
    throw new Error(`${id} was decided (${experiment.decision.verdict}); start a new one`)
  const before = experiment.measurements.find((m) => m.phase === "before")!
  const m = await measure(project, experiment, opts.repeats)
  const warnings: string[] = []
  if (before.gitSha && m.gitSha === before.gitSha) {
    warnings.push(
      `git HEAD is still ${m.gitSha}, as for the before batch. If the change was deployed from elsewhere, ignore this.`,
    )
  }
  for (const [name, hash] of Object.entries(m.probes)) {
    if (before.probes[name] && before.probes[name] !== hash) {
      warnings.push(
        `probe ${name} changed since the before batch, so its cases cannot be compared; start a new experiment`,
      )
    }
  }
  const ledger = readLedger(project.root)
  const stored = find(ledger, id)
  stored.measurements.push({ phase: "after", at: new Date().toISOString(), note: opts.note, ...m })
  stored.result = await compute(project, stored)
  save(project.root, ledger)
  return { experiment: stored, warnings }
}

const shift = (s: Summary, by: number): Summary => ({
  n: s.n,
  min: s.min - by,
  p25: s.p25 - by,
  median: s.median - by,
  p75: s.p75 - by,
  max: s.max - by,
})

// The reference target is untouched by the experiment, so whatever its median did between the two
// batches is drift, and the target's own change is corrected by it before it is called.
export async function compute(
  project: Project,
  e: Experiment,
): Promise<NonNullable<Experiment["result"]>> {
  const before = e.measurements.find((m) => m.phase === "before")
  const after = e.measurements.filter((m) => m.phase === "after").at(-1)
  if (!before || !after) throw new Error(`${e.id} has no before and after batches yet`)
  const probes = await probeInfo(project)
  const { threshold, minDeltaMs } = project.config.perf
  const cases: CaseResult[] = []
  let broken = 0

  for (const vantage of e.vantages) {
    const b = before.batches[vantage]
    const a = after.batches[vantage]
    if (b === undefined || a === undefined) continue
    const all = project.store.inBatches([b, a])
    const pick = (batch: number, target: string, key: string): Observation[] =>
      all.filter(
        (o) => o.batch === batch && o.target === target && caseKey(o.route, o.caseId) === key,
      )
    const afterTarget = all.filter((o) => o.batch === a && o.target === e.target)
    const afterReference = all.filter((o) => o.batch === a && o.target === e.reference)
    const verdicts = evaluate({
      config: project.config,
      lock: project.lock,
      target: e.target,
      vantage,
      observations: afterTarget,
      probes,
      baseline: e.reference,
      useLock: judgedByLock(project.config, e.target),
      reference: afterReference,
      peers: [...afterTarget, ...afterReference],
    })
    const byKey = new Map(verdicts.routes.flatMap((r) => r.cases).map((c) => [c.key, c]))

    for (const [pattern, , caseId, def] of casesOf(project.lock)) {
      if (!matches(e.routes)(pattern)) continue
      const key = caseKey(pattern, caseId)
      const probe = probeOf(project.config, def)
      const sum = (list: Observation[]) => summarise(list.flatMap((o) => o.primary))
      const bt = pick(b, e.target, key)
      const at = pick(a, e.target, key)
      const verdict = byKey.get(key)
      const result: CaseResult = {
        key,
        vantage,
        probe,
        metric: probes.get(probe)?.primary ?? "primary",
        before: { target: sum(bt), reference: sum(pick(b, e.reference, key)) },
        after: { target: sum(at), reference: sum(pick(a, e.reference, key)) },
        change: "unmeasured",
        broken: verdict?.contract.state === "fail" ? reasonOf(verdict) : undefined,
      }
      if (result.broken) broken++
      const changedFields = new Set([
        ...Object.keys(bt[0]?.record ?? {}),
        ...Object.keys(at[0]?.record ?? {}),
      ])
      result.fields = [...changedFields]
        .filter((f) => bt[0]?.record?.[f] !== at[0]?.record?.[f])
        .map((f) => ({ field: f, before: bt[0]?.record?.[f], after: at[0]?.record?.[f] }))
      if (bt[0] && at[0] && bt[0].probeHash !== at[0].probeHash) result.change = "incomparable"
      else if (result.before.target && result.after.target) {
        const drift =
          result.before.reference && result.after.reference
            ? result.after.reference.median - result.before.reference.median
            : 0
        const corrected = shift(result.after.target, drift)
        result.driftMs = Math.round(drift * 10) / 10
        result.deltaMs = Math.round((corrected.median - result.before.target.median) * 10) / 10
        result.change = callChange(result.before.target, corrected, threshold, minDeltaMs)
      }
      cases.push(result)
    }
  }
  const count = (c: CaseResult["change"]) => cases.filter((x) => x.change === c).length
  return { cases, better: count("better"), worse: count("worse"), noise: count("noise"), broken }
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

export function addFinding(
  project: Project,
  f: { text: string; routes?: string[]; tags?: string[]; experiment?: string },
): Finding {
  if (!f.text.trim()) throw new Error("A finding needs its text")
  const ledger = readLedger(project.root)
  const finding: Finding = {
    id: uniqueId(
      ledger.findings.map((x) => x.id),
      f.text,
    ),
    at: new Date().toISOString(),
    text: f.text,
    routes: f.routes ?? [],
    tags: f.tags ?? [],
    experiment: f.experiment,
  }
  ledger.findings.push(finding)
  save(project.root, ledger)
  return finding
}

export function listFindings(project: Project, opts: { routes?: string[]; tag?: string } = {}) {
  return readLedger(project.root).findings.filter(
    (f) =>
      (!opts.routes?.length || overlaps(f.routes, opts.routes)) &&
      (!opts.tag || f.tags.includes(opts.tag)),
  )
}
