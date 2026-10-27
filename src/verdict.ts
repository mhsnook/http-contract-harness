import {
  caseKey,
  type Allowance,
  type Config,
  type Expect,
  type FieldPolicy,
  type FieldSpec,
  type Lock,
  referenceOf,
} from "./config.ts"
import type { Observation } from "./db.ts"
import { casesOf, probeOf, weightOf } from "./project.ts"
import { commonRecord, type ResponseRecord } from "./record.ts"
import { callChange, summarise, type PerfCall, type Summary } from "./stats.ts"

export type State = "pass" | "warn" | "fail" | "unknown"

export type FieldDiff = {
  sample: string
  field: string
  expected?: string | number
  actual?: string | number
  policy?: FieldPolicy
  allowed?: string
  improved?: boolean
}

export type CaseVerdict = {
  key: string
  route: string
  caseId: string
  probe: string
  vantage: string
  reference: "lock" | "baseline" | "self" | "none"
  // Set when the lock was taken with a different version of the probe than the one that measured.
  stale?: string
  state: State
  observed: boolean
  contract: { state: State; diffs: FieldDiff[]; note?: string }
  perf: {
    state: State
    metric: string
    actual?: Summary
    baseline?: Summary
    against?: string
    paired?: boolean
    call?: PerfCall
    max?: number
    note?: string
  }
}

export type RouteVerdict = {
  route: string
  weight: number
  state: State
  samples: number
  declared?: { mode: string; revalidate?: number }
  cases: CaseVerdict[]
}

export type Evaluation = {
  vantage: string
  routes: RouteVerdict[]
  counts: Record<State, number>
  // Only the allowances that name this target, or no target.
  unusedAllowances: string[]
  usedAllowances: string[]
}

export type ProbeInfo = { hash: string; primary: string; fields?: Record<string, FieldSpec> }

const RANK: Record<State, number> = { unknown: 0, pass: 1, warn: 2, fail: 3 }

export function worst(states: State[]): State {
  const seen = states.filter((s) => s !== "unknown")
  if (seen.length === 0) return "unknown"
  return seen.reduce((a, b) => (RANK[b] > RANK[a] ? b : a))
}

const regexMatches = (source: string | undefined, value: string) =>
  source === undefined || new RegExp(source).test(value)

function findAllowance(
  allow: Allowance[],
  target: string,
  path: string,
  field: string,
  expected: unknown,
  actual: unknown,
): Allowance | undefined {
  return allow.find(
    (a) =>
      a.field === field &&
      (a.target === undefined || a.target === target) &&
      regexMatches(a.path, path) &&
      regexMatches(a.expected, expected === undefined ? "" : String(expected)) &&
      regexMatches(a.actual, actual === undefined ? "" : String(actual)),
  )
}

type Spec = { policy: FieldPolicy; order?: string[]; optional: boolean }
const specOf = (spec: FieldSpec | undefined): Spec =>
  spec === undefined
    ? { policy: "must-match", optional: false }
    : typeof spec === "string"
      ? { policy: spec, optional: false }
      : { policy: spec.policy, order: spec.order, optional: spec.optional }

function diffRecords(
  expected: ResponseRecord,
  actual: ResponseRecord,
  specFor: (field: string) => Spec,
  errorsMatchOnStatus: boolean,
): Omit<FieldDiff, "sample" | "allowed">[] {
  const status = expected["status"]
  // The same error on both sides is a match: how each platform labels an error page is not part of
  // what readers or crawlers depend on.
  if (
    errorsMatchOnStatus &&
    typeof status === "number" &&
    status >= 400 &&
    status === actual["status"]
  ) {
    return []
  }
  const out: Omit<FieldDiff, "sample" | "allowed">[] = []
  for (const field of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
    const [e, a] = [expected[field], actual[field]]
    if (e === a) continue
    const spec = specFor(field)
    if (spec.optional && (e === undefined || a === undefined)) continue
    const rank = (v: unknown) => (spec.order ? spec.order.indexOf(String(v)) : -1)
    const improved = spec.order !== undefined && rank(e) !== -1 && rank(a) > rank(e)
    out.push({
      field,
      expected: e,
      actual: a,
      policy: spec.policy,
      improved: improved || undefined,
    })
  }
  return out
}

type PerfInput = {
  actual: Summary | undefined
  seen: Observation[]
  peers: Observation[]
  previous: Map<number, number>
  refs: Observation[]
  locked: Expect | undefined
  vantage: string
  target: string
  baseline: string
  ratcheted: (name: string) => boolean
  call: (before: Summary, after: Summary) => PerfCall
  explicitReference: boolean
}

