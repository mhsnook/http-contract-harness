import pc from "picocolors"
import type { CaseVerdict, Evaluation, RouteVerdict, State } from "./verdict.ts"

export type TargetEvaluation = { target: string; evaluation: Evaluation }

const GLYPH: Record<State, string> = { pass: "✓", warn: "!", fail: "✗", unknown: "·" }
const COLOR: Record<State, (s: string) => string> = {
  pass: pc.green,
  warn: pc.yellow,
  fail: pc.red,
  unknown: pc.dim,
}

const ms = (n: number | undefined) => (n === undefined ? "–" : `${Math.round(n)}ms`)
const show = (v: unknown) => (v === undefined ? "∅" : String(v))

export function reasonOf(c: CaseVerdict): string {
  if (!c.observed) return "not run"
  if (c.reference === "none") return "unlocked"
  const contract = c.contract.diffs.filter((d) => !d.allowed)
  if (c.contract.state === "fail" && contract[0]) {
    const d = contract[0]
    if (d.field === "error") return `error: ${show(d.actual)}`
    return `${d.field} ${show(d.expected)} → ${show(d.actual)}`
  }
  if (c.perf.state === "fail" || c.perf.state === "warn") {
    if (c.perf.call !== "worse")
      return `median ${ms(c.perf.actual?.median)} > max ${ms(c.perf.max)}`
    const than = c.perf.against ? ` than ${c.perf.against}` : ""
    const when = c.perf.paired === false ? " (another run)" : ""
    return `slower${than}: ${ms(c.perf.baseline?.median)} → ${ms(c.perf.actual?.median)}${when}`
  }
  if (c.cache.state !== "pass" && c.cache.state !== "unknown") {
    return `${c.cache.expected} → ${c.cache.actual}`
  }
  return ""
}

function worstCase(route: RouteVerdict): CaseVerdict | undefined {
  const order: State[] = ["fail", "warn", "pass", "unknown"]
  for (const state of order) {
    const found = route.cases.find((c) => c.state === state)
    if (found) return found
  }
  return undefined
}

function cell(route: RouteVerdict | undefined): { text: string; plain: string } {
  if (!route) return { text: pc.dim("–"), plain: "–" }
  const c = worstCase(route)
  const p75 = Math.max(...route.cases.map((x) => x.perf.actual?.p75 ?? 0)) || undefined
  const reason = route.samples === 0 ? "no sample" : c ? reasonOf(c) : ""
  const caseNote = route.cases.length > 1 && c && c.state !== "pass" ? `#${c.caseId} ` : ""
  const plain = `${GLYPH[route.state]} ${ms(p75).padStart(6)} ${caseNote}${reason}`.trimEnd()
  return { text: COLOR[route.state](plain), plain }
}

const pad = (text: string, plain: string, width: number) =>
  text + " ".repeat(Math.max(0, width - plain.length))

export function terminalStatus(evals: TargetEvaluation[], opts: { all?: boolean } = {}): string {
  const routes = new Map<string, RouteVerdict>()
  for (const { evaluation } of evals)
    for (const r of evaluation.routes) if (!routes.has(r.route)) routes.set(r.route, r)
  const byTarget = evals.map(({ target, evaluation }) => ({
    target,
    map: new Map(evaluation.routes.map((r) => [r.route, r])),
  }))

  const rows = [...routes.values()]
    .map((r) => ({ route: r, cells: byTarget.map((t) => t.map.get(r.route)) }))
    .filter((row) => opts.all || row.cells.some((c) => c && c.state !== "pass"))
    .sort((a, b) => b.route.weight - a.route.weight || a.route.route.localeCompare(b.route.route))

  const lines: string[] = []
  for (const { target, evaluation } of evals) {
    const c = evaluation.counts
    lines.push(
      `${pc.bold(target.padEnd(12))} ${pc.green(`${c.pass} pass`)}  ${pc.yellow(`${c.warn} warn`)}  ${pc.red(`${c.fail} fail`)}  ${pc.dim(`${c.unknown} unknown`)}`,
    )
  }
  if (rows.length === 0) {
    lines.push(
      "",
      opts.all
        ? "No routes in the lock yet: run `portside discover`."
        : pc.green("Every route passes on every target."),
    )
    return lines.join("\n")
  }

  const routeWidth = Math.min(48, Math.max(5, ...rows.map((r) => r.route.route.length)))
  const cellWidth = 34
  lines.push("")
  lines.push(
    pc.dim(
      "ROUTE".padEnd(routeWidth) +
        "  " +
        "WEIGHT".padStart(7) +
        "  " +
        evals.map((e) => e.target.padEnd(cellWidth)).join("  "),
    ),
  )
  for (const row of rows) {
    const name =
      row.route.route.length > routeWidth
        ? row.route.route.slice(0, routeWidth - 1) + "…"
        : row.route.route
    const cells = row.cells
      .map(cell)
      .map((c) => pad(c.text, c.plain.slice(0, cellWidth), cellWidth))
    lines.push(
      name.padEnd(routeWidth) +
        "  " +
        String(row.route.weight).padStart(7) +
        "  " +
        cells.join("  "),
    )
  }
  if (!opts.all)
    lines.push(
      "",
      pc.dim("Passing routes hidden; --all shows them. `portside show <route>` explains one."),
    )
  for (const id of unusedEverywhere(evals)) {
    lines.push(
      pc.yellow(
        `The allowance "${id}" matched nothing on any target: remove it if the difference is gone`,
      ),
    )
  }
  return lines.join("\n")
}

