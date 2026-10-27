import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs, type ParseArgsConfig } from "node:util"
import pc from "picocolors"
import {
  CONFIG_FILE,
  LOCK_FILE,
  PROBES_DIR,
  SOURCES_DIR,
  STATE_DIR,
  caseKey,
  fieldPolicy,
  parseCaseKey,
  writeConfig,
  writeLock,
  type CaseDef,
  type FieldSpec,
} from "./config.ts"
import { discover } from "./discover/index.ts"
import {
  addFinding,
  decideExperiment,
  getExperiment,
  listExperiments,
  listFindings,
  measureExperiment,
  startExperiment,
  type Experiment,
} from "./ledger.ts"
import { matchPattern } from "./patterns.ts"
import { planOf } from "./plan.ts"
import { openProject, type Project } from "./project.ts"
import { lock, loosen, ratchet, type Change } from "./ratchet.ts"
import { describeCase, markdownStatus, terminalStatus } from "./report.ts"
import { runBatch } from "./run.ts"
import { serveRunner } from "./runner.ts"
import { serve } from "./server/server.ts"
import { compareRefs, statusOf } from "./status.ts"
import { survey } from "./survey.ts"

type Options = NonNullable<ParseArgsConfig["options"]>

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const STARTERS = join(PACKAGE_ROOT, "starters")

const COMMON: Options = {
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h" },
}

function parse(argv: string[], options: Options) {
  return parseArgs({
    args: argv,
    options: { ...COMMON, ...options },
    allowPositionals: true,
    strict: true,
  })
}

const out = (json: boolean, value: unknown, human: () => string) => {
  console.log(json ? JSON.stringify(value, null, 2) : human())
}

const list = (v: unknown) =>
  (v as string[] | undefined)
    ?.flatMap((x) => x.split(","))
    .map((x) => x.trim())
    .filter(Boolean)

const routeFilter = (values: string[] | undefined) =>
  values?.length
    ? (pattern: string) => values.some((v) => pattern === v || pattern.startsWith(v))
    : undefined

function keyValues(values: string[] | undefined, sep: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const v of values ?? []) {
    const at = v.indexOf(sep)
    if (at === -1) throw new Error(`Expected name${sep}value, got "${v}"`)
    result[v.slice(0, at).trim()] = v.slice(at + 1).trim()
  }
  return result
}

// `--condition cache=cold --condition ready=main h1`: a value that reads as JSON (a number, a
// boolean, an object) is kept as that, anything else as the string it is.
function conditionsOf(values: string[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, raw] of Object.entries(keyValues(values, "="))) {
    try {
      out[k] = JSON.parse(raw)
    } catch {
      out[k] = raw
    }
  }
  return out
}

function describeChanges(changes: Change[], verb: string): string {
  const made = changes.filter((c) => !c.skipped)
  const skipped = changes.filter((c) => c.skipped)
  const lines = made.map((c) =>
    c.field === "*"
      ? `${pc.green(verb)} ${c.key}`
      : `${pc.green(verb)} ${c.key} ${c.field}${c.vantage ? `/${c.vantage}` : ""}: ${String(c.from ?? "∅")} → ${String(c.to ?? "∅")}${c.source ? pc.dim(` (${c.source})`) : ""}`,
  )
  const reasons = new Map<string, number>()
  for (const c of skipped) reasons.set(c.skipped!, (reasons.get(c.skipped!) ?? 0) + 1)
  for (const [reason, n] of reasons) lines.push(pc.dim(`skipped ${n}: ${reason}`))
  if (made.length === 0 && skipped.length === 0) lines.push("Nothing to change.")
  return lines.join("\n")
}

const HELP = `http-contract-harness (hch): the record and the method for porting a site route by route.

You, or your agent, write the probes (how a load, a navigation or a cold request is measured) and
the sources (where traffic numbers come from). The harness keeps every measurement, judges them the
same way every time, and remembers what was tried.

Set up
  init [--baseline-url URL] [--candidate-url URL]   config, lock, starter probes and sources
  probe list | probe new <name> [--from http|page|navigate|command] | probe show <name>
  survey [--csv FILE]… [--source NAME]… [--regions] where readers go, land and come from
  discover [--sitemap] [--next .next] [--traffic] [--urls FILE] [--rebuild]
  route add <pattern> [--sample PATH]… [--weight N] | route sample|weight|remove <pattern> …
  case add <route> <id> --probe P [--condition k=v]… [--header k:v]… [--query q] [--field f=policy]…
  routes

Measure
  run [--target T]… [--vantage V]… [--label L] [--route P]… [--repeats N] [--note text]
  runs
  status [--target T]… [--vantage V]… [--all] [--markdown] [--gate]
  show <route|route#case>
  compare <before> <after>                           12, port, port@label, port/vantage

Lock it in
  lock [--from T] [--vantage V]… [--run ID] [--route P]… [--case KEY]… [--force --reason why]
  ratchet [--dry-run]
  loosen <route#case> --reason why [--max MS|none] [--vantage V] [--drop FIELD]… [--set F=V]…

Improve
  experiment start "<theory>" --route P… [--target T] [--against T] [--vantage V]…
  experiment measure <id> | decide <id> keep|discard --why "…" | list [--route P] [--open] | show <id>
  note "<finding>" [--route P]… [--tag T]… [--experiment ID]
  notes [--route P] [--tag T]

Follow along
  plan                                               the phase you are in, and what is next
  serve [--port 4800]                                the dashboard, live
  runner serve --token T [--port 4900] [--region R] [--cdp URL] [--executable-path P]
  guide                                              how an agent should drive all of this

Every command takes --json.`

