import { referenceOf, type Config } from "./config.ts"
import type { TargetEvaluation } from "./status.ts"
import type { CaseVerdict } from "./verdict.ts"

export const REGION_NAMES: Record<string, string> = {
  nam: "North America",
  sam: "South America",
  weur: "western Europe",
  eeur: "eastern Europe",
  me: "the Middle East",
  afr: "Africa",
  apac: "Asia-Pacific",
  oc: "Oceania",
}

const ms = (n: number | undefined) => (n === undefined ? "–" : `${Math.round(n)}ms`)
const show = (v: unknown) => (v === undefined ? "nothing" : String(v))

/**
 * A prompt to hand an agent for one case that fails or warns on one target, or undefined when the
 * case passes. It says what differs and how to check a fix, and leaves the fix to the agent.
 */
export function promptFor(config: Config, target: string, c: CaseVerdict): string | undefined {
  if (c.state === "pass" || c.state === "unknown") return undefined
  const region = config.vantages[c.vantage]?.region
  const where = `from the ${c.vantage} vantage${region ? ` (${REGION_NAMES[region] ?? region})` : ""}`
  const url = config.targets[target]?.url
  const reference = referenceOf(config, target)
  const key = c.key

  if (c.perf.note?.includes("carry it back")) {
    return [
      `The HTTP contract harness finds the port faster than the current site on ${key}, measured ${where}:`,
      `${c.perf.against} has a median ${c.perf.metric} of ${ms(c.perf.baseline?.median)}, against ${ms(c.perf.actual?.median)} on ${target}.`,
      "",
      `Find out what ${c.perf.against} does differently on this route, and propose the same change to the current site (${target}${url ? `, ${url}` : ""}). Do not change it yet; describe the change and what it would cost.`,
      "",
      "To see both sides:",
      `  hch show "${key}" --json`,
      `  hch notes --route "${c.route}" --json`,
    ].join("\n")
  }

  const lines = [
    `The HTTP contract harness reports that ${key} ${c.state === "fail" ? "fails" : "warns"} on ${target}${url ? ` (${url})` : ""}, measured ${where} with the ${c.probe} probe.`,
    "",
    "What differs:",
  ]
  const open = c.contract.diffs.filter((d) => !d.allowed && !d.improved && d.policy !== "ignore")
  for (const d of open) {
    if (d.field === "error") lines.push(`- the probe failed: ${show(d.actual)} (${d.sample})`)
    else
      lines.push(
        `- ${d.field}: expected ${show(d.expected)}, got ${show(d.actual)} on ${d.sample}${d.policy === "if-slower" ? " (this matters only while the route is also slower)" : ""}`,
      )
  }
  if (c.perf.state === "fail" || c.perf.state === "warn") {
    const against =
      c.perf.against === "lock"
        ? "the lock"
        : `${c.perf.against}${c.perf.paired ? " in the same batch" : ""}`
    lines.push(
      c.perf.call === "worse"
        ? `- ${c.perf.metric}: median ${ms(c.perf.actual?.median)} against ${ms(c.perf.baseline?.median)} on ${against}`
        : `- ${c.perf.metric}: median ${ms(c.perf.actual?.median)}, over the ${ms(c.perf.max)} ceiling`,
    )
    if (c.perf.note) lines.push(`  (${c.perf.note})`)
  }
  if (c.stale) lines.push(`- the lock is stale: ${c.stale}`)
  lines.push(
    "",
    `It is held to ${c.reference === "lock" ? `the lock taken from ${config.baseline}` : `${reference}, measured in the same batch`}.`,
    "",
    "Find the cause and fix it in the port. Start with:",
    `  hch show "${key}" --json`,
    `  hch experiment list --route "${c.route}" --json`,
    `  hch notes --route "${c.route}" --json`,
    "Change one thing, deploy it to the target, then check it:",
    `  hch run --target ${reference} --target ${target}`,
    `  hch status --target ${target} --json`,
    "Do not loosen the lock or add an allowance to make it pass. If you think the difference is acceptable, say why and ask.",
  )
  return lines.join("\n")
}

/** Every prompt for the cases that fail or warn, keyed `target/vantage route#case`. */
export function promptsOf(config: Config, evals: TargetEvaluation[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { target, vantage, evaluation } of evals)
    for (const route of evaluation.routes)
      for (const c of route.cases) {
        const prompt = promptFor(config, target, c)
        if (prompt) out[`${target}/${vantage} ${c.key}`] = prompt
      }
  return out
}
