import { expandHeaders, type RouteDef } from "../config.ts"
import {
  borrowSamples,
  bySpecificity,
  expandPattern,
  inferPatterns,
  isDynamic,
  matchPattern,
} from "../patterns.ts"
import type { Project } from "../project.ts"
import { nextRoutes, type FoundRoute } from "./next.ts"
import { sitemapPaths } from "./sitemap.ts"
import { readUrlList } from "./urls.ts"

export type DiscoverOptions = {
  sitemap?: boolean
  target?: string
  next?: string
  urls?: string
  reweight?: boolean
  /** Re-derive every route nobody has touched: not added by hand, nothing locked, no extra cases. */
  rebuild?: boolean
  dryRun?: boolean
}

export type DiscoverReport = {
  added: string[]
  dropped: string[]
  samplesAdded: { route: string; sample: string }[]
  casesAdded: string[]
  weighted: { route: string; weight: number }[]
  unsampled: string[]
  notSeen: string[]
  middleware: string[]
  sources: string[]
  errors: string[]
}

// Never drops a route no source lists any more: it goes in `notSeen`, because a route that
// disappears in a port is what the inventory exists to catch.
export async function discover(project: Project, opts: DiscoverOptions): Promise<DiscoverReport> {
  const { config } = project
  const lock = opts.dryRun ? structuredClone(project.lock) : project.lock
  const report: DiscoverReport = {
    added: [],
    dropped: [],
    samplesAdded: [],
    casesAdded: [],
    weighted: [],
    unsampled: [],
    notSeen: [],
    middleware: [],
    sources: [],
    errors: [],
  }

  if (opts.rebuild) {
    for (const [pattern, route] of Object.entries(lock.routes)) {
      const cases = Object.entries(route.cases)
      const touched =
        route.source === "manual" ||
        cases.some(([id, c]) => id !== "default" || c.expect || c.headers || c.query)
      if (touched) continue
      delete lock.routes[pattern]
      report.dropped.push(pattern)
    }
  }

  const found = new Map<string, FoundRoute>()
  if (opts.next) {
    const next = nextRoutes(opts.next)
    report.sources.push(...next.read.map((f) => `${opts.next}/${f}`))
    report.middleware = next.middleware
    for (const route of next.routes) {
      for (const pattern of expandPattern(route.pattern, config.discover.expand)) {
        const samples = route.samples.filter((s) => matchPattern(pattern, s) !== undefined)
        found.set(pattern, { ...route, pattern, samples })
      }
    }
  }

  const counts = new Map<string, number>()
  if (opts.sitemap) {
    const targetName = opts.target ?? config.baseline
    const target = config.targets[targetName]
    if (!target) throw new Error(`No target "${targetName}"`)
    const { headers } = expandHeaders(target.headers)
    const result = await sitemapPaths(target.url, config.discover.sitemap, headers)
    report.sources.push(...result.files.map((f) => `${targetName}:${f}`))
    report.errors.push(...result.errors)
    for (const path of result.paths) counts.set(path, counts.get(path) ?? 0)
  }
  if (opts.urls) {
    report.sources.push(opts.urls)
    for (const [path, n] of readUrlList(opts.urls)) counts.set(path, (counts.get(path) ?? 0) + n)
  }

  const known = [...new Set([...Object.keys(lock.routes), ...found.keys()])].sort(bySpecificity)
  const assigned = new Map<string, string[]>()
  const unmatched: string[] = []
  for (const path of counts.keys()) {
    const pattern = known.find((p) => matchPattern(p, path) !== undefined)
    if (pattern) assigned.set(pattern, [...(assigned.get(pattern) ?? []), path])
    else unmatched.push(path)
  }
  for (const [pattern, paths] of inferPatterns(unmatched, config.discover.minVariants)) {
    if (!found.has(pattern)) found.set(pattern, { pattern, source: "inferred", samples: [] })
    assigned.set(pattern, [...(assigned.get(pattern) ?? []), ...paths])
  }

  // Most visited first, then alphabetical, so samples are the pages readers see and stay the same
  // from one discovery to the next.
  const rank = (paths: string[]) =>
    [...new Set(paths)].sort(
      (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b),
    )

  const candidates = new Map<string, string[]>()
  for (const pattern of new Set([
    ...found.keys(),
    ...assigned.keys(),
    ...Object.keys(lock.routes),
  ])) {
    const listed = [...(found.get(pattern)?.samples ?? []), ...rank(assigned.get(pattern) ?? [])]
    candidates.set(pattern, listed.length > 0 || isDynamic(pattern) ? listed : [pattern])
  }
  const sampled = new Map([...candidates].filter(([, s]) => s.length > 0))
  for (const [pattern, samples] of candidates) {
    if (samples.length === 0) candidates.set(pattern, borrowSamples(pattern, sampled))
  }

  const seen = new Set([...found.keys(), ...assigned.keys()])
  const max = config.discover.samplesPerRoute
  for (const pattern of [...seen].sort(bySpecificity)) {
    const source = found.get(pattern)
    let route = lock.routes[pattern] as RouteDef | undefined
    if (!route) {
      route = {
        samples: [],
        cases: { default: { history: [] } },
        source: source?.source ?? "sitemap",
      }
      lock.routes[pattern] = route
      report.added.push(pattern)
    }
    if (source?.declared) route.declared = source.declared
    for (const sample of candidates.get(pattern) ?? []) {
      if (route.samples.length >= max) break
      if (route.samples.includes(sample)) continue
      route.samples.push(sample)
      report.samplesAdded.push({ route: pattern, sample })
    }
    for (const [id, c] of Object.entries(source?.cases ?? {})) {
      if (route.cases[id]) continue
      route.cases[id] = { ...c, history: [] }
      report.casesAdded.push(`${pattern}#${id}`)
    }
    const visits = (assigned.get(pattern) ?? []).reduce((sum, p) => sum + (counts.get(p) ?? 0), 0)
    if (opts.urls && visits > 0 && (route.weight === undefined || opts.reweight)) {
      route.weight = visits
      report.weighted.push({ route: pattern, weight: visits })
    }
    if (route.samples.length === 0) report.unsampled.push(pattern)
  }
  report.notSeen = Object.entries(lock.routes)
    .filter(([p, r]) => !seen.has(p) && r.source !== "manual")
    .map(([p]) => p)
    .sort()

  const back = new Set(report.added.filter((p) => report.dropped.includes(p)))
  report.added = report.added.filter((p) => !back.has(p))
  report.dropped = report.dropped.filter((p) => !back.has(p))

  if (!opts.dryRun) project.saveLock()
  return report
}