async function main(argv: string[]) {
  const [command, ...rest] = argv
  if (!command || command === "help" || command === "--help" || command === "-h")
    return console.log(HELP)
  if (command === "init") return init(rest)
  if (command === "guide") return console.log(readFileSync(join(PACKAGE_ROOT, "GUIDE.md"), "utf8"))
  if (command === "runner") return runner(rest)
  const project = openProject()
  try {
    await dispatch(project, command, rest)
  } finally {
    if (command !== "serve") project.store.close()
  }
}

function copyStarters(kind: "probes" | "sources", into: string, prefix = "") {
  mkdirSync(into, { recursive: true })
  const copied: string[] = []
  for (const file of readdirSync(join(STARTERS, kind))) {
    const dest = join(into, prefix + file)
    if (existsSync(dest) || existsSync(join(into, file))) continue
    copyFileSync(join(STARTERS, kind, file), dest)
    copied.push(prefix + file)
  }
  return copied
}

function init(argv: string[]) {
  const { values } = parse(argv, {
    "baseline-url": { type: "string", default: "https://www.example.com" },
    "candidate-url": { type: "string", default: "https://port.example.com" },
    baseline: { type: "string", default: "legacy" },
    candidate: { type: "string", default: "port" },
  })
  const root = process.cwd()
  if (existsSync(join(root, CONFIG_FILE))) throw new Error(`${CONFIG_FILE} already exists here`)
  writeConfig(root, {
    baseline: values.baseline,
    targets: {
      [values.baseline as string]: { url: values["baseline-url"] },
      [values.candidate as string]: { url: values["candidate-url"] },
    },
    vantages: { local: { note: "this machine" } },
    regions: {},
    allow: [],
  })
  if (!existsSync(join(root, LOCK_FILE))) writeLock(root, { version: 2, routes: {} })
  const probes = copyStarters("probes", join(root, PROBES_DIR))
  // Copied switched off: a source needs credentials and a check against a real account first.
  const sources = copyStarters("sources", join(root, SOURCES_DIR), "_")
  const gitignore = join(root, ".gitignore")
  const ignored = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : ""
  if (!ignored.split("\n").includes(STATE_DIR)) {
    appendFileSync(gitignore, `${ignored && !ignored.endsWith("\n") ? "\n" : ""}${STATE_DIR}\n`)
  }
  console.log(
    [
      `Wrote ${CONFIG_FILE}, ${LOCK_FILE}, ${probes.length} starter probes in ${PROBES_DIR}/ and ${sources.length} starter sources in ${SOURCES_DIR}/ (off until renamed without the _).`,
      "",
      "The probes and sources are yours: read them, change them, add more.",
      "`hch plan` says what to do next, in order. `hch guide` explains the method.",
    ].join("\n"),
  )
}

async function runner(argv: string[]) {
  const [sub, ...rest] = argv
  if (sub !== "serve")
    throw new Error("Usage: hch runner serve --token T [--port 4900] [--region R]")
  const { values } = parse(rest, {
    token: { type: "string" },
    port: { type: "string", default: "4900" },
    host: { type: "string", default: "0.0.0.0" },
    region: { type: "string" },
    cdp: { type: "string" },
    "executable-path": { type: "string" },
  })
  const token = (values.token as string | undefined) ?? process.env.HARNESS_RUNNER_TOKEN
  if (!token) throw new Error("runner serve needs --token or HARNESS_RUNNER_TOKEN")
  const server = await serveRunner({
    port: Number(values.port),
    host: values.host as string,
    token,
    region: values.region as string | undefined,
    browser: {
      cdp: values.cdp as string | undefined,
      executablePath: values["executable-path"] as string | undefined,
    },
    cwd: process.cwd(),
  })
  console.log(`hch runner on ${server.url}${values.region ? ` (${values.region})` : ""}`)
}

