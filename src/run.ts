import { execFileSync } from "node:child_process"
import { arch, cpus, platform, release } from "node:os"
import { expandHeaders, reachableFrom } from "./config.ts"
import type { Observation } from "./db.ts"
import { runEngine, type EngineResult, type EngineSpec } from "./engine.ts"
import type { ProbeTarget } from "./probe.ts"
import { requestsOf, type Project } from "./project.ts"
import { runRemote, type RunnerPayload } from "./runner.ts"

export type BatchOptions = {
  targets: string[]
  vantages?: string[]
  label?: string
  note?: string
  routes?: (pattern: string) => boolean
  repeats?: number
  concurrency?: number
  onObservation?: (o: Observation, done: number, total: number) => void
}

export type BatchResult = {
  batches: {
    vantage: string
    batch: number
    region: string | null
    runs: { target: string; runId: number }[]
  }[]
  observations: Observation[]
  missingHeaders: Record<string, string[]>
}

function gitSha(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return null
  }
}

/**
 * One batch per vantage, all targets interleaved within each. Vantages run at the same time:
 * they are separate machines, and a batch is only ever compared with itself.
 */
export async function runBatch(project: Project, opts: BatchOptions): Promise<BatchResult> {
  const { config, store } = project
  if (opts.targets.length === 0) throw new Error("No targets to run")
  const vantages = opts.vantages?.length ? opts.vantages : Object.keys(config.vantages)
  for (const v of vantages) {
    if (!config.vantages[v]) {
      throw new Error(`No vantage "${v}". Vantages: ${Object.keys(config.vantages).join(", ")}`)
    }
  }
  const probes = await project.probes()
  const requests = requestsOf(config, project.lock, opts.routes)
  const used = new Set(requests.map((r) => r.probe))
  const missingHeaders: Record<string, string[]> = {}
  const targets: ProbeTarget[] = opts.targets.map((name) => {
    const t = config.targets[name]
    if (!t)
      throw new Error(`No target "${name}". Targets: ${Object.keys(config.targets).join(", ")}`)
    const headers = expandHeaders(t.headers)
    const cookies = expandHeaders(t.cookies)
    const missing = [...headers.missing, ...cookies.missing]
    if (missing.length) missingHeaders[name] = missing
    // expandHeaders lower-cases names, which cookie names must not be.
    const cookieValues = Object.fromEntries(
      Object.keys(t.cookies ?? {}).flatMap((k) => {
        const v = cookies.headers[k.toLowerCase()]
        return v === undefined ? [] : [[k, v]]
      }),
    )
    return { name, url: t.url, headers: headers.headers, cookies: cookieValues, options: t.options }
  })
  const machine = JSON.stringify({
    os: `${platform()} ${release()} ${arch()}`,
    cpu: cpus()[0]?.model,
    node: process.version,
  })
  const sha = gitSha(project.root)
  const total =
    requests.length *
    vantages.reduce((n, v) => n + targets.filter((t) => reachableFrom(config, t.name, v)).length, 0)
  let done = 0
  const observations: Observation[] = []

  const one = async (vantageName: string) => {
    const vantage = config.vantages[vantageName]!
    const here = targets.filter((t) => reachableFrom(config, t.name, vantageName))
    if (here.length === 0) return undefined
    let batch: number | null = null
    const runs = here.map((t) => {
      const runId = store.startRun({
        target: t.name,
        vantage: vantageName,
        region: vantage.region ?? null,
        label: opts.label ?? null,
        url: t.url,
        startedAt: new Date().toISOString(),
        gitSha: sha,
        note: opts.note ?? null,
        machine: vantage.url ? JSON.stringify({ runner: vantage.url }) : machine,
        settings: JSON.stringify({
          repeats: opts.repeats ?? null,
          targets: opts.targets,
          probes: Object.fromEntries([...used].map((p) => [p, probes.get(p)?.hash ?? null])),
        }),
        batch,
      })
      batch ??= runId
      if (batch === runId) store.setBatch(runId, batch)
      return { target: t.name, runId }
    })
    const runOf = new Map(runs.map((r) => [r.target, r.runId]))
    const store1 = (result: EngineResult) => {
      const o: Omit<Observation, "id"> = {
        runId: runOf.get(result.target)!,
        route: result.request.route,
        caseId: result.request.caseId,
        sample: result.request.sample,
        path: result.request.path,
        probe: result.probe,
        probeHash: result.probeHash,
        status: result.status,
        record: result.record,
        primary: result.primary,
        metrics: result.metrics,
        served: result.served,
        skipped: result.skipped,
        note: result.note,
        error: result.error,
      }
      const stored: Observation = {
        ...o,
        id: store.addObservation(o),
        target: result.target,
        vantage: vantageName,
        region: vantage.region ?? null,
        batch,
      }
      observations.push(stored)
      done++
      opts.onObservation?.(stored, done, total)
    }
    const common = {
      requests,
      repeats: opts.repeats,
      defaultRepeats: config.run.repeats,
      concurrency: opts.concurrency ?? config.run.concurrency,
      timeoutMs: config.run.timeoutMs,
      record: config.record,
    }
    let region = vantage.region ?? null
    try {
      if (vantage.url) {
        const payload: RunnerPayload = {
          ...common,
          vantage: vantageName,
          targets: here,
          probes: [...used].flatMap((name) => {
            const p = probes.get(name)
            return p ? [{ name, hash: p.hash, bundle: p.bundle }] : []
          }),
        }
        const token = vantage.token ? expandHeaders({ t: vantage.token }).headers["t"] : undefined
        const answer = await runRemote({ url: vantage.url, token }, payload, store1)
        region = answer.region ?? region
      } else {
        const spec: EngineSpec = {
          ...common,
          targets: here,
          probes,
          vantage: { name: vantageName, region: vantage.region, browser: vantage.browser },
          cwd: project.root,
        }
        await runEngine(spec, store1)
      }
    } finally {
      for (const r of runs) store.finishRun(r.runId)
    }
    return { vantage: vantageName, batch: runs[0]!.runId, region, runs }
  }

  const batches = (await Promise.all(vantages.map(one))).filter((b) => b !== undefined)
  return { batches, observations, missingHeaders }
}
