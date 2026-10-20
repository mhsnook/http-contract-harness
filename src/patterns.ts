// Patterns are written `/event/:city/:id`, with `:name+` for a catch-all of one or more segments
// and `:name*` for zero or more.

export function fromNextPath(appPath: string): string {
  const pattern = appPath
    .replace(/\/(page|route|index)$/, "")
    .split("/")
    .filter((segment) => !/^\(.*\)$/.test(segment) && !segment.startsWith("@"))
    .map((segment) =>
      segment
        .replace(/^\[\[\.\.\.(\w+)\]\]$/, ":$1*")
        .replace(/^\[\.\.\.(\w+)\]$/, ":$1+")
        .replace(/^\[(\w+)\]$/, ":$1"),
    )
    .join("/")
  return pattern || "/"
}

export const isDynamic = (pattern: string) =>
  pattern.split("/").some((segment) => segment.startsWith(":"))

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export function patternRegex(pattern: string): RegExp {
  if (pattern === "/") return /^\/(?:\?.*)?$/
  const source = pattern
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return escape(segment)
      const name = segment.slice(1).replace(/[+*]$/, "")
      if (segment.endsWith("+")) return `(?<${name}>[^?]+)`
      if (segment.endsWith("*")) return `?(?<${name}>[^?]*)`
      return `(?<${name}>[^/?]+)`
    })
    .join("/")
  return new RegExp(`^${source}(?:\\?.*)?$`)
}

export function matchPattern(pattern: string, path: string): Record<string, string> | undefined {
  const match = patternRegex(pattern).exec(path)
  if (!match) return undefined
  return { ...match.groups }
}

export function templateWith(value: string, params: Record<string, string>): string {
  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/]+/i.exec(value)?.[0] ?? ""
  const rest = value.slice(origin.length)
  const queryAt = rest.indexOf("?")
  let path = queryAt === -1 ? rest : rest.slice(0, queryAt)
  const query = queryAt === -1 ? "" : rest.slice(queryAt)

  const entries = Object.entries(params).filter(([, v]) => v)
  // A catch-all's value spans segments, so it is replaced as a run of segments first.
  for (const [name, v] of entries.filter(([, v]) => v.includes("/"))) {
    path = path.split(`/${v}`).join(`/{${name}}`)
  }
  // Whole segments only: a short value such as a page number `2` would otherwise rewrite every
  // other segment that happens to contain it.
  const single = new Map(entries.filter(([, v]) => !v.includes("/")).map(([name, v]) => [v, name]))
  path = path
    .split("/")
    .map((segment) => (single.has(segment) ? `{${single.get(segment)}}` : segment))
    .join("/")
  return origin + path + query
}

/** Expands a parameter the config names into its literal options, `""` dropping the segment. */
export function expandPattern(pattern: string, expand: Record<string, string[]>): string[] {
  let results = [pattern]
  for (const [name, options] of Object.entries(expand)) {
    const segment = `/:${name}`
    results = results.flatMap((p) => {
      if (!p.includes(segment)) return [p]
      return options.map((option) => {
        const replaced = p.replace(segment, option ? `/${option}` : "")
        return replaced || "/"
      })
    })
  }
  return results
}

// The first segment never collapses into a parameter, or `/about`, `/blog` and `/contact` read as
// one `/:slug` route.
export function inferPatterns(paths: string[], minVariants = 3): Map<string, string[]> {
  const byPattern = new Map<string, string[]>()
  const split = [...new Set(paths.map((p) => p.split("?")[0] ?? p))].map((p) =>
    p === "/" ? [] : p.replace(/\/$/, "").split("/").slice(1),
  )

  const walk = (group: string[][], depth: number, prefix: string[]) => {
    const done = group.filter((segments) => segments.length === depth)
    if (done.length > 0) {
      const pattern = "/" + prefix.join("/")
      byPattern.set(pattern, [
        ...(byPattern.get(pattern) ?? []),
        ...done.map((s) => "/" + s.join("/")),
      ])
    }
    const rest = group.filter((segments) => segments.length > depth)
    if (rest.length === 0) return
    const values = new Map<string, string[][]>()
    for (const segments of rest) {
      const value = segments[depth] as string
      values.set(value, [...(values.get(value) ?? []), segments])
    }
    if (depth > 0 && values.size >= minVariants) {
      walk(rest, depth + 1, [...prefix, `:${paramName(prefix)}`])
      return
    }
    for (const [value, members] of values) walk(members, depth + 1, [...prefix, value])
  }

  walk(split, 0, [])
  return byPattern
}

function paramName(prefix: string[]): string {
  const literal = [...prefix].reverse().find((segment) => !segment.startsWith(":"))
  const base = (literal ?? "param").replace(/[^a-zA-Z0-9]/g, "") || "param"
  const taken = prefix.filter((segment) => segment.replace(/\d+$/, "") === `:${base}`).length
  return taken === 0 ? base : `${base}${taken + 1}`
}

export function borrowSamples(pattern: string, sampled: Map<string, string[]>): string[] {
  const segments = pattern.split("/")
  const bound = segments.findLastIndex((segment) => segment.startsWith(":")) + 1
  if (bound === 0 || /[+*](\/|$)/.test(segments.slice(0, bound).join("/"))) return []
  const head = (path: string) => path.split("/").slice(0, bound).join("/")
  const tail = segments.slice(bound)
  for (const [other, paths] of sampled) {
    if (other === pattern || head(other) !== head(pattern)) continue
    return paths.map((path) => [head(path.split("?")[0] ?? path), ...tail].join("/"))
  }
  return []
}

export function bySpecificity(a: string, b: string): number {
  const score = (p: string) =>
    p.split("/").map((s) => (s.endsWith("+") || s.endsWith("*") ? 2 : s.startsWith(":") ? 1 : 0))
  const [x, y] = [score(a), score(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1)
    if (d !== 0) return d
  }
  return a.localeCompare(b)
}