// A comparison with timings from another batch only ever warns: between two batches the machine
// and the network change by more than most regressions.
function judgePerf(p: PerfInput, metric: string): CaseVerdict["perf"] {
  const perf: CaseVerdict["perf"] = { state: "unknown", metric, actual: p.actual }
  if (!p.actual) return perf
  const actual = p.actual

  const batch = Math.max(...p.seen.map((o) => o.batch ?? -1))
  const timingsIn = (b: number | undefined) => {
    const byTarget = new Map<string, number[]>()
    for (const o of p.peers) {
      if (b === undefined || b < 0 || o.batch !== b || !o.target) continue
      byTarget.set(o.target, [...(byTarget.get(o.target) ?? []), ...o.primary])
    }
    return new Map(
      [...byTarget].flatMap(([name, t]) => {
        const s = summarise(t)
        return s ? [[name, s] as const] : []
      }),
    )
  }
  const paired = new Map([...timingsIn(batch)].filter(([name]) => name !== p.target))
  const earlier = timingsIn(p.previous.get(batch))
  // One batch that calls a route slower can be a slow minute on the network. Two in a row is a
  // regression.
  const slowerBefore = (peer: string) => {
    const peerBefore = earlier.get(peer)
    const selfBefore = earlier.get(p.target)
    return (
      peerBefore !== undefined &&
      selfBefore !== undefined &&
      p.call(peerBefore, selfBefore) === "worse"
    )
  }

  // A ceiling set by hand is a person deciding what is fast enough for the route, so it settles
  // the timing verdict on every target and the comparisons above it are only shown.
  const ceiling = p.explicitReference ? undefined : (p.locked?.max[p.vantage] ?? p.locked?.max["*"])
  const settle = (state: State) => {
    perf.max = ceiling
    if (ceiling === undefined) {
      perf.state = state
      return perf
    }
    const over = actual.median > ceiling
    perf.state = over ? "fail" : "pass"
    perf.note = over
      ? `median over the ${ceiling}ms ceiling`
      : `within the ${ceiling}ms ceiling set by hand`
    return perf
  }

  if (p.explicitReference) {
    const reference = summarise(p.refs.flatMap((o) => o.primary))
    if (!reference) return perf
    const sameBatch = p.refs.some((o) => o.batch === batch)
    Object.assign(perf, {
      baseline: reference,
      against: "reference",
      paired: sameBatch,
      call: p.call(reference, actual),
    })
    return settle(perf.call === "worse" ? "fail" : "pass")
  }

  if (p.target !== p.baseline) {
    const base = paired.get(p.baseline)
    if (base) {
      Object.assign(perf, {
        baseline: base,
        against: p.baseline,
        paired: true,
        call: p.call(base, actual),
      })
      if (perf.call !== "worse") return settle("pass")
      if (slowerBefore(p.baseline)) return settle("fail")
      perf.note = "slower in this batch only; run again to confirm"
      return settle("warn")
    }
  } else {
    const faster = [...paired]
      .filter(([name, s]) => p.ratcheted(name) && p.call(s, actual) === "worse")
      .sort(([, a], [, b]) => a.median - b.median)[0]
    if (faster) {
      Object.assign(perf, {
        baseline: faster[1],
        against: faster[0],
        paired: true,
        call: "worse",
        note: `${faster[0]} is faster here: carry it back?`,
      })
      return settle("warn")
    }
    if (paired.size > 0) {
      const [name, s] = [...paired][0]!
      Object.assign(perf, { baseline: s, against: name, paired: true, call: p.call(s, actual) })
      return settle("pass")
    }
  }

  const lockedTiming = p.locked?.timing[p.vantage]
  const fallback =
    lockedTiming ?? (p.locked ? undefined : summarise(p.refs.flatMap((o) => o.primary)))
  if (fallback) {
    Object.assign(perf, {
      baseline: fallback,
      against: lockedTiming ? "lock" : p.baseline,
      paired: false,
      call: p.call(fallback, actual),
    })
    if (perf.call === "worse")
      perf.note = "measured at another time; run the targets together to settle it"
    return settle(perf.call === "worse" ? "warn" : "pass")
  }
  return ceiling !== undefined ? settle("pass") : perf
}

export type EvaluateInput = {
  config: Config
  lock: Lock
  target: string
  vantage: string
  observations: Observation[]
  // The target this one is compared with; the config's baseline unless a track says otherwise.
  baseline?: string
  probes?: Map<string, ProbeInfo>
  reference?: Observation[]
  useLock?: boolean
  // Two runs named by hand, judged against each other alone rather than in batches.
  compare?: boolean
  // Every target's observations from the batches `observations` came from, the target's own
  // included, plus the batch before each (`previous` maps one to the other).
  peers?: Observation[]
  previous?: Map<number, number>
}

