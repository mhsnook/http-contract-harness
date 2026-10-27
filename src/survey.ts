import { exec as execCallback } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import type { TrafficRow } from "./db.ts"
import { bySpecificity, matchPattern } from "./patterns.ts"
import type { Project } from "./project.ts"

const execAsync = promisify(execCallback)

export type SourceRow = {
  path: string
  views?: number
  entries?: number
  country?: string
  region?: string
}

export type SourceContext = {
  since: string
  options: Record<string, unknown>
  env: NodeJS.ProcessEnv
  exec(command: string): Promise<{ stdout: string; stderr: string }>
  readFile(path: string): string
  log(message: string): void
}

export type Source = { describe: string; rows(ctx: SourceContext): Promise<SourceRow[]> }

// ISO 3166 alpha-2 to a coarse region. A country cannot say which side of North America a reader
// is on, so a source that knows better should report `region` itself.
const REGION_OF: Record<string, string> = {}
const add = (region: string, codes: string) => {
  for (const c of codes.split(" ")) REGION_OF[c] = region
}
add("nam", "US CA MX GT BZ SV HN NI CR PA CU JM HT DO PR BS BB TT AG DM GD KN LC VC BM")
add("sam", "BR AR CL CO PE VE EC BO PY UY GY SR GF")
add(
  "weur",
  "GB IE FR DE NL BE LU CH AT ES PT IT MT MC AD SM VA LI IS NO SE DK FI FO GL GI IM JE GG",
)
add("eeur", "PL CZ SK HU RO BG GR CY SI HR BA RS ME MK AL XK MD UA BY LT LV EE RU GE AM AZ TR")
add("me", "IL PS JO LB SY IQ IR SA AE QA BH KW OM YE")
add(
  "afr",
  "EG LY TN DZ MA SD SS ET ER DJ SO KE UG TZ RW BI CD CG GA CM NG GH CI SN ML BF NE TD CF ZA NA BW ZW ZM MW MZ AO MG MU SC LR SL GN GW GM CV TG BJ MR LS SZ",
)
add(
  "apac",
  "IN PK BD LK NP BT MV CN HK MO TW JP KR KP MN SG MY ID TH VN PH KH LA MM BN TL KZ UZ TM KG TJ AF",
)
add("oc", "AU NZ FJ PG SB VU NC PF WS TO KI FM MH PW NR TV")

export const regionOf = (country?: string | null) =>
  country ? (REGION_OF[country.toUpperCase()] ?? "other") : undefined

export async function loadSources(dir: string): Promise<Map<string, Source>> {
  const out = new Map<string, Source>()
  const root = resolve(dir)
  if (!existsSync(root)) return out
  for (const entry of readdirSync(root).sort()) {
    const m = /^([^_].*)\.(mjs|js)$/.exec(entry)
    if (!m) continue
    const mod = await import(`${pathToFileURL(join(root, entry)).href}?t=${Date.now()}`)
    const source = (mod.default ?? mod) as Source
    if (typeof source.rows !== "function") throw new Error(`${entry}: a source exports rows(ctx)`)
    out.set(m[1] as string, source)
  }
  return out
}

/** Columns by name, so exports from Plausible, GA or a spreadsheet work without mapping. */
export function rowsFromCsv(text: string): SourceRow[] {
  const split = (line: string) => {
    const out: string[] = []
    let cell = ""
    let quoted = false
    for (const ch of line) {
      if (ch === '"') quoted = !quoted
      else if (ch === "," && !quoted) {
        out.push(cell.trim())
        cell = ""
      } else cell += ch
    }
    out.push(cell.trim())
    return out
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"))
  const header = split(lines[0] ?? "").map((h) => h.toLowerCase().replace(/[^a-z_]/g, ""))
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h))
  const path = col(
    "path",
    "page",
    "pathname",
    "url",
    "name",
    "page_path",
    "landing_page",
    "entry_page",
  )
  const views = col("views", "pageviews", "page_views", "visitors", "hits", "count")
  const entries = col("entries", "entrances", "visits", "sessions", "landings")
  const country = col("country", "country_code", "countrycode")
  if (path === -1) throw new Error("The CSV needs a path column (path, page, url, …)")
  const num = (v: string | undefined) => Number((v ?? "").replace(/,/g, "")) || 0
  return lines.slice(1).map((line) => {
    const cells = split(line)
    let p = cells[path] ?? ""
    try {
      if (!p.startsWith("/")) p = new URL(p).pathname
    } catch {}
    return {
      path: p,
      views: views === -1 ? undefined : num(cells[views]),
      entries: entries === -1 ? undefined : num(cells[entries]),
      country: country === -1 ? undefined : cells[country],
    }
  })
}