function caseFrom(values: Record<string, unknown>): CaseDef {
  const headers = keyValues(values.header as string[] | undefined, ":")
  const cookies = values.cookie as string[] | undefined
  if (cookies?.length) headers["cookie"] = cookies.join("; ")
  const fields: Record<string, FieldSpec> = {}
  for (const [f, policy] of Object.entries(keyValues(values.field as string[] | undefined, "="))) {
    fields[f] = fieldPolicy.parse(policy)
  }
  const conditions = conditionsOf(values.condition as string[] | undefined)
  return {
    probe: values.probe as string | undefined,
    conditions: Object.keys(conditions).length ? conditions : undefined,
    headers: Object.keys(headers).length ? headers : undefined,
    query: values.query as string | undefined,
    fields: Object.keys(fields).length ? fields : undefined,
    note: values.note as string | undefined,
    history: [],
  }
}

const CASE_OPTIONS: Options = {
  probe: { type: "string" },
  condition: { type: "string", multiple: true },
  header: { type: "string", multiple: true },
  cookie: { type: "string", multiple: true },
  query: { type: "string" },
  field: { type: "string", multiple: true },
  note: { type: "string" },
}

const ms = (n: number | undefined) => (n === undefined ? "–" : `${Math.round(n)}ms`)

function describeExperiment(e: Experiment, short: boolean): string {
  const state = e.decision
    ? e.decision.verdict === "keep"
      ? pc.green("kept")
      : pc.dim("discarded")
    : e.result
      ? pc.yellow("measured, undecided")
      : pc.yellow("waiting for the after batch")
  const head = `${pc.bold(e.id)}  ${state}  ${pc.dim(`${e.target} vs ${e.reference} from ${e.vantages.join(", ")} on ${e.routes.join(", ")}`)}\n  theory: ${e.theory}`
  const why = e.decision ? `\n  ${e.decision.verdict}: ${e.decision.why}` : ""
  const r = e.result
  const tally = r
    ? `\n  ${r.better} better, ${r.worse} worse, ${r.noise} noise${r.broken ? pc.red(`, ${r.broken} broke the contract`) : ""}`
    : ""
  if (short || !r) return head + tally + why
  const rows = r.cases.map((c) => {
    const call =
      c.change === "better"
        ? pc.green("better")
        : c.change === "worse"
          ? pc.red("worse")
          : pc.dim(c.change)
    const timing =
      c.before.target && c.after.target
        ? `${c.metric} ${ms(c.before.target.median)} → ${ms(c.after.target.median)}, ${c.deltaMs! > 0 ? "+" : ""}${ms(c.deltaMs)} after ${ms(c.driftMs)} drift`
        : "not measured on both sides"
    const fields = c.fields?.length
      ? `, ${c.fields.map((f) => `${f.field} ${f.before ?? "∅"} → ${f.after ?? "∅"}`).join(", ")}`
      : ""
    const broken = c.broken ? pc.red(`, broke: ${c.broken}`) : ""
    return `    ${call.padEnd(16)} ${c.key} ${pc.dim(`(${c.probe} from ${c.vantage})`)}: ${timing}${fields}${broken}`
  })
  return [head + tally + why, ...rows].join("\n")
}

