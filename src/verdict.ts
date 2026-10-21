import type { CacheClass } from "./cache.ts"
import {
  caseKey,
  type Allowance,
  type CachePolicy,
  type Config,
  type Expect,
  type Lock,
} from "./config.ts"
import type { Observation } from "./db.ts"
import { casesOf, weightOf } from "./project.ts"
import { commonRecord, type ResponseRecord } from "./record.ts"
import { callChange, summarise, type PerfCall, type Summary } from "./stats.ts"

export type State = "pass" | "warn" | "fail" | "unknown"

export type FieldDiff = {
  sample: string
  field: string
  expected?: string | number
  actual?: string | number
  allowed?: string
}

export type CaseVerdict = {
  key: string
  route: string
  caseId: string
  reference: "lock" | "baseline" | "none"
  state: State
  observed: boolean
  contract: { state: State; diffs: FieldDiff[] }
  cache: { state: State; expected?: CacheClass; actual: CacheClass; signal?: string; note?: string }
  perf: {
    state: State
    actual?: Summary
    baseline?: Summary
    against?: string
    paired?: boolean
    call?: PerfCall
    max?: number
    metric?: string
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
  routes: RouteVerdict[]
  counts: Record<State, number>
  unusedAllowances: string[]
}

const RANK: Record<State, number> = { unknown: 0, pass: 1, warn: 2, fail: 3 }

export function worst(states: State[]): State {
  const seen = states.filter((s) => s !== "unknown")
  if (seen.length === 0) return "unknown"
  return seen.reduce((a, b) => (RANK[b] > RANK[a] ? b : a))
}

// Only a hit's first request may have filled a cache: cold, revalidating, browser and scene samples
// each stand on their own.
export const warmTimings = (o: Observation) =>
  o.direction === "hit" && o.ttfb.length > 1 ? o.ttfb.slice(1) : o.ttfb

function regexMatches(source: string | undefined, value: string): boolean {
  return source === undefined || new RegExp(source).test(value)
}

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

function diffRecords(
  expected: ResponseRecord,
  actual: ResponseRecord,
  errorsMatchOnStatus: boolean,
): { field: string; expected?: string | number; actual?: string | number }[] {
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
  const fields = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()
  return fields
    .filter((field) => expected[field] !== actual[field])
    .map((field) => ({ field, expected: expected[field], actual: actual[field] }))
}

function majorityCache(observations: Observation[]): CacheClass {
  const known = observations.map((o) => o.cache).filter((c) => c !== "unknown")
  if (known.length === 0) return "unknown"
  const cached = known.filter((c) => c === "cached").length
  return cached * 2 >= known.length ? "cached" : "uncached"
}

function applyCachePolicy(
  policy: CachePolicy,
  raw: State,
  perf: State,
): { state: State; note?: string } {
  if (raw !== "fail") return { state: raw }
  if (policy === "must-match") return { state: "fail" }
  if (policy === "ignore") return { state: "pass", note: "cache policy is ignore" }
  if (perf === "pass") {
    return { state: "warn", note: "uncached where the reference caches, but fast enough" }
  }
  if (perf === "warn") {
    return { state: "warn", note: "uncached where the reference caches, and possibly slower" }
  }
  return { state: "fail", note: "uncached where the reference caches, and slower" }
}

// What the timing samples of each direction are, for the label beside them.
export function metricOf(direction: string | undefined, scenePrimary?: string): string {
  if (direction === "load" || direction === "reload") return "lcp"
  if (direction === "navigate") return "navigation"
  if (direction === "scene") return scenePrimary ?? "durationMs"
  return "ttfb"
}

type PerfInput = {
  actual: Summary | undefined
  seen: Observation[]
  peers: Observation[]
  previous: Map<number, number>
  refs: Observation[]
  locked: Expect | undefined
  target: string
  baseline: string
  ratcheted: (name: string) => boolean
  call: (before: Summary, after: Summary) => PerfCall
  explicitReference: boolean
}

// A comparison with timings from another batch only ever warns: between two batches the machine
// and the network change by more than most regressions.
function judgePerf(p: PerfInput): CaseVerdict["perf"] {
  const perf: CaseVerdict["perf"] = { state: "unknown", actual: p.actual }
  if (!p.actual) return perf
  const actual = p.actual

  const batch = Math.max(...p.seen.map((o) => o.batch ?? -1))
  const timingsIn = (b: number | undefined) => {
    const byTarget = new Map<string, number[]>()
    for (const o of p.peers) {
      if (b === undefined || b < 0 || o.batch !== b || !o.target) continue
      byTarget.set(o.target, [...(byTarget.get(o.target) ?? []), ...warmTimings(o)])
    }
    return new Map(
      [...byTarget].flatMap(([name, t]) => {
        const s = summarise(t)
        return s ? [[name, s] as const] : []
      }),
    )
  }
  const inBatch = timingsIn(batch)
  const paired = new Map([...inBatch].filter(([name]) => name !== p.target))
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
  const settle = (state: State) => {
    const max = p.explicitReference ? undefined : p.locked?.ttfbMax
    perf.max = max
    if (max === undefined) {
      perf.state = state
      return perf
    }
    const over = actual.median > max
    perf.state = over ? "fail" : "pass"
    perf.note = over
      ? `median over the ${max}ms ceiling`
      : `within the ${max}ms ceiling set by hand`
    return perf
  }

  if (p.explicitReference) {
    const reference = summarise(p.refs.flatMap(warmTimings))
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

  const fallback = p.locked?.ttfb ?? (p.locked ? undefined : summarise(p.refs.flatMap(warmTimings)))
  if (fallback) {
    const against = p.locked?.ttfb ? "lock" : p.baseline
    Object.assign(perf, {
      baseline: fallback,
      against,
      paired: false,
      call: p.call(fallback, actual),
    })
    if (perf.call === "worse")
      perf.note = "measured at another time; run the targets together to settle it"
    return settle(perf.call === "worse" ? "warn" : "pass")
  }
  return p.locked?.ttfbMax !== undefined ? settle("pass") : perf
}

export type EvaluateInput = {
  config: Config
  lock: Lock
  target: string
  observations: Observation[]
  reference?: Observation[]
  useLock?: boolean
  // Every target's observations from the batches `observations` came from, the target's own
  // included, plus the batch before each (`previous` maps one to the other).
  peers?: Observation[]
  previous?: Map<number, number>
}

export function evaluate(input: EvaluateInput): Evaluation {
  const {
    config,
    lock,
    target,
    observations,
    reference = [],
    useLock = true,
    peers = [],
    previous = new Map(),
  } = input
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
    const seen = (byCase.get(key) ?? []).filter((o) => route.samples.includes(o.sample))
    const refs = (refByCase.get(key) ?? []).filter((o) => route.samples.includes(o.sample))
    const locked = useLock ? def.expect : undefined
    const kind: CaseVerdict["reference"] = locked ? "lock" : refs.length > 0 ? "baseline" : "none"

    const diffs: FieldDiff[] = []
    for (const o of seen) {
      if (o.error || !o.record) {
        diffs.push({ sample: o.sample, field: "error", actual: o.error ?? "no response" })
        continue
      }
      let expected: ResponseRecord | undefined
      if (locked)
        expected = { ...locked.record, ...(locked.status ? { status: locked.status } : {}) }
      else {
        const ref = refs.find((r) => r.sample === o.sample) ?? undefined
        expected = ref?.record ?? commonRecord(refs.flatMap((r) => (r.record ? [r.record] : [])))
      }
      if (!expected) continue
      for (const d of diffRecords(expected, o.record, config.probe.errorsMatchOnStatus)) {
        const allowed = findAllowance(config.allow, target, o.path, d.field, d.expected, d.actual)
        if (allowed) usedAllowances.add(allowed.id)
        diffs.push({ sample: o.sample, ...d, allowed: allowed?.id })
      }
    }
    const contractState: State =
      seen.length === 0 || kind === "none"
        ? diffs.some((d) => d.field === "error")
          ? "fail"
          : "unknown"
        : diffs.some((d) => !d.allowed)
          ? "fail"
          : "pass"

    const actualPerf = summarise(seen.flatMap(warmTimings))
    const perf = judgePerf({
      actual: actualPerf,
      seen,
      peers: peers.filter(
        (o) => caseKey(o.route, o.caseId) === key && route.samples.includes(o.sample),
      ),
      previous,
      refs,
      locked,
      target,
      baseline: config.baseline,
      ratcheted: (name) => config.targets[name]?.ratchet ?? false,
      call,
      explicitReference: !useLock,
    })
    perf.metric = metricOf(def.direction, def.scene ? config.scenes[def.scene]?.primary : undefined)

    const actualCache = majorityCache(seen)
    const expectedCache: CacheClass | undefined = locked
      ? locked.cache
      : refs.length > 0
        ? majorityCache(refs)
        : undefined
    let rawCache: State = "unknown"
    if (expectedCache && expectedCache !== "unknown" && actualCache !== "unknown") {
      rawCache = expectedCache === "cached" && actualCache === "uncached" ? "fail" : "pass"
    }
    const policy = route.cachePolicy ?? config.defaults.cachePolicy
    const cacheResult = applyCachePolicy(policy, rawCache, perf.state)
    const signal = seen.find((o) => o.cache === actualCache)?.cacheSignal

    const verdict: CaseVerdict = {
      key,
      route: pattern,
      caseId,
      reference: kind,
      observed: seen.length > 0,
      state: "unknown",
      contract: { state: contractState, diffs },
      cache: {
        state: cacheResult.state,
        expected: expectedCache,
        actual: actualCache,
        signal,
        note: cacheResult.note,
      },
      perf,
    }
    verdict.state =
      seen.length === 0 ? "unknown" : worst([contractState, cacheResult.state, perf.state])

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
    routes: list,
    counts,
    unusedAllowances: config.allow.map((a) => a.id).filter((id) => !usedAllowances.has(id)),
  }
}