export type SurveyReport = {
  sources: { name: string; rows: number; error?: string }[]
  totals: { views: number; entries: number }
  routes: { route: string; views: number; entries: number; share: number; entryShare: number }[]
  uncovered: { path: string; views: number; entries: number }[]
  regions: Record<string, number>
}

export async function survey(
  project: Project,
  opts: { only?: string[]; csv?: string[]; since?: string; dryRun?: boolean } = {},
): Promise<SurveyReport> {
  const { config, store } = project
  const report: SurveyReport = {
    sources: [],
    totals: { views: 0, entries: 0 },
    routes: [],
    uncovered: [],
    regions: {},
  }
  const collected: TrafficRow[] = []
  const take = (name: string, rows: SourceRow[]) => {
    for (const r of rows) {
      if (!r.path) continue
      collected.push({
        source: name,
        path: r.path.split("#")[0] as string,
        views: r.views ?? 0,
        entries: r.entries ?? 0,
        country: r.country ?? null,
        region: r.region ?? regionOf(r.country) ?? null,
      })
    }
    report.sources.push({ name, rows: rows.length })
  }

  for (const file of opts.csv ?? []) take(`csv:${file}`, rowsFromCsv(readFileSync(file, "utf8")))
  const sources = await loadSources(join(project.root, config.sources))
  for (const [name, source] of sources) {
    if (opts.only?.length && !opts.only.includes(name)) continue
    const ctx: SourceContext = {
      since: opts.since ?? config.survey.since,
      options: config.survey.sources[name] ?? {},
      env: process.env,
      exec: (command) => execAsync(command, { cwd: project.root, maxBuffer: 64 * 1024 * 1024 }),
      readFile: (p) => readFileSync(resolve(project.root, p), "utf8"),
      log: (m) => console.error(`[source ${name}] ${m}`),
    }
    try {
      take(name, await source.rows(ctx))
    } catch (error) {
      report.sources.push({ name, rows: 0, error: (error as Error).message })
    }
  }
  if (!opts.dryRun && collected.length) store.importTraffic(collected)
  const rows = opts.dryRun ? collected : store.traffic()
  return summariseTraffic(project, rows, report, opts.dryRun)
}

export function summariseTraffic(
  project: Project,
  rows: TrafficRow[],
  report: SurveyReport,
  dryRun = false,
): SurveyReport {
  const { config, lock } = project
  const patterns = Object.keys(lock.routes).sort(bySpecificity)
  const byRoute = new Map<string, { views: number; entries: number }>()
  const uncovered = new Map<string, { views: number; entries: number }>()
  const regions = new Map<string, number>()
  for (const r of rows) {
    report.totals.views += r.views
    report.totals.entries += r.entries
    if (r.region) regions.set(r.region, (regions.get(r.region) ?? 0) + (r.views || r.entries))
    const pattern = patterns.find((p) => matchPattern(p, r.path) !== undefined)
    const into = pattern ? byRoute : uncovered
    const key = pattern ?? r.path
    const entry = into.get(key) ?? { views: 0, entries: 0 }
    entry.views += r.views
    entry.entries += r.entries
    into.set(key, entry)
  }
  const { views, entries } = report.totals
  const share = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 1000 : 0)
  report.routes = [...byRoute]
    .map(([route, t]) => ({
      route,
      ...t,
      share: share(t.views, views),
      entryShare: share(t.entries, entries),
    }))
    .sort((a, b) => b.views - a.views || b.entries - a.entries)
  report.uncovered = [...uncovered]
    .map(([path, t]) => ({ path, ...t }))
    .sort((a, b) => b.views - a.views || b.entries - a.entries)
    .slice(0, 50)
  const regionTotal = [...regions.values()].reduce((a, b) => a + b, 0)
  report.regions = Object.fromEntries(
    [...regions].sort((a, b) => b[1] - a[1]).map(([r, n]) => [r, share(n, regionTotal)]),
  )

  if (!dryRun) {
    for (const r of report.routes) {
      const route = lock.routes[r.route]
      if (!route) continue
      route.traffic = {
        views: r.views,
        entries: r.entries,
        share: r.share,
        entryShare: r.entryShare,
      }
      route.weight = config.survey.weightBy === "entries" ? r.entries : r.views
    }
    project.saveLock()
  }
  return report
}

/** Spreads the imported traffic over the routes again, after the routes change. */
export function reweigh(project: Project) {
  const rows = project.store.traffic()
  if (!rows.length) return
  summariseTraffic(project, rows, {
    sources: [],
    totals: { views: 0, entries: 0 },
    routes: [],
    uncovered: [],
    regions: {},
  })
}
