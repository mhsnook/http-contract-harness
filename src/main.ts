import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs, type ParseArgsConfig } from "node:util"
import pc from "picocolors"
import {
  CONFIG_FILE,
  LOCK_FILE,
  STATE_DIR,
  caseKey,
  parseCaseKey,
  writeConfig,
  writeLock,
  cachePolicy,
} from "./config.ts"
import { discover } from "./discover/index.ts"
import { matchPattern } from "./patterns.ts"
import { openProject, type Project } from "./project.ts"
import { lock, loosen, ratchet, type Change } from "./ratchet.ts"
import { describeCase, markdownStatus, terminalStatus } from "./report.ts"
import { runBatch } from "./run.ts"
import { serve } from "./server/server.ts"
import { compareRefs, statusOf } from "./status.ts"

type Options = NonNullable<ParseArgsConfig["options"]>

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

function describeChanges(changes: Change[], verb: string): string {
  const made = changes.filter((c) => !c.skipped)
  const skipped = changes.filter((c) => c.skipped)
  const lines = made.map((c) =>
    c.field === "*"
      ? `${pc.green(verb)} ${c.key}`
      : `${pc.green(verb)} ${c.key} ${c.field}: ${String(c.from ?? "∅")} → ${String(c.to ?? "∅")}${c.source ? pc.dim(` (${c.source})`) : ""}`,
  )
  const reasons = new Map<string, number>()
  for (const c of skipped) reasons.set(c.skipped!, (reasons.get(c.skipped!) ?? 0) + 1)
  for (const [reason, n] of reasons) lines.push(pc.dim(`skipped ${n}: ${reason}`))
  if (made.length === 0 && skipped.length === 0) lines.push("Nothing to change.")
  return lines.join("\n")
}

const HELP = `portside: port a site route by route, with a lock that only ratchets up.

Set up
  init [--baseline-url URL] [--candidate-url URL]   write ${CONFIG_FILE} and ${LOCK_FILE}
  discover [--sitemap] [--next .next] [--urls FILE] [--rebuild]
                                                     add routes, samples and weights to the lock
  route add <pattern> [--sample PATH]… [--weight N] [--cache-policy must-match|if-slower|ignore]
  route sample <pattern> <path>…                     add samples to a route
  route weight <pattern> <n>
  route remove <pattern>
  case add <pattern> <id> [--header k:v]… [--cookie k=v]… [--query q] [--note text]
  routes                                             list the inventory

Measure
  run [--target T]… [--label L] [--route P]… [--repeats N] [--note text]
  runs                                               recent runs
  status [--target T]… [--all] [--markdown] [--gate] how every route does against the lock
  show <route|route#case>                            one route on every target, in full
  compare <before> <after>                           runs or targets head to head: 12, port, port@label

Lock it in
  lock [--from T | --run ID] [--route P]… [--case KEY]… [--force --reason why] [--dry-run]
  ratchet [--dry-run]                                tighten every lock a target now beats
  loosen <route#case> --reason why [--ttfb MS|none] [--cache uncached|none] [--drop FIELD]… [--set FIELD=VALUE]…

Watch
  serve [--port 4800]                                the dashboard, live as runs land
  guide                                              how an agent should drive all of this

Every command takes --json.`

async function main(argv: string[]) {
  const [command, ...rest] = argv
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP)
    return
  }

  if (command === "init") return init(rest)
  if (command === "guide") {
    const file = new URL("../GUIDE.md", import.meta.url)
    console.log(readFileSync(file, "utf8"))
    return
  }

  const project = openProject()
  try {
    await dispatch(project, command, rest)
  } finally {
    if (command !== "serve") project.store.close()
  }
}

