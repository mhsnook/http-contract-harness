import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fromNextPath } from "../patterns.ts"

export type FoundRoute = {
  pattern: string
  source: string
  declared?: { mode: string; revalidate?: number }
  samples: string[]
  cases?: Record<string, { headers?: Record<string, string>; query?: string; note?: string }>
}

const readJson = (file: string): any =>
  existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined

function fillParams(pattern: string): string {
  const filled = pattern.replace(/\/:\w+[*+?]?(\([^)]*\))?/g, "/sample").replace(/\(.*?\)/g, "")
  return filled || "/"
}

type Has = { type: "cookie" | "header" | "query" | "host"; key: string; value?: string }

// A literal value when the condition names one, otherwise a stand-in: the condition only needs
// to be present for the request to take the conditional branch.
const literal = (value: string | undefined) => (value && /^[\w.-]+$/.test(value) ? value : "1")

function conditionCase(
  has: Has[],
): { id: string; headers: Record<string, string>; query?: string } | undefined {
  const headers: Record<string, string> = {}
  const query: string[] = []
  for (const h of has) {
    if (h.type === "cookie")
      headers["cookie"] = [headers["cookie"], `${h.key}=${literal(h.value)}`]
        .filter(Boolean)
        .join("; ")
    else if (h.type === "header") headers[h.key.toLowerCase()] = literal(h.value)
    else if (h.type === "query") query.push(`${h.key}=${literal(h.value)}`)
    else return undefined
  }
  const id =
    "when-" +
    has
      .map((h) => `${h.type}-${h.key}`)
      .join("-")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "")
  return { id, headers, query: query.length ? query.join("&") : undefined }
}

export function nextRoutes(dir: string): {
  routes: FoundRoute[]
  middleware: string[]
  read: string[]
} {
  const read: string[] = []
  const load = (file: string) => {
    const json = readJson(join(dir, file))
    if (json) read.push(file)
    return json
  }
  if (!existsSync(dir))
    throw new Error(`No Next build at ${dir}. Run \`next build\` first, or pass --next-dir.`)

  const routes = new Map<string, FoundRoute>()
  const add = (pattern: string, source: string) => {
    const route = routes.get(pattern) ?? { pattern, source, samples: [] }
    routes.set(pattern, route)
    return route
  }

  const app = load("server/app-paths-manifest.json") ?? {}
  for (const key of Object.keys(app)) {
    if (key.split("/").some((segment) => segment.startsWith("_"))) continue
    const route = add(fromNextPath(key), "next")
    if (key.endsWith("/route")) route.declared = { mode: "handler" }
  }
  const pages = load("server/pages-manifest.json") ?? {}
  for (const key of Object.keys(pages)) {
    if (/^\/(_app|_document|_error|404|500)$/.test(key)) continue
    add(fromNextPath(key), "next")
  }

  const prerender = load("prerender-manifest.json")
  if (prerender) {
    for (const [path, info] of Object.entries<any>(prerender.routes ?? {})) {
      const pattern = fromNextPath(info.srcRoute ?? path)
      const route = add(pattern, "next")
      const revalidate = info.initialRevalidateSeconds
      route.declared =
        typeof revalidate === "number" && revalidate > 0
          ? { mode: "isr", revalidate }
          : { mode: "static" }
      if (pattern !== path && !path.includes("[")) route.samples.push(path)
    }
    for (const src of Object.keys(prerender.dynamicRoutes ?? {})) {
      const route = add(fromNextPath(src), "next")
      route.declared ??= { mode: "on-demand" }
    }
  }
  for (const route of routes.values()) route.declared ??= { mode: "dynamic" }

  const manifest = load("routes-manifest.json")
  for (const redirect of manifest?.redirects ?? []) {
    if (redirect.internal) continue
    const source: string = redirect.source
    const route = add(source.replace(/\(.*?\)/g, ""), "next-redirect")
    if (!redirect.has?.length) route.declared = { mode: "redirect" }
    const sample = fillParams(source)
    if (!route.samples.includes(sample)) route.samples.push(sample)
    if (redirect.has?.length) {
      const c = conditionCase(redirect.has)
      if (c) {
        route.cases ??= {}
        route.cases[c.id] = {
          headers: Object.keys(c.headers).length ? c.headers : undefined,
          query: c.query,
          note: `next.config redirect when ${JSON.stringify(redirect.has)}`,
        }
      }
    }
  }

  const middleware: string[] = []
  const mw = load("server/middleware-manifest.json")
  for (const entry of Object.values<any>(mw?.middleware ?? {})) {
    for (const matcher of entry.matchers ?? [])
      middleware.push(matcher.originalSource ?? matcher.regexp)
  }

  return { routes: [...routes.values()], middleware, read }
}
