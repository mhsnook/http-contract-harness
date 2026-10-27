import { tracksOf } from "./config.ts"
import { readLedger } from "./ledger.ts"
import { casesOf, type Project } from "./project.ts"
import { statusOf, type TargetEvaluation } from "./status.ts"
import { summariseTraffic } from "./survey.ts"

// A `note` is advice for a person and never holds a phase open.
export type Check = { ok: boolean; text: string; note?: boolean }
export type Phase = {
  // survey, inventory, profile, parity:<track> for each track in order, improve, launch
  id: string
  title: string
  done: boolean
  checks: Check[]
  next: string[]
}
export type Plan = {
  phase: string
  priority: string[]
  readiness: { score: number; byTarget: Record<string, number>; track?: string }
  phases: Phase[]
}

/**
 * The smallest set of routes that holds `cover` of the views and of the entries, heaviest first.
 * Without traffic data, the heaviest routes by weight.
 */
export function priorityRoutes(project: Project, cover = 0.8, fallback = 20): string[] {
  const routes = Object.entries(project.lock.routes)
  const withTraffic = routes.filter(([, r]) => r.traffic)
  if (withTraffic.length === 0) {
    return routes
      .sort(([a, x], [b, y]) => (y.weight ?? 1) - (x.weight ?? 1) || a.localeCompare(b))
      .slice(0, fallback)
      .map(([p]) => p)
  }
  const pick = (key: "share" | "entryShare") => {
    const out: string[] = []
    let sum = 0
    for (const [p, r] of [...withTraffic].sort(
      ([, a], [, b]) => b.traffic![key] - a.traffic![key],
    )) {
      if (sum >= cover || r.traffic![key] === 0) break
      out.push(p)
      sum += r.traffic![key]
    }
    return out
  }
  return [...new Set([...pick("share"), ...pick("entryShare")])]
}

/**
 * Traffic-weighted readiness: each priority route's share of views, times each region's share of
 * readers through the vantage that measures it, counted when the route passes there.
 */
function readiness(project: Project, evals: TargetEvaluation[], priority: string[]) {
  const { config } = project
  const regionWeight = (vantage: string) => {
    const region = config.vantages[vantage]?.region
    const regions = Object.entries(config.regions)
    if (regions.length === 0 || !region) return 1
    return config.regions[region] ?? 0
  }
  const tracks = tracksOf(config)
  const byTarget: Record<string, number> = {}
  for (const target of tracks.map((t) => t.port)) {
    let got = 0
    let of = 0
    for (const e of evals.filter((x) => x.target === target)) {
      const w = regionWeight(e.vantage)
      for (const pattern of priority) {
        const route = e.evaluation.routes.find((r) => r.route === pattern)
        const share = project.lock.routes[pattern]?.traffic?.share ?? 1 / priority.length
        of += share * w
        if (route?.state === "pass" || route?.state === "warn") got += share * w
      }
    }
    byTarget[target] = of ? Math.round((got / of) * 1000) / 1000 : 0
  }
  // The last track is the one that goes live, so its port's readiness is the launch score.
  const last = tracks.at(-1)
  return { score: last ? (byTarget[last.port] ?? 0) : 0, byTarget, track: last?.name }
}