export function evaluate(input: EvaluateInput): Evaluation {
  const { config, lock, target, vantage, observations, reference = [], useLock = true } = input
  const { peers = [], previous = new Map(), probes = new Map() } = input
  const call = (before: Summary, after: Summary) =>
    callChange(before, after, config.perf.threshold, config.perf.minDeltaMs)
  const group = (list: Observation[]) => {
    const map = new Map<string, Observation[]>()
    for (const o of list) {
      const key = caseKey(o.route, o.caseId)
      map.set(key, [...(map.get(key) ?? []), o])
    }
    return map
  }
  const byCase = group(observations)
  const refByCase = group(reference)
  const usedAllowances = new Set<string>()

  const routes = new Map<string, RouteVerdict>()
  for (const [pattern, route, caseId, def] of casesOf(lock)) {
    const key = caseKey(pattern, caseId)
    const probeName = probeOf(config, def)
    const probe = probes.get(probeName)
    const seen = (byCase.get(key) ?? []).filter((o) => route.samples.includes(o.sample))
    const hash = seen[0]?.probeHash
    // Numbers only compare when the same definition produced them.
    const refs = (refByCase.get(key) ?? []).filter(
      (o) => route.samples.includes(o.sample) && o.probeHash === hash,
    )
    const locked = useLock ? def.expect : undefined
    const stale =
      locked?.probe && hash && locked.probe.hash !== hash
        ? `locked with ${locked.probe.name}@${locked.probe.hash}, measured with ${probeName}@${hash}`
        : undefined
    const isReference = !useLock && target === (input.baseline ?? config.baseline)
    const kind: CaseVerdict["reference"] = locked
      ? "lock"
      : isReference
        ? "self"
        : refs.length > 0
          ? "baseline"
          : "none"
    const specFor = (field: string) =>
      specOf(def.fields?.[field] ?? route.fields?.[field] ?? probe?.fields?.[field])

    const diffs: FieldDiff[] = []
    for (const o of seen) {
      if (o.error || !o.record) {
        diffs.push({
          sample: o.sample,
          field: "error",
          actual: o.error ?? "no response",
          policy: "must-match",
        })
        continue
      }
      let expected: ResponseRecord | undefined
      if (locked)
        expected = { ...locked.record, ...(locked.status ? { status: locked.status } : {}) }
      else {
        const ref = refs.find((r) => r.sample === o.sample)
        expected = ref?.record ?? commonRecord(refs.flatMap((r) => (r.record ? [r.record] : [])))
      }
      if (!expected || stale) continue
      for (const d of diffRecords(expected, o.record, specFor, config.record.errorsMatchOnStatus)) {
        const allowed = d.improved
          ? undefined
          : findAllowance(config.allow, target, o.path, d.field, d.expected, d.actual)
        if (allowed) usedAllowances.add(allowed.id)
        diffs.push({ sample: o.sample, ...d, allowed: allowed?.id })
      }
    }

    const perf = stale
      ? { state: "unknown" as State, metric: probe?.primary ?? "primary", note: stale }
      : judgePerf(
          {
            actual: summarise(seen.flatMap((o) => o.primary)),
            seen,
            peers: peers.filter(
              (o) =>
                caseKey(o.route, o.caseId) === key &&
                route.samples.includes(o.sample) &&
                o.probeHash === hash,
            ),
            previous,
            refs,
            locked,
            vantage,
            target,
            baseline: input.baseline ?? config.baseline,
            // Only a port measured against this target is a change to carry back to it.
            ratcheted: (name) =>
              (config.targets[name]?.ratchet ?? false) && referenceOf(config, name) === target,
            call,
            explicitReference: input.compare ?? false,
          },
          probe?.primary ?? "primary",
        )

    const open = diffs.filter((d) => !d.allowed && !d.improved && d.policy !== "ignore")
    const hard = open.filter((d) => d.policy !== "if-slower")
    const soft = open.filter((d) => d.policy === "if-slower")
    let contractState: State
    let note: string | undefined
    if (diffs.some((d) => d.field === "error")) contractState = "fail"
    else if (kind === "self" && seen.length > 0) contractState = "pass"
    else if (seen.length === 0 || kind === "none" || stale) contractState = "unknown"
    else if (hard.length > 0) contractState = "fail"
    else if (soft.length > 0) {
      // A field that only matters while the route is slow: a lost cache on a page that is still
      // fast enough is a note, not a failure.
      contractState = perf.state === "pass" ? "warn" : perf.state === "warn" ? "warn" : "fail"
      note = `${[...new Set(soft.map((d) => d.field))].join(", ")} changed, and the route is ${perf.state === "pass" ? "fast enough anyway" : "not shown to be fast enough"}`
    } else contractState = "pass"

    const verdict: CaseVerdict = {
      key,
      route: pattern,
      caseId,
      probe: probeName,
      vantage,
      reference: kind,
      stale,
      observed: seen.length > 0,
      state: seen.length === 0 ? "unknown" : worst([contractState, perf.state]),
      contract: { state: contractState, diffs, note },
      perf,
    }

    const entry = routes.get(pattern) ?? {
      route: pattern,
      weight: weightOf(config, route),
      state: "unknown" as State,
      samples: route.samples.length,
      declared: route.declared,
      cases: [],
    }
    entry.cases.push(verdict)
    entry.state = worst(entry.cases.map((c) => c.state))
    routes.set(pattern, entry)
  }

  const list = [...routes.values()].sort(
    (a, b) =>
      RANK[b.state] - RANK[a.state] || b.weight - a.weight || a.route.localeCompare(b.route),
  )
  const counts: Record<State, number> = { pass: 0, warn: 0, fail: 0, unknown: 0 }
  for (const r of list) counts[r.state]++
  return {
    vantage,
    routes: list,
    counts,
    unusedAllowances: config.allow
      .filter((a) => a.target === undefined || a.target === target)
      .map((a) => a.id)
      .filter((id) => !usedAllowances.has(id)),
    usedAllowances: [...usedAllowances],
  }
}
