export type CacheClass = "cached" | "uncached" | "unknown"

export type Hint = "hit" | "miss" | "bypass"

export type Exchange = {
  headers: Record<string, string>
  bodyHash: string
  stamp?: string
}

const STATUS_HEADERS = [
  "cf-cache-status",
  "x-vercel-cache",
  "x-nextjs-cache",
  "x-vinext-cache",
  "x-cache",
  "x-cache-status",
  "x-proxy-cache",
  "cdn-cache",
]

function readStatus(value: string): Hint | undefined {
  const v = value.toLowerCase()
  if (/\b(hit|stale|updating|revalidated|prerender)\b/.test(v)) return "hit"
  if (/\b(dynamic|bypass|pass|no-?cache)\b/.test(v)) return "bypass"
  if (/\b(miss|expired)\b/.test(v)) return "miss"
  return undefined
}

export function hintOf(headers: Record<string, string>): { hint?: Hint; header?: string } {
  for (const name of STATUS_HEADERS) {
    const value = headers[name]
    if (value === undefined) continue
    const hint = readStatus(value)
    if (hint) return { hint, header: `${name}: ${value}` }
  }
  const age = Number(headers["age"])
  if (Number.isFinite(age) && age > 0) return { hint: "hit", header: `age: ${headers["age"]}` }
  return {}
}

// Header evidence skips the first request, which may be the one that filled the cache. Identical
// bodies on every request stay "unknown": a deterministic page renders the same bytes uncached.
export function classify(exchanges: Exchange[]): { cache: CacheClass; signal: string } {
  const warm = exchanges.length > 1 ? exchanges.slice(1) : exchanges
  const hints = warm.map((e) => hintOf(e.headers))
  const hit = hints.find((h) => h.hint === "hit")
  if (hit) return { cache: "cached", signal: hit.header ?? "hit" }
  if (hints.length > 0 && hints.every((h) => h.hint === "miss" || h.hint === "bypass")) {
    return { cache: "uncached", signal: hints[hints.length - 1]?.header ?? "miss" }
  }

  if (exchanges.length < 2) return { cache: "unknown", signal: "one request; no cache header" }

  const stamps = exchanges.map((e) => e.stamp)
  if (stamps.every((s) => s !== undefined)) {
    const distinct = new Set(stamps).size
    if (distinct === exchanges.length) {
      return { cache: "uncached", signal: `render stamp changed on all ${exchanges.length}` }
    }
    return {
      cache: "cached",
      signal: `render stamp repeated: ${distinct} distinct in ${exchanges.length}`,
    }
  }

  const distinct = new Set(exchanges.map((e) => e.bodyHash)).size
  if (distinct === exchanges.length) {
    return { cache: "uncached", signal: `body changed on all ${exchanges.length} requests` }
  }
  if (distinct > 1) {
    return {
      cache: "cached",
      signal: `body repeated byte for byte: ${distinct} distinct in ${exchanges.length}`,
    }
  }
  return { cache: "unknown", signal: `identical bodies, no cache header` }
}