export function unusedEverywhere(evals: TargetEvaluation[]): string[] {
  const [first, ...rest] = evals.map((e) => e.evaluation.unusedAllowances)
  return (first ?? []).filter((id) => rest.every((list) => list.includes(id)))
}

export function describeCase(target: string, c: CaseVerdict): string[] {
  const lines = [
    `  ${COLOR[c.state](`${GLYPH[c.state]} ${target}`)} ${pc.dim(`(against ${c.reference})`)}`,
  ]
  if (!c.observed) return [...lines, pc.dim("    not run yet")]
  for (const d of c.contract.diffs) {
    const text = `    ${d.field}: ${show(d.expected)} → ${show(d.actual)}  ${pc.dim(d.sample)}`
    lines.push(d.allowed ? pc.dim(`${text} (allowed: ${d.allowed})`) : pc.red(text))
  }
  const cache = `    cache: ${c.cache.expected ?? "∅"} → ${c.cache.actual}  ${pc.dim(c.cache.signal ?? "")}`
  lines.push(COLOR[c.cache.state](cache) + (c.cache.note ? pc.dim(` (${c.cache.note})`) : ""))
  const a = c.perf.actual
  const perf = a
    ? `    ttfb: median ${ms(a.median)}, p75 ${ms(a.p75)} (n=${a.n})` +
      (c.perf.baseline
        ? `; ${c.perf.against ?? "reference"}${c.perf.paired ? " in the same batch" : c.perf.paired === false ? " from another run" : ""} median ${ms(c.perf.baseline.median)}, p75 ${ms(c.perf.baseline.p75)}: ${c.perf.call}`
        : "") +
      (c.perf.max !== undefined ? `; max median ${ms(c.perf.max)}` : "") +
      (c.perf.note ? `; ${c.perf.note}` : "")
    : "    ttfb: –"
  lines.push(COLOR[c.perf.state](perf))
  return lines
}

export function markdownStatus(evals: TargetEvaluation[]): string {
  const out: string[] = ["## Port status", ""]
  out.push("| Target | Pass | Warn | Fail | Unknown |", "| --- | --: | --: | --: | --: |")
  for (const { target, evaluation: e } of evals) {
    out.push(
      `| ${target} | ${e.counts.pass} | ${e.counts.warn} | ${e.counts.fail} | ${e.counts.unknown} |`,
    )
  }
  const failing = evals.flatMap(({ target, evaluation }) =>
    evaluation.routes.flatMap((r) =>
      r.cases
        .filter((c) => c.state === "fail" || c.state === "warn")
        .map((c) => ({ target, route: r, c })),
    ),
  )
  failing.sort((a, b) => b.route.weight - a.route.weight)
  if (failing.length === 0) {
    out.push("", "Every observed route meets its lock.")
    return out.join("\n")
  }
  out.push("", "| Route | Weight | Target | State | Why |", "| --- | --: | --- | --- | --- |")
  for (const { target, route, c } of failing.slice(0, 50)) {
    out.push(
      `| \`${c.key}\` | ${route.weight} | ${target} | ${c.state} | ${reasonOf(c).replace(/\|/g, "\\|")} |`,
    )
  }
  if (failing.length > 50) out.push("", `… and ${failing.length - 50} more.`)
  return out.join("\n")
}