async function dispatch(project: Project, command: string, argv: string[]) {
  switch (command) {
    case "probe": {
      const [sub, ...more] = argv
      const { values, positionals } = parse(more, { from: { type: "string" } })
      const name = positionals[0]
      const dir = join(project.root, project.config.probes)
      if (sub === "list" || !sub) {
        const probes = await project.probes()
        const rows = [...probes].map(([n, p]) => ({
          name: n,
          hash: p.hash,
          primary: p.primary,
          describe: p.describe,
          files: Object.keys(p.bundle.files),
        }))
        return out(
          values.json as boolean,
          rows,
          () =>
            rows
              .map(
                (r) =>
                  `${pc.bold(r.name)}@${r.hash}  ${pc.dim(`primary ${r.primary}`)}  ${r.describe}`,
              )
              .join("\n") ||
            `No probes in ${project.config.probes}/. \`hch probe new http --from http\` starts one.`,
        )
      }
      if (sub === "new") {
        if (!name)
          throw new Error("Usage: hch probe new <name> [--from http|page|navigate|command]")
        const from = (values.from as string | undefined) ?? "http"
        const source = join(STARTERS, "probes", `${from}.mjs`)
        if (!existsSync(source)) throw new Error(`No starter named ${from}`)
        const dest = join(dir, `${name}.mjs`)
        if (existsSync(dest)) throw new Error(`${dest} already exists`)
        mkdirSync(dir, { recursive: true })
        writeFileSync(dest, readFileSync(source, "utf8"))
        return out(
          values.json as boolean,
          { file: dest },
          () => `Wrote ${dest}, from the ${from} starter. It is yours to change.`,
        )
      }
      if (sub === "show") {
        const probe = (await project.probes()).get(name ?? "")
        if (!probe) throw new Error(`No probe named ${name}`)
        return out(
          values.json as boolean,
          {
            name,
            hash: probe.hash,
            primary: probe.primary,
            fields: probe.fields,
            files: probe.bundle.files,
          },
          () =>
            Object.entries(probe.bundle.files)
              .map(([f, s]) => `${pc.bold(f)}\n${s}`)
              .join("\n"),
        )
      }
      throw new Error("Usage: hch probe list|new|show")
    }

    case "survey": {
      const { values } = parse(argv, {
        csv: { type: "string", multiple: true },
        source: { type: "string", multiple: true },
        since: { type: "string" },
        regions: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
      })
      const report = await survey(project, {
        csv: values.csv as string[] | undefined,
        only: list(values.source),
        since: values.since as string | undefined,
        dryRun: values["dry-run"] as boolean,
      })
      if (values.regions && !values["dry-run"] && Object.keys(report.regions).length) {
        const file = join(project.root, CONFIG_FILE)
        const raw = JSON.parse(readFileSync(file, "utf8"))
        raw.regions = report.regions
        writeConfig(project.root, raw)
      }
      return out(values.json as boolean, report, () => {
        const pct = (n: number) => `${Math.round(n * 1000) / 10}%`
        const lines = report.sources.map((s) =>
          s.error ? pc.red(`${s.name}: ${s.error}`) : `${s.name}: ${s.rows} rows`,
        )
        lines.push("", pc.bold("Most viewed and most entered routes"))
        for (const r of report.routes.slice(0, 20)) {
          lines.push(
            `  ${r.route.padEnd(40)} ${pct(r.share).padStart(6)} of views  ${pct(r.entryShare).padStart(6)} of entries`,
          )
        }
        if (report.uncovered.length) {
          lines.push(
            "",
            pc.yellow("Traffic no route matches (`hch discover --traffic` adds routes for it):"),
          )
          for (const u of report.uncovered.slice(0, 10))
            lines.push(`  ${u.path}  ${u.views} views, ${u.entries} entries`)
        }
        if (Object.keys(report.regions).length) {
          lines.push(
            "",
            pc.bold("Where readers are"),
            "  " +
              Object.entries(report.regions)
                .map(([r, s]) => `${r} ${pct(s)}`)
                .join(", "),
          )
          if (!values.regions)
            lines.push(
              pc.dim(
                "  --regions writes this into the config, which weighs launch readiness by it",
              ),
            )
        }
        return lines.join("\n")
      })
    }

    case "discover": {
      const { values } = parse(argv, {
        sitemap: { type: "boolean", default: false },
        target: { type: "string" },
        next: { type: "string" },
        urls: { type: "string" },
        traffic: { type: "boolean", default: false },
        reweight: { type: "boolean", default: false },
        rebuild: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
      })
      const useSitemap =
        Boolean(values.sitemap) || (!values.next && !values.urls && !values.traffic)
      const report = await discover(project, {
        sitemap: useSitemap,
        target: values.target as string | undefined,
        next: values.next as string | undefined,
        urls: values.urls as string | undefined,
        traffic: values.traffic as boolean,
        reweight: values.reweight as boolean,
        rebuild: values.rebuild as boolean,
        dryRun: values["dry-run"] as boolean,
      })
      return out(values.json as boolean, report, () => {
        const lines = [`Read ${report.sources.length ? report.sources.join(", ") : "nothing"}.`]
        lines.push(
          `${report.added.length} routes added, ${report.samplesAdded.length} samples, ${report.casesAdded.length} conditional cases, ${report.weighted.length} weights.`,
        )
        for (const r of report.added.slice(0, 40)) lines.push(pc.green(`  + ${r}`))
        if (report.added.length > 40) lines.push(pc.dim(`  … and ${report.added.length - 40} more`))
        for (const c of report.casesAdded) lines.push(pc.green(`  + case ${c}`))
        if (report.dropped.length)
          lines.push(
            pc.yellow(`${report.dropped.length} untouched routes folded into declared patterns:`),
            ...report.dropped.slice(0, 40).map((p) => pc.yellow(`  - ${p}`)),
          )
        if (report.unsampled.length)
          lines.push(
            pc.yellow(
              `No sample for ${report.unsampled.length}: add one with \`hch route sample <pattern> <path>\``,
            ),
            ...report.unsampled.map((p) => `  ${p}`),
          )
        if (report.notSeen.length)
          lines.push(
            pc.yellow("In the lock but listed by no source this time (gone, or just not listed?):"),
            ...report.notSeen.map((p) => `  ${p}`),
          )
        if (report.middleware.length)
          lines.push(
            pc.yellow(
              "Middleware runs on these matchers. Add a case for each cookie or header it branches on:",
            ),
            ...report.middleware.map((m) => `  ${m}`),
          )
        for (const e of report.errors) lines.push(pc.red(`  ${e}`))
        if (values["dry-run"]) lines.push(pc.dim("(dry run: nothing written)"))
        return lines.join("\n")
      })
    }

    case "routes": {
      const { values } = parse(argv, {})
      return out(
        values.json as boolean,
        project.lock.routes,
        () =>
          Object.entries(project.lock.routes)
            .sort(([, a], [, b]) => (b.weight ?? 1) - (a.weight ?? 1))
            .map(([p, r]) => {
              const cases = Object.entries(r.cases).map(
                ([id, c]) => `${id}:${c.probe ?? project.config.defaults.probe}`,
              )
              const locked = Object.values(r.cases).filter((c) => c.expect).length
              const traffic = r.traffic
                ? ` views=${Math.round(r.traffic.share * 100)}% entries=${Math.round(r.traffic.entryShare * 100)}%`
                : ""
              return `${p}  ${pc.dim(`w=${r.weight ?? project.config.defaults.weight}${traffic} samples=${r.samples.length} locked=${locked}/${cases.length} cases=${cases.join(",")}`)}`
            })
            .join("\n") || "No routes yet. Run `hch discover` or `hch route add`.",
      )
    }

    case "route": {
      const [sub, pattern, ...more] = argv
      if (!sub || !pattern) throw new Error("Usage: hch route add|sample|weight|remove <pattern> …")
      const { values, positionals } = parse(more, {
        sample: { type: "string", multiple: true },
        weight: { type: "string" },
      })
      const routes = project.lock.routes
      const checkSamples = (samples: string[]) => {
        const stray = samples.filter((s) => matchPattern(pattern, s) === undefined)
        if (stray.length)
          throw new Error(
            `${stray.join(", ")} ${stray.length === 1 ? "does" : "do"} not match ${pattern}`,
          )
      }
      if (sub === "add") {
        if (routes[pattern]) throw new Error(`${pattern} is already in the lock`)
        const samples =
          (values.sample as string[] | undefined) ?? (pattern.includes(":") ? [] : [pattern])
        checkSamples(samples)
        routes[pattern] = {
          samples,
          weight: values.weight ? Number(values.weight) : undefined,
          source: "manual",
          cases: { default: { history: [] } },
        }
      } else {
        const route = routes[pattern]
        if (!route) throw new Error(`${pattern} is not in the lock`)
        if (sub === "sample") {
          checkSamples(positionals)
          route.samples.push(...positionals.filter((p) => !route.samples.includes(p)))
        } else if (sub === "weight") route.weight = Number(positionals[0])
        else if (sub === "remove") delete routes[pattern]
        else throw new Error(`Unknown: route ${sub}`)
      }
      project.saveLock()
      return out(
        values.json as boolean,
        routes[pattern] ?? null,
        () => `${sub === "remove" ? "Removed" : "Saved"} ${pattern}`,
      )
    }

    case "case": {
      const [sub, pattern, id, ...more] = argv
      if (sub !== "add" || !pattern || !id)
        throw new Error("Usage: hch case add <route> <id> --probe P [--condition k=v]…")
      const { values } = parse(more, CASE_OPTIONS)
      const route = project.lock.routes[pattern]
      if (!route) throw new Error(`${pattern} is not in the lock; add it with \`hch route add\``)
      if (route.cases[id]) throw new Error(`${caseKey(pattern, id)} already exists`)
      const def = caseFrom(values)
      const probes = await project.probes()
      const probe = def.probe ?? project.config.defaults.probe
      if (!probes.has(probe))
        throw new Error(
          `No probe named ${probe}; probes: ${[...probes.keys()].join(", ") || "none"}`,
        )
      route.cases[id] = def
      project.saveLock()
      return out(values.json as boolean, def, () => `Added ${caseKey(pattern, id)} (${probe})`)
    }

    case "run": {
      const { values } = parse(argv, {
        target: { type: "string", multiple: true },
        vantage: { type: "string", multiple: true },
        label: { type: "string" },
        route: { type: "string", multiple: true },
        repeats: { type: "string" },
        concurrency: { type: "string" },
        note: { type: "string" },
      })
      const targets = list(values.target) ?? Object.keys(project.config.targets)
      const started = Date.now()
      const result = await runBatch(project, {
        targets,
        vantages: list(values.vantage),
        label: values.label as string | undefined,
        note: values.note as string | undefined,
        routes: routeFilter(values.route as string[] | undefined),
        repeats: values.repeats ? Number(values.repeats) : undefined,
        concurrency: values.concurrency ? Number(values.concurrency) : undefined,
        onObservation: values.json
          ? undefined
          : (o, done, total) => {
              const mark = o.error ? pc.red("✗") : pc.dim("·")
              process.stderr.write(
                `\r${mark} ${done}/${total} ${o.target}/${o.vantage} ${o.path.slice(0, 50).padEnd(50)}`,
              )
            },
      })
      if (!values.json) process.stderr.write("\n")
      const seconds = (Date.now() - started) / 1000
      const errors = result.observations.filter((o) => o.error)
      return out(
        values.json as boolean,
        {
          ...result,
          observations: undefined,
          errors: errors.map((o) => ({
            key: caseKey(o.route, o.caseId),
            target: o.target,
            vantage: o.vantage,
            error: o.error,
          })),
          seconds,
        },
        () =>
          [
            ...result.batches.map(
              (b) =>
                `Batch ${b.batch} from ${b.vantage}${b.region ? ` (${b.region})` : ""}: ${targets.join(", ")} interleaved`,
            ),
            `${result.observations.length} observations in ${seconds.toFixed(1)}s${errors.length ? pc.red(`, ${errors.length} failed`) : ""}`,
            ...errors
              .slice(0, 10)
              .map((o) =>
                pc.red(`  ${caseKey(o.route, o.caseId)} on ${o.target}/${o.vantage}: ${o.error}`),
              ),
            ...Object.entries(result.missingHeaders).map(([t, m]) =>
              pc.yellow(`${t}: ${m.join(", ")} unset, so those headers were not sent`),
            ),
            pc.dim("`hch status` shows how they did."),
          ].join("\n"),
      )
    }

    case "runs": {
      const { values } = parse(argv, { limit: { type: "string", default: "20" } })
      const runs = project.store.runs(Number(values.limit))
      return out(
        values.json as boolean,
        runs,
        () =>
          runs
            .map(
              (r) =>
                `#${r.id}  ${r.target}/${r.vantage}${r.label ? `@${r.label}` : ""}  batch ${r.batch}  ${r.startedAt.slice(0, 19).replace("T", " ")}  ${r.gitSha ?? ""} ${r.finishedAt ? "" : pc.yellow("unfinished")} ${r.note ?? ""}`,
            )
            .join("\n") || "No runs yet.",
      )
    }

    case "status": {
      const { values } = parse(argv, {
        target: { type: "string", multiple: true },
        vantage: { type: "string", multiple: true },
        label: { type: "string" },
        all: { type: "boolean", default: false },
        markdown: { type: "boolean", default: false },
        gate: { type: "boolean", default: false },
      })
      const evals = await statusOf(project, {
        targets: list(values.target),
        vantages: list(values.vantage),
        label: values.label as string | undefined,
      })
      if (values.markdown) console.log(markdownStatus(evals))
      else
        out(values.json as boolean, evals, () =>
          terminalStatus(evals, { all: values.all as boolean }),
        )
      if (values.gate && evals.some((e) => e.evaluation.counts.fail > 0)) process.exitCode = 1
      return
    }

    case "show": {
      const [ref, ...more] = argv
      if (!ref) throw new Error("Usage: hch show <route|route#case>")
      const { values } = parse(more, { vantage: { type: "string", multiple: true } })
      const { pattern, caseId } = ref.includes("#")
        ? parseCaseKey(ref)
        : { pattern: ref, caseId: undefined }
      const route = project.lock.routes[pattern]
      if (!route) throw new Error(`${pattern} is not in the lock`)
      const evals = await statusOf(project, { vantages: list(values.vantage) })
      const cases = evals.map((e) => ({
        target: e.target,
        vantage: e.vantage,
        cases:
          e.evaluation.routes
            .find((r) => r.route === pattern)
            ?.cases.filter((c) => !caseId || c.caseId === caseId) ?? [],
      }))
      const findings = listFindings(project, { routes: [pattern] })
      return out(values.json as boolean, { route, cases, findings }, () => {
        const lines = [
          pc.bold(pattern),
          pc.dim(
            `samples: ${route.samples.join(", ") || "none"}${route.traffic ? `; ${Math.round(route.traffic.share * 100)}% of views, ${Math.round(route.traffic.entryShare * 100)}% of entries` : ""}`,
          ),
        ]
        for (const [id, def] of Object.entries(route.cases)) {
          if (caseId && id !== caseId) continue
          lines.push(
            "",
            pc.bold(`#${id}`) +
              pc.dim(
                ` ${def.probe ?? project.config.defaults.probe}${def.conditions ? ` ${JSON.stringify(def.conditions)}` : ""}${def.query ? ` ?${def.query}` : ""}`,
              ),
          )
          if (def.expect) {
            const timing = Object.entries(def.expect.timing)
              .map(([v, s]) => `${v} ${s.median}ms`)
              .join(", ")
            lines.push(
              pc.dim(
                `  locked from ${def.expect.lockedFrom} with ${def.expect.probe?.name}@${def.expect.probe?.hash}: status ${def.expect.status ?? "∅"}; ${def.expect.metric ?? "primary"} ${timing || "∅"}`,
              ),
            )
          }
          for (const c of cases)
            for (const v of c.cases.filter((x) => x.caseId === id))
              lines.push(...describeCase(`${c.target}/${c.vantage}`, v))
          for (const h of def.history.slice(-5)) {
            const change =
              h.field === "*" ? "" : ` ${h.field} ${String(h.from ?? "∅")} → ${String(h.to ?? "∅")}`
            lines.push(
              pc.dim(`  ${h.at.slice(0, 10)} ${h.by}${change}${h.reason ? `: ${h.reason}` : ""}`),
            )
          }
        }
        if (findings.length)
          lines.push(
            "",
            pc.bold("Findings"),
            ...findings.map((f) => `  ${f.at.slice(0, 10)} ${f.text}`),
          )
        return lines.join("\n")
      })
    }

    case "compare": {
      const [before, after, ...more] = argv
      if (!before || !after) throw new Error("Usage: hch compare <before> <after>")
      const { values } = parse(more, {
        all: { type: "boolean", default: false },
        markdown: { type: "boolean", default: false },
      })
      const result = await compareRefs(project, before, after)
      if (values.markdown) return console.log(markdownStatus([result]))
      return out(
        values.json as boolean,
        result,
        () =>
          `${pc.bold(result.before)} → ${pc.bold(result.target)}\n` +
          terminalStatus([result], { all: values.all as boolean }),
      )
    }

    case "lock": {
      const { values } = parse(argv, {
        from: { type: "string" },
        vantage: { type: "string", multiple: true },
        run: { type: "string" },
        route: { type: "string", multiple: true },
        case: { type: "string", multiple: true },
        force: { type: "boolean", default: false },
        reason: { type: "string" },
        "dry-run": { type: "boolean", default: false },
      })
      const routes = routeFilter(values.route as string[] | undefined)
      const keys = values.case as string[] | undefined
      const changes = await lock(project, {
        from: (values.from as string | undefined) ?? project.config.baseline,
        vantages: list(values.vantage),
        runId: values.run ? Number(values.run) : undefined,
        only:
          routes || keys
            ? (key, pattern) => (routes?.(pattern) ?? false) || (keys?.includes(key) ?? false)
            : undefined,
        force: values.force as boolean,
        reason: values.reason as string | undefined,
        dryRun: values["dry-run"] as boolean,
      })
      return out(values.json as boolean, changes, () =>
        describeChanges(changes, values["dry-run"] ? "would lock" : "locked"),
      )
    }

    case "ratchet": {
      const { values } = parse(argv, { "dry-run": { type: "boolean", default: false } })
      const changes = await ratchet(project, { dryRun: values["dry-run"] as boolean })
      return out(values.json as boolean, changes, () =>
        describeChanges(changes, values["dry-run"] ? "would tighten" : "tightened"),
      )
    }

    case "loosen": {
      const [key, ...more] = argv
      if (!key) throw new Error("Usage: hch loosen <route#case> --reason why …")
      const { values } = parse(more, {
        reason: { type: "string" },
        max: { type: "string" },
        vantage: { type: "string" },
        drop: { type: "string", multiple: true },
        set: { type: "string", multiple: true },
      })
      const changes = loosen(project, key, {
        reason: (values.reason as string | undefined) ?? "",
        max:
          values.max === undefined
            ? undefined
            : values.max === "none"
              ? "none"
              : Number(values.max),
        vantage: values.vantage as string | undefined,
        drop: values.drop as string[] | undefined,
        set: keyValues(values.set as string[] | undefined, "="),
      })
      return out(values.json as boolean, changes, () => describeChanges(changes, "loosened"))
    }

    case "experiment": {
      const [sub, ...more] = argv
      const { values, positionals } = parse(more, {
        route: { type: "string", multiple: true },
        target: { type: "string" },
        against: { type: "string" },
        vantage: { type: "string", multiple: true },
        id: { type: "string" },
        why: { type: "string" },
        note: { type: "string" },
        repeats: { type: "string" },
        open: { type: "boolean", default: false },
      })
      const json = values.json as boolean
      const repeats = values.repeats ? Number(values.repeats) : undefined
      if (sub === "start") {
        const target =
          (values.target as string | undefined) ??
          Object.keys(project.config.targets).find((t) => t !== project.config.baseline) ??
          project.config.baseline
        const { experiment, related } = await startExperiment(project, {
          theory: positionals.join(" "),
          routes: (values.route as string[] | undefined) ?? [],
          target,
          against: values.against as string | undefined,
          vantages: list(values.vantage),
          id: values.id as string | undefined,
          repeats,
          note: values.note as string | undefined,
        })
        return out(json, { experiment, related }, () =>
          [
            ...(related.experiments.length
              ? [
                  pc.yellow("Already tried on these routes:"),
                  ...related.experiments.map((e) => describeExperiment(e, true)),
                  "",
                ]
              : []),
            ...(related.findings.length
              ? [
                  pc.yellow("Findings about these routes:"),
                  ...related.findings.map((f) => `  ${f.text}`),
                  "",
                ]
              : []),
            `Started ${pc.bold(experiment.id)}: measured the before batch of ${experiment.target}, against ${experiment.reference}, from ${experiment.vantages.join(", ")}.`,
            `Make the one change, deploy it, then: hch experiment measure ${experiment.id}`,
          ].join("\n"),
        )
      }
      if (sub === "measure") {
        const id = positionals[0]
        if (!id) throw new Error("Usage: hch experiment measure <id>")
        const { experiment, warnings } = await measureExperiment(project, id, {
          note: values.note as string | undefined,
          repeats,
        })
        if (!json) for (const w of warnings) console.error(pc.yellow(w))
        return out(json, { experiment, warnings }, () =>
          [
            describeExperiment(experiment, false),
            "",
            `Then: hch experiment decide ${id} keep|discard --why "…"`,
          ].join("\n"),
        )
      }
      if (sub === "decide") {
        const [id, verdict] = positionals
        if (!id || (verdict !== "keep" && verdict !== "discard"))
          throw new Error('Usage: hch experiment decide <id> keep|discard --why "…"')
        const experiment = decideExperiment(
          project,
          id,
          verdict,
          (values.why as string | undefined) ?? "",
        )
        return out(json, experiment, () => `${verdict === "keep" ? "Kept" : "Discarded"} ${id}.`)
      }
      if (sub === "list") {
        const found = listExperiments(project, {
          routes: values.route as string[] | undefined,
          open: values.open as boolean,
        })
        return out(
          json,
          found,
          () => found.map((e) => describeExperiment(e, true)).join("\n") || "No experiments yet.",
        )
      }
      if (sub === "show") {
        const id = positionals[0]
        if (!id) throw new Error("Usage: hch experiment show <id>")
        const experiment = getExperiment(project, id)
        return out(json, experiment, () => describeExperiment(experiment, false))
      }
      throw new Error("Usage: hch experiment start|measure|decide|list|show")
    }

    case "note": {
      const { values, positionals } = parse(argv, {
        route: { type: "string", multiple: true },
        tag: { type: "string", multiple: true },
        experiment: { type: "string" },
      })
      const finding = addFinding(project, {
        text: positionals.join(" "),
        routes: values.route as string[] | undefined,
        tags: list(values.tag),
        experiment: values.experiment as string | undefined,
      })
      return out(values.json as boolean, finding, () => `Noted ${finding.id}`)
    }

    case "notes": {
      const { values } = parse(argv, {
        route: { type: "string", multiple: true },
        tag: { type: "string" },
      })
      const found = listFindings(project, {
        routes: values.route as string[] | undefined,
        tag: values.tag as string | undefined,
      })
      return out(
        values.json as boolean,
        found,
        () =>
          found
            .map(
              (f) =>
                `${pc.dim(f.at.slice(0, 10))} ${f.text}${f.routes.length ? pc.dim(` (${f.routes.join(", ")})`) : ""}${f.tags.length ? pc.dim(` #${f.tags.join(" #")}`) : ""}`,
            )
            .join("\n") || "No findings yet.",
      )
    }

    case "plan": {
      const { values } = parse(argv, {})
      const plan = await planOf(project)
      return out(values.json as boolean, plan, () => {
        const lines: string[] = []
        for (const p of plan.phases) {
          const here = p.id === plan.phase
          lines.push(
            `${p.done ? pc.green("✓") : here ? pc.yellow("→") : pc.dim("·")} ${here ? pc.bold(p.title) : p.title}`,
          )
          if (here || !p.done)
            for (const c of p.checks)
              lines.push(`    ${c.ok ? pc.green("✓") : pc.red("✗")} ${c.text}`)
          if (here) for (const n of p.next) lines.push(pc.dim(`    next: ${n}`))
        }
        lines.push(
          "",
          `Priority routes (${plan.priority.length}): ${plan.priority.slice(0, 10).join(", ")}${plan.priority.length > 10 ? ", …" : ""}`,
        )
        return lines.join("\n")
      })
    }

    case "serve": {
      const { values } = parse(argv, {
        port: { type: "string", default: "4800" },
        host: { type: "string", default: "127.0.0.1" },
      })
      const { url } = await serve(project, {
        port: Number(values.port),
        host: values.host as string,
      })
      console.log(`hch dashboard on ${url}`)
      return
    }

    default:
      throw new Error(`Unknown command "${command}". \`hch help\` lists them.`)
  }
}

export async function cli(argv: string[]) {
  try {
    await main(argv)
  } catch (error) {
    console.error(pc.red(error instanceof Error ? error.message : String(error)))
    process.exitCode = 2
  }
}
