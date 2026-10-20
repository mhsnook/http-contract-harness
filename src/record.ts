import { templateWith } from "./patterns.ts"

// Keys are lower-case header names, `status`, and `html.*` for what the page itself declares.
export type ResponseRecord = Record<string, string | number>

export type RecordOptions = {
  baseURL: string
  params: Record<string, string>
  headers: string[]
  htmlCacheControl: boolean
}

export function relativeTo(value: string, baseURL: string): string {
  try {
    const url = new URL(value, baseURL)
    if (url.origin !== new URL(baseURL).origin) return url.href
    return url.pathname + url.search
  } catch {
    return value
  }
}

const HTML_FIELDS: [string, RegExp][] = [
  ["html.lang", /<html\b[^>]*\blang\s*=\s*["']([^"']*)["']/i],
  [
    "html.canonical",
    /<link\b(?=[^>]*\brel\s*=\s*["']canonical["'])[^>]*\bhref\s*=\s*["']([^"']*)["']/i,
  ],
  [
    "html.robots",
    /<meta\b(?=[^>]*\bname\s*=\s*["']robots["'])[^>]*\bcontent\s*=\s*["']([^"']*)["']/i,
  ],
]

export function normalise(
  status: number,
  headers: Record<string, string>,
  body: string | undefined,
  opts: RecordOptions,
): ResponseRecord {
  const out: ResponseRecord = { status }
  const place = (value: string) => templateWith(relativeTo(value, opts.baseURL), opts.params)

  if (headers["location"] !== undefined) out["location"] = place(headers["location"])
  const contentType = headers["content-type"]
  if (contentType !== undefined) out["content-type"] = contentType
  const isHtml = contentType?.startsWith("text/html") ?? false
  // Hosts disagree on HTML Cache-Control by design (a CDN rewrites it, a framework sets its own),
  // so keeping it would make every cross-host comparison noise unless a site opts in.
  if (headers["cache-control"] !== undefined && (!isHtml || opts.htmlCacheControl)) {
    out["cache-control"] = headers["cache-control"]
  }
  for (const name of opts.headers) {
    const value = headers[name.toLowerCase()]
    if (value !== undefined) out[name.toLowerCase()] = value
  }
  if (isHtml && body !== undefined) {
    for (const [field, regex] of HTML_FIELDS) {
      const found = regex.exec(body)?.[1]
      if (found === undefined) continue
      out[field] = field === "html.canonical" ? place(found) : found
    }
  }
  return out
}

export function commonRecord(records: ResponseRecord[]): ResponseRecord | undefined {
  const counts = new Map<string, { record: ResponseRecord; n: number }>()
  for (const record of records) {
    const key = JSON.stringify(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
    const entry = counts.get(key) ?? { record, n: 0 }
    entry.n++
    counts.set(key, entry)
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.record
}