export async function planOf(project: Project): Promise<Plan> {
  const { config, lock, store } = project
  const traffic = store.traffic()
  const routes = Object.keys(lock.routes)
  const priority = priorityRoutes(project)
  const evals = await statusOf(project)
  const ledger = readLedger(project.root)
  const tracks = tracksOf(config)
  const vantages = Object.keys(config.vantages)

  const surveyed = summariseTraffic(
    project,
    traffic,
    { sources: [], totals: { views: 0, entries: 0 }, routes: [], uncovered: [], regions: {} },
    true,
  )
  const uncoveredViews = surveyed.uncovered.reduce((a, u) => a + u.views, 0)
  const uncoveredShare = surveyed.totals.views ? uncoveredViews / surveyed.totals.views : 0
  const heavyRegions = Object.entries(config.regions)
    .filter(([, s]) => s >= 0.1)
    .map(([r]) => r)
  const coveredRegions = new Set(vantages.map((v) => config.vantages[v]?.region).filter(Boolean))

  const phases: Phase[] = []
  const phase = (p: Phase) => phases.push(p)

  const surveyChecks: Check[] = [
    {
      ok: traffic.length > 0,
      text: traffic.length ? `${traffic.length} traffic rows imported` : "no traffic data yet",
    },
    {
      ok: Object.keys(config.regions).length > 0,
      text: Object.keys(config.regions).length
        ? `regions: ${Object.entries(config.regions)
            .map(([r, s]) => `${r} ${Math.round(s * 100)}%`)
            .join(", ")}`
        : "no region mix recorded",
    },
  ]
  phase({
    id: "survey",
    title: "Find the routes and regions that matter",
    done: surveyChecks.every((c) => c.ok),
    checks: surveyChecks,
    next: [
      "write or enable a source in harness/sources/ (rename a _starter), or export analytics to CSV",
      "hch survey [--csv top-pages.csv] --regions",
    ],
  })

  const unsampled = priority.filter((p) => (lock.routes[p]?.samples.length ?? 0) === 0)
  const inventoryChecks: Check[] = [
    { ok: routes.length > 0, text: `${routes.length} routes in the inventory` },
    {
      ok: traffic.length === 0 || uncoveredShare < 0.05,
      text: traffic.length
        ? `${Math.round(uncoveredShare * 100)}% of views go to paths no route matches`
        : "no traffic to check coverage against",
    },
    {
      ok: unsampled.length === 0,
      text: unsampled.length
        ? `priority routes without a sample: ${unsampled.join(", ")}`
        : "every priority route has a sample",
    },
  ]
  phase({
    id: "inventory",
    title: "List every route, and how readers reach the important ones",
    done: inventoryChecks.every((c) => c.ok),
    checks: inventoryChecks,
    next: [
      "hch discover [--sitemap] [--next .next] [--traffic]",
      "hch route add <pattern> --sample <path>; hch case add <route> <id> --probe <probe> --condition k=v",
    ],
  })

  const currents = [...new Set(tracks.length ? tracks.map((t) => t.baseline) : [config.baseline])]
  const unprofiled: string[] = []
  const unlocked: string[] = []
  for (const pattern of priority) {
    for (const e of evals.filter((x) => currents.includes(x.target))) {
      const r = e.evaluation.routes.find((x) => x.route === pattern)
      if (!r || r.cases.some((c) => !c.observed))
        unprofiled.push(`${pattern} on ${e.target}/${e.vantage}`)
    }
    for (const [p, , caseId, def] of casesOf(lock))
      if (p === pattern && !def.expect) unlocked.push(`${p}#${caseId}`)
  }
  const missingRegions = heavyRegions.filter((r) => !coveredRegions.has(r))
  const profileChecks: Check[] = [
    {
      ok: unprofiled.length === 0,
      text: unprofiled.length
        ? `not measured yet: ${unprofiled.slice(0, 8).join(", ")}`
        : `every priority route measured on ${currents.join(" and ")}`,
    },
    {
      ok: missingRegions.length === 0,
      text: missingRegions.length
        ? `regions with readers but no vantage: ${missingRegions.join(", ")}`
        : "every region with 10% of readers has a vantage",
    },
    {
      ok: unlocked.length === 0,
      text: unlocked.length
        ? `${unlocked.length} priority cases unlocked`
        : `every priority case is locked from ${config.baseline}`,
    },
    {
      ok: ledger.findings.length > 0,
      text: `${ledger.findings.length} findings recorded about the stack`,
    },
  ]
  phase({
    id: "profile",
    title: `Benchmark the current site on every track: ${currents.join(", ")}`,
    done: profileChecks.slice(0, 3).every((c) => c.ok),
    checks: profileChecks,
    next: [
      `hch run ${currents.map((t) => `--target ${t}`).join(" ")}`,
      "hch lock --from " + config.baseline,
      'hch note "<what you learned about how this stack caches, renders or counts>" --route <route>',
    ],
  })

  for (const track of tracks) {
    const fails: string[] = []
    const measured = evals.filter(
      (x) =>
        x.target === track.port && x.evaluation.routes.some((r) => r.cases.some((c) => c.observed)),
    )
    for (const e of measured) {
      for (const pattern of priority) {
        const r = e.evaluation.routes.find((x) => x.route === pattern)
        if (!r || r.state === "fail" || r.state === "unknown")
          fails.push(`${pattern} from ${e.vantage}`)
      }
    }
    phase({
      id: `parity:${track.name}`,
      title: `${track.name}: bring ${track.port} up to ${track.baseline}`,
      done: measured.length > 0 && fails.length === 0,
      checks: [
        {
          ok: measured.length > 0,
          text: measured.length
            ? `${track.port} measured from ${measured.map((e) => e.vantage).join(", ")}`
            : `${track.port} not measured yet`,
        },
        {
          ok: measured.length > 0 && fails.length === 0,
          text: fails.length
            ? `${fails.length} priority routes failing or unmeasured: ${fails.slice(0, 8).join(", ")}`
            : measured.length
              ? `every priority route passes or warns against ${track.baseline}`
              : `priority routes not compared with ${track.baseline} yet`,
        },
      ],
      next: [
        `hch run --target ${track.baseline} --target ${track.port}`,
        `hch status --target ${track.port}`,
        "hch show <route>",
      ],
    })
  }

  const open = ledger.experiments.filter((x) => !x.decision)
  const ports = new Set(tracks.map((t) => t.port))
  const warns = evals
    .filter((e) => ports.has(e.target))
    .flatMap((e) =>
      e.evaluation.routes
        .filter((r) => priority.includes(r.route) && r.state === "warn")
        .map((r) => `${r.route} on ${e.target}/${e.vantage}`),
    )
  const carryBack = [
    ...new Set(
      evals
        .filter((e) => !ports.has(e.target))
        .flatMap((e) =>
          e.evaluation.routes.flatMap((r) =>
            r.cases
              .filter((c) => c.perf.note?.includes("carry it back"))
              .map((c) => `${c.key} to ${e.target} from ${c.perf.against}`),
          ),
        ),
    ),
  ]
  phase({
    id: "improve",
    title: "Experiment on the routes that are slower than they should be",
    done: open.length === 0 && warns.length === 0,
    checks: [
      {
        ok: open.length === 0,
        text: open.length
          ? `undecided experiments: ${open.map((x) => x.id).join(", ")}`
          : "no undecided experiments",
      },
      {
        ok: warns.length === 0,
        text: warns.length
          ? `warnings on priority routes: ${warns.slice(0, 8).join(", ")}`
          : "no warnings on the port's priority routes",
      },
      ...(carryBack.length
        ? [
            {
              ok: false,
              note: true,
              text: `the port is faster, worth carrying back: ${carryBack.slice(0, 6).join(", ")}`,
            },
          ]
        : []),
      {
        ok: true,
        text: `${ledger.experiments.filter((x) => x.decision?.verdict === "keep").length} kept, ${ledger.experiments.filter((x) => x.decision?.verdict === "discard").length} discarded`,
      },
    ],
    next: [
      'hch experiment start "<theory>" --route <route>',
      "hch experiment measure <id>",
      'hch experiment decide <id> keep|discard --why "…"',
    ],
  })

  const ready = readiness(project, evals, priority)
  phase({
    id: "launch",
    title: `Switch over${ready.track ? `: ${ready.track}` : ""}`,
    done: ready.score >= 1,
    checks: Object.entries(ready.byTarget)
      .filter(([t]) => t === tracks.at(-1)?.port)
      .map(([t, s]) => ({
        ok: s >= 1,
        text: `${t}: ${Math.round(s * 100)}% of priority traffic, weighted by region, passes`,
      })),
    next: ["hch status --gate"],
  })

  // A phase is done only once every phase before it is: with no routes yet, "every priority route
  // passes" is true of nothing and must not read as progress.
  let before = true
  for (const p of phases) {
    if (p.id !== "survey" && p.id !== "inventory" && priority.length === 0) p.done = false
    p.done = before && p.done
    before = p.done
  }
  const current = phases.find((p) => !p.done)?.id ?? "launch"
  return { phase: current, priority, readiness: ready, phases }
}
