import { readFileSync } from "node:fs"

const PATH_COLUMNS = ["path", "page", "pathname", "url", "name", "entry_page", "page_path"]
const COUNT_COLUMNS = [
  "pageviews",
  "views",
  "visitors",
  "visits",
  "count",
  "hits",
  "sessions",
  "conversions",
]

function toPath(value: string): string | undefined {
  const v = value.trim().replace(/^"|"$/g, "")
  if (!v) return undefined
  if (v.startsWith("/")) return v
  try {
    const url = new URL(v)
    return url.pathname + url.search
  } catch {
    return undefined
  }
}

function splitCsv(line: string): string[] {
  const out: string[] = []
  let cell = ""
  let quoted = false
  for (const ch of line) {
    if (ch === '"') quoted = !quoted
    else if (ch === "," && !quoted) {
      out.push(cell)
      cell = ""
    } else cell += ch
  }
  out.push(cell)
  return out.map((c) => c.trim())
}

export function readUrlList(file: string): Map<string, number> {
  const lines = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith("#"))
  const out = new Map<string, number>()
  const add = (path: string | undefined, count: number) => {
    if (path) out.set(path, (out.get(path) ?? 0) + (Number.isFinite(count) ? count : 1))
  }
  const header = lines[0] ? splitCsv(lines[0].toLowerCase()) : []
  const pathAt = header.findIndex((h) => PATH_COLUMNS.includes(h))
  if (pathAt !== -1) {
    const countAt = header.findIndex((h) => COUNT_COLUMNS.includes(h))
    for (const line of lines.slice(1)) {
      const cells = splitCsv(line)
      add(
        toPath(cells[pathAt] ?? ""),
        countAt === -1 ? 1 : Number((cells[countAt] ?? "1").replace(/,/g, "")),
      )
    }
    return out
  }
  for (const line of lines) {
    const parts = line.includes(",") ? splitCsv(line) : line.trim().split(/\s+/)
    const path = parts.map(toPath).find(Boolean)
    const count = parts.map((p) => Number(p)).find((n) => Number.isFinite(n))
    add(path, count ?? 1)
  }
  return out
}
