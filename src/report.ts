import pc from "picocolors"
import type { TargetEvaluation } from "./status.ts"
import type { CaseVerdict, RouteVerdict, State } from "./verdict.ts"

export type { TargetEvaluation }

const label = (e: TargetEvaluation, many: boolean) => (many ? `${e.target}/${e.vantage}` : e.target)
const manyVantages = (evals: TargetEvaluation[]) => new Set(evals.map((e) => e.vantage)).size > 1

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
  const error = c.contract.diffs.find((d) => d.field === "error")
  if (error) return `error: ${show(error.actual)}`
  if (c.stale) return "stale lock: the probe changed"
  if (c.reference === "none") return "unlocked"
  if (c.reference === "self" && c.state === "pass") return "reference"
  const contract = c.contract.diffs.filter(
    (d) => !d.allowed && !d.improved && d.policy !== "ignore",
  )
  if (c.contract.state === "fail" && contract[0]) {
    const d = contract[0]
    if (d.field === "error") return `error: ${show(d.actual)}`
    return `${d.field} ${show(d.expected)} → ${show(d.actual)}`
  }
  if (c.perf.state === "fail" || c.perf.state === "warn") {
    if (c.perf.call !== "worse")
      return `median ${ms(c.perf.actual?.median)} > max ${ms(c.perf.max)}`
    if (c.perf.note?.includes("carry it back"))
      return `${c.perf.against} is faster: ${ms(c.perf.baseline?.median)}, carry back?`
    const than = c.perf.against ? ` than ${c.perf.against}` : ""
    const when = c.perf.paired === false ? " (another run)" : ""
    return `slower${than}: ${ms(c.perf.baseline?.median)} → ${ms(c.perf.actual?.median)}${when}`
  }
  if (c.contract.state === "warn" && contract[0]) {
    return `${contract[0].field} ${show(contract[0].expected)} → ${show(contract[0].actual)}, fast enough`
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
  const many = manyVantages(evals)
  const byTarget = evals.map((e) => ({
    target: label(e, many),
    map: new Map(e.evaluation.routes.map((r) => [r.route, r])),
  }))

  const rows = [...routes.values()]
    .map((r) => ({ route: r, cells: byTarget.map((t) => t.map.get(r.route)) }))
    .filter((row) => opts.all || row.cells.some((c) => c && c.state !== "pass"))
    .sort((a, b) => b.route.weight - a.route.weight || a.route.route.localeCompare(b.route.route))

  const lines: string[] = []
  const labelWidth = Math.max(16, ...evals.map((e) => label(e, many).length))
  for (const e of evals) {
    const c = e.evaluation.counts
    lines.push(
      `${pc.bold(label(e, many).padEnd(labelWidth))} ${pc.green(`${c.pass} pass`)}  ${pc.yellow(`${c.warn} warn`)}  ${pc.red(`${c.fail} fail`)}  ${pc.dim(`${c.unknown} unknown`)}`,
    )
  }
  if (rows.length === 0) {
    lines.push(
      "",
      opts.all
        ? "No routes in the lock yet: run `hch discover`."
        : pc.green("Every route passes on every target."),
    )
    return lines.join("\n")
  }

  const routeWidth = Math.min(48, Math.max(5, ...rows.map((r) => r.route.route.length)))
  const widths = evals.map((e, i) =>
    Math.min(
      60,
      Math.max(label(e, many).length, ...rows.map((r) => cell(r.cells[i]).plain.length)),
    ),
  )

  lines.push("")
  lines.push(
    pc.dim(
      "ROUTE".padEnd(routeWidth) +
        "  " +
        "WEIGHT".padStart(7) +
        "  " +
        evals.map((e, i) => label(e, many).padEnd(widths[i]!)).join("  "),
    ),
  )
  for (const row of rows) {
    const name =
      row.route.route.length > routeWidth
        ? row.route.route.slice(0, routeWidth - 1) + "…"
        : row.route.route
    const cells = row.cells.map(cell).map((c, i) => pad(c.text, c.plain, widths[i]!))
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
      pc.dim("Passing routes hidden; --all shows them. `hch show <route>` explains one."),
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
  const used = new Set(evals.flatMap((e) => e.evaluation.usedAllowances))
  return [...new Set(evals.flatMap((e) => e.evaluation.unusedAllowances))].filter(
    (id) => !used.has(id),
  )
}

export function describeCase(target: string, c: CaseVerdict): string[] {
  const lines = [
    `  ${COLOR[c.state](`${GLYPH[c.state]} ${target}`)} ${pc.dim(`(${c.probe}, against ${c.reference})`)}`,
  ]
  if (!c.observed) return [...lines, pc.dim("    not run yet")]
  if (c.stale) lines.push(pc.yellow(`    ${c.stale}`))
  for (const d of c.contract.diffs) {
    const text = `    ${d.field}: ${show(d.expected)} → ${show(d.actual)}  ${pc.dim(d.sample)}`
    if (d.allowed) lines.push(pc.dim(`${text} (allowed: ${d.allowed})`))
    else if (d.improved) lines.push(pc.green(`${text} (better)`))
    else if (d.policy === "ignore") lines.push(pc.dim(`${text} (ignored)`))
    else if (d.policy === "if-slower") lines.push(pc.yellow(`${text} (matters only if slower)`))
    else lines.push(pc.red(text))
  }
  if (c.contract.note) lines.push(pc.dim(`    ${c.contract.note}`))
  const a = c.perf.actual
  const perf = a
    ? `    ${c.perf.metric}: median ${ms(a.median)}, p75 ${ms(a.p75)} (n=${a.n})` +
      (c.perf.baseline
        ? `; ${c.perf.against ?? "reference"}${c.perf.paired ? " in the same batch" : c.perf.paired === false ? " from another run" : ""} median ${ms(c.perf.baseline.median)}, p75 ${ms(c.perf.baseline.p75)}: ${c.perf.call}`
        : "") +
      (c.perf.max !== undefined ? `; max median ${ms(c.perf.max)}` : "") +
      (c.perf.note ? `; ${c.perf.note}` : "")
    : `    ${c.perf.metric}: –`
  lines.push(COLOR[c.perf.state](perf))
  return lines
}

export function markdownStatus(evals: TargetEvaluation[]): string {
  const out: string[] = ["## Port status", ""]
  const many = manyVantages(evals)
  out.push("| Target | Pass | Warn | Fail | Unknown |", "| --- | --: | --: | --: | --: |")
  for (const t of evals) {
    const e = t.evaluation
    out.push(
      `| ${label(t, many)} | ${e.counts.pass} | ${e.counts.warn} | ${e.counts.fail} | ${e.counts.unknown} |`,
    )
  }
  const failing = evals.flatMap((t) =>
    t.evaluation.routes.flatMap((r) =>
      r.cases
        .filter((c) => c.state === "fail" || c.state === "warn")
        .map((c) => ({ target: label(t, many), route: r, c })),
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