function init(argv: string[]) {
  const { values } = parse(argv, {
    "baseline-url": { type: "string", default: "https://www.example.com" },
    "candidate-url": { type: "string", default: "http://localhost:3000" },
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
    discover: { sitemap: "/sitemap.xml", samplesPerRoute: 3 },
    allow: [],
  })
  if (!existsSync(join(root, LOCK_FILE))) writeLock(root, { version: 1, routes: {} })
  const gitignore = join(root, ".gitignore")
  const ignored = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : ""
  if (!ignored.split("\n").includes(STATE_DIR))
    appendFileSync(gitignore, `${ignored && !ignored.endsWith("\n") ? "\n" : ""}${STATE_DIR}\n`)
  console.log(
    [
      `Wrote ${CONFIG_FILE} and ${LOCK_FILE}, and added ${STATE_DIR} to .gitignore.`,
      "",
      "Next:",
      `  1. Set the two target URLs in ${CONFIG_FILE}.`,
      "  2. portside discover --sitemap            (and --next .next on a Next app, --urls top-pages.csv for weights)",
      `  3. portside run --target ${values.baseline}`,
      `  4. portside lock --from ${values.baseline}`,
      `  5. portside run --target ${values.candidate} && portside status`,
    ].join("\n"),
  )
}

async function dispatch(project: Project, command: string, argv: string[]) {
  switch (command) {
    case "discover": {
      const { values } = parse(argv, {
        sitemap: { type: "boolean", default: false },
        target: { type: "string" },
        next: { type: "string" },
        urls: { type: "string" },
        reweight: { type: "boolean", default: false },
        rebuild: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
      })
      const useSitemap = Boolean(values.sitemap) || (!values.next && !values.urls)
      const report = await discover(project, {
        sitemap: useSitemap,
        target: values.target as string | undefined,
        next: values.next as string | undefined,
        urls: values.urls as string | undefined,
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
              `No sample for ${report.unsampled.length}: add one with \`portside route sample <pattern> <path>\``,
            ),
            ...report.unsampled.map((p) => `  ${p}`),
          )
        if (report.notSeen.length)
          lines.push(
            pc.yellow(
              `In the lock but listed by no source this time (gone, or just not in the sitemap?):`,
            ),
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
            .map(([p, r]) => {
              const cases = Object.keys(r.cases).filter((c) => c !== "default")
              const locked = Object.values(r.cases).filter((c) => c.expect).length
              return `${p}  ${pc.dim(`w=${r.weight ?? project.config.defaults.weight} samples=${r.samples.length} locked=${locked}/${Object.keys(r.cases).length}${r.declared ? ` declared=${r.declared.mode}${r.declared.revalidate ? `(${r.declared.revalidate}s)` : ""}` : ""}${cases.length ? ` cases=${cases.join(",")}` : ""}`)}`
            })
            .join("\n") || "No routes yet. Run `portside discover` or `portside route add`.",
      )
    }

    case "route": {
      const [sub, pattern, ...more] = argv
      if (!sub || !pattern)
        throw new Error("Usage: portside route add|sample|weight|remove <pattern> …")
      const { values, positionals } = parse(more, {
        sample: { type: "string", multiple: true },
        weight: { type: "string" },
        "cache-policy": { type: "string" },
      })
      const routes = project.lock.routes
      const checkSamples = (samples: string[]) => {
        const stray = samples.filter((sample) => matchPattern(pattern, sample) === undefined)
        if (stray.length)
          throw new Error(
            `${stray.join(", ")} ${stray.length === 1 ? "does" : "do"} not match ${pattern}`,
          )
      }
      if (sub === "add") {
        if (routes[pattern]) throw new Error(`${pattern} is already in the lock`)
        const policy = values["cache-policy"]
          ? cachePolicy.parse(values["cache-policy"])
          : undefined
        const samples =
          (values.sample as string[] | undefined) ?? (pattern.includes(":") ? [] : [pattern])
        checkSamples(samples)
        routes[pattern] = {
          samples,
          weight: values.weight ? Number(values.weight) : undefined,
          cachePolicy: policy,
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
        throw new Error(
          "Usage: portside case add <pattern> <id> [--header k:v] [--cookie k=v] [--query q]",
        )
      const { values } = parse(more, {
        header: { type: "string", multiple: true },
        cookie: { type: "string", multiple: true },
        query: { type: "string" },
        note: { type: "string" },
      })
      const route = project.lock.routes[pattern]
      if (!route)
        throw new Error(`${pattern} is not in the lock; add it with \`portside route add\``)
      if (route.cases[id]) throw new Error(`${caseKey(pattern, id)} already exists`)
      const headers = keyValues(values.header as string[] | undefined, ":")
      const cookies = values.cookie as string[] | undefined
      if (cookies?.length) headers["cookie"] = cookies.join("; ")
      route.cases[id] = {
        headers: Object.keys(headers).length ? headers : undefined,
        query: values.query as string | undefined,
        note: values.note as string | undefined,
        history: [],
      }
      project.saveLock()
      return out(values.json as boolean, route.cases[id], () => `Added ${caseKey(pattern, id)}`)
    }

    case "run": {
      const { values } = parse(argv, {
        target: { type: "string", multiple: true },
        label: { type: "string" },
        route: { type: "string", multiple: true },
        repeats: { type: "string" },
        concurrency: { type: "string" },
        note: { type: "string" },
      })
      const targets = (values.target as string[] | undefined) ?? Object.keys(project.config.targets)
      const started = Date.now()
      const result = await runBatch(project, {
        targets,
        label: values.label as string | undefined,
        note: values.note as string | undefined,
        routes: routeFilter(values.route as string[] | undefined),
        repeats: values.repeats ? Number(values.repeats) : undefined,
        concurrency: values.concurrency ? Number(values.concurrency) : undefined,
        onObservation: values.json
          ? undefined
          : (o, target, done, total) => {
              const mark = o.error ? pc.red("✗") : pc.dim("·")
              process.stderr.write(
                `\r${mark} ${done}/${total} ${target} ${o.path.slice(0, 60).padEnd(60)}`,
              )
            },
      })
      if (!values.json) process.stderr.write("\n")
      const seconds = (Date.now() - started) / 1000
      const runs = result.runs.map((r) => ({
        ...r,
        observations: result.observations.filter((o) => o.runId === r.runId).length,
        errors: result.observations.filter((o) => o.runId === r.runId && o.error).length,
        missingHeaders: result.missingHeaders[r.target] ?? [],
      }))
      return out(values.json as boolean, { batch: result.batch, seconds, runs }, () =>
        [`Batch ${result.batch}: ${targets.join(", ")} interleaved, in ${seconds.toFixed(1)}s`]
          .concat(
            runs.map(
              (r) =>
                `  run ${r.runId} on ${r.target}: ${r.observations} cases${r.errors ? pc.red(`, ${r.errors} failed`) : ""}${r.missingHeaders.length ? pc.yellow(` (unset: ${r.missingHeaders.join(", ")}; those headers were not sent)`) : ""}`,
            ),
          )
          .concat(pc.dim("`portside status` shows how they did."))
          .join("\n"),
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
                `#${r.id}  ${r.target}${r.label ? `@${r.label}` : ""}  ${r.startedAt.slice(0, 19).replace("T", " ")}  ${r.gitSha ?? ""}  ${r.finishedAt ? "" : pc.yellow("unfinished")} ${r.note ?? ""}`,
            )
            .join("\n") || "No runs yet.",
      )
    }

    case "status": {
      const { values } = parse(argv, {
        target: { type: "string", multiple: true },
        label: { type: "string" },
        all: { type: "boolean", default: false },
        markdown: { type: "boolean", default: false },
        gate: { type: "boolean", default: false },
      })
      const evals = statusOf(
        project,
        values.target as string[] | undefined,
        values.label as string | undefined,
      )
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
      if (!ref) throw new Error("Usage: portside show <route|route#case>")
      const { values } = parse(more, {})
      const { pattern, caseId } = ref.includes("#")
        ? parseCaseKey(ref)
        : { pattern: ref, caseId: undefined }
      const route = project.lock.routes[pattern]
      if (!route) throw new Error(`${pattern} is not in the lock`)
      const evals = statusOf(project)
      const cases = evals.map(({ target, evaluation }) => ({
        target,
        cases:
          evaluation.routes
            .find((r) => r.route === pattern)
            ?.cases.filter((c) => !caseId || c.caseId === caseId) ?? [],
      }))
      return out(values.json as boolean, { route, cases }, () => {
        const lines = [
          pc.bold(pattern),
          pc.dim(
            `samples: ${route.samples.join(", ") || "none"}${route.declared ? `; declared ${route.declared.mode}${route.declared.revalidate ? ` ${route.declared.revalidate}s` : ""}` : ""}`,
          ),
        ]
        for (const [id, def] of Object.entries(route.cases)) {
          if (caseId && id !== caseId) continue
          lines.push(
            "",
            pc.bold(`#${id}`) +
              (def.headers ? pc.dim(` headers ${JSON.stringify(def.headers)}`) : "") +
              (def.query ? pc.dim(` ?${def.query}`) : ""),
          )
          if (def.expect)
            lines.push(
              pc.dim(
                `  locked from ${def.expect.lockedFrom} at ${def.expect.lockedAt}: status ${def.expect.status}, cache ${def.expect.cache ?? "∅"}, ttfb ${def.expect.ttfb ? `median ${def.expect.ttfb.median}ms (p25 ${def.expect.ttfb.p25}–p75 ${def.expect.ttfb.p75})` : "∅"}${def.expect.ttfbMax !== undefined ? `, max median ${def.expect.ttfbMax}ms` : ""}`,
              ),
            )
          for (const { target, cases: list } of cases)
            for (const c of list.filter((c) => c.caseId === id))
              lines.push(...describeCase(target, c))
          for (const h of def.history.slice(-5)) {
            const change =
              h.field === "*" ? "" : ` ${h.field} ${String(h.from ?? "∅")} → ${String(h.to ?? "∅")}`
            lines.push(
              pc.dim(`  ${h.at.slice(0, 10)} ${h.by}${change}${h.reason ? `: ${h.reason}` : ""}`),
            )
          }
        }
        return lines.join("\n")
      })
    }

    case "compare": {
      const [before, after, ...more] = argv
      if (!before || !after) throw new Error("Usage: portside compare <before> <after>")
      const { values } = parse(more, {
        all: { type: "boolean", default: false },
        markdown: { type: "boolean", default: false },
      })
      const result = compareRefs(project, before, after)
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
        run: { type: "string" },
        route: { type: "string", multiple: true },
        case: { type: "string", multiple: true },
        force: { type: "boolean", default: false },
        reason: { type: "string" },
        "dry-run": { type: "boolean", default: false },
      })
      const routes = routeFilter(values.route as string[] | undefined)
      const keys = values.case as string[] | undefined
      const changes = lock(project, {
        from: (values.from as string | undefined) ?? project.config.baseline,
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
      const changes = ratchet(project, { dryRun: values["dry-run"] as boolean })
      return out(values.json as boolean, changes, () =>
        describeChanges(changes, values["dry-run"] ? "would tighten" : "tightened"),
      )
    }

    case "loosen": {
      const [key, ...more] = argv
      if (!key) throw new Error("Usage: portside loosen <route#case> --reason why …")
      const { values } = parse(more, {
        reason: { type: "string" },
        ttfb: { type: "string" },
        cache: { type: "string" },
        drop: { type: "string", multiple: true },
        set: { type: "string", multiple: true },
      })
      const cache = values.cache as string | undefined
      if (cache && cache !== "uncached" && cache !== "none")
        throw new Error("--cache takes uncached or none")
      const changes = loosen(project, key, {
        reason: (values.reason as string | undefined) ?? "",
        ttfb:
          values.ttfb === undefined
            ? undefined
            : values.ttfb === "none"
              ? "none"
              : Number(values.ttfb),
        cache: cache as "uncached" | "none" | undefined,
        drop: values.drop as string[] | undefined,
        set: keyValues(values.set as string[] | undefined, "="),
      })
      return out(values.json as boolean, changes, () => describeChanges(changes, "loosened"))
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
      console.log(`portside dashboard on ${url}`)
      return
    }

    default:
      throw new Error(`Unknown command "${command}". \`portside help\` lists them.`)
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
