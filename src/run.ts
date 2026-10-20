import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { arch, cpus, platform, release } from "node:os"
import { classify, type Exchange } from "./cache.ts"
import { expandHeaders } from "./config.ts"
import type { Observation } from "./db.ts"
import { matchPattern } from "./patterns.ts"
import { requestsOf, type CaseRequest, type Project } from "./project.ts"
import { normalise } from "./record.ts"

export type BatchOptions = {
  targets: string[]
  label?: string
  note?: string
  routes?: (pattern: string) => boolean
  repeats?: number
  concurrency?: number
  onObservation?: (o: Observation, target: string, done: number, total: number) => void
}

export type RunOptions = Omit<BatchOptions, "targets" | "onObservation"> & {
  target: string
  onObservation?: (o: Observation, done: number, total: number) => void
}

type Probed = {
  status: number
  headers: Record<string, string>
  body: string
  ttfb: number
  total: number
  bytes: number
}

async function request(
  url: URL,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Probed> {
  const t0 = performance.now()
  // redirect: "manual" on every request, or a 301 → 200 chain reads as a 200 and every redirect
  // the site promises stops being checked.
  const res = await fetch(url, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  })
  const ttfb = performance.now() - t0
  const buffer = Buffer.from(await res.arrayBuffer())
  const total = performance.now() - t0
  return {
    status: res.status,
    headers: Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v])),
    body: buffer.toString("utf8"),
    ttfb,
    total,
    bytes: buffer.length,
  }
}

async function inPool<T>(items: T[], size: number, task: (item: T) => Promise<void>) {
  let next = 0
  const worker = async () => {
    while (next < items.length) await task(items[next++] as T)
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker))
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

const errorText = (error: unknown) =>
  error instanceof Error
    ? ((error.cause as Error | undefined)?.message ?? error.message)
    : String(error)

type Side = { name: string; url: string; headers: Record<string, string>; runId: number }

type Collected = { responses: Probed[]; exchanges: Exchange[]; error?: string }

function observation(
  project: Project,
  side: Side,
  req: CaseRequest,
  got: Collected,
): Omit<Observation, "id"> {
  const base = {
    runId: side.runId,
    route: req.route,
    caseId: req.caseId,
    sample: req.sample,
    path: req.path,
  }
  const ttfb = got.responses.map((r) => Math.round(r.ttfb * 10) / 10)
  const total = got.responses.map((r) => Math.round(r.total * 10) / 10)
  const first = got.responses[0]
  if (got.error || !first) {
    return {
      ...base,
      status: first?.status ?? null,
      record: null,
      cache: "unknown",
      cacheSignal: "request failed",
      ttfb,
      total,
      bytes: first?.bytes ?? null,
      error: got.error ?? "no response",
    }
  }
  const { probe } = project.config
  const record = normalise(first.status, first.headers, first.body, {
    baseURL: side.url,
    params: matchPattern(req.route, req.sample) ?? {},
    headers: probe.headers,
    htmlCacheControl: probe.htmlCacheControl,
  })
  const { cache, signal } = classify(got.exchanges)
  return {
    ...base,
    status: first.status,
    record,
    cache,
    cacheSignal: signal,
    ttfb,
    total,
    bytes: first.bytes,
    error: null,
  }
}

// Targets are interleaved request by request, never run one after the other: the timing verdict
// compares targets within a batch, which only holds when they shared the machine and the network.
export async function runBatch(project: Project, opts: BatchOptions) {
  const { config, store } = project
  if (opts.targets.length === 0) throw new Error("No targets to run")
  const repeats = opts.repeats ?? config.probe.repeats
  const concurrency = opts.concurrency ?? config.probe.concurrency
  const requests = requestsOf(project.lock, opts.routes)
  const missingHeaders: Record<string, string[]> = {}
  const machine = JSON.stringify({
    os: `${platform()} ${release()} ${arch()}`,
    cpu: cpus()[0]?.model,
    node: process.version,
  })
  const sha = gitSha(project.root)

  let batch: number | null = null
  const sides: Side[] = opts.targets.map((name) => {
    const target = config.targets[name]
    if (!target)
      throw new Error(`No target "${name}". Targets: ${Object.keys(config.targets).join(", ")}`)
    const { headers, missing } = expandHeaders(target.headers)
    if (missing.length) missingHeaders[name] = missing
    const runId = store.startRun({
      target: name,
      label: opts.label ?? null,
      url: target.url,
      startedAt: new Date().toISOString(),
      gitSha: sha,
      note: opts.note ?? null,
      machine,
      settings: JSON.stringify({
        repeats,
        concurrency,
        targets: opts.targets,
        missingHeaders: missing,
      }),
      batch,
    })
    batch ??= runId
    if (batch === runId) store.setBatch(runId, batch)
    return { name, url: target.url, headers, runId }
  })

  const stampRegex = config.probe.renderStamp ? new RegExp(config.probe.renderStamp) : undefined
  const total = requests.length * sides.length
  let done = 0
  const observations: Observation[] = []

  await inPool(requests, concurrency, async (req) => {
    const got = new Map<string, Collected>(
      sides.map((s) => [s.name, { responses: [], exchanges: [] }]),
    )
    for (let i = 0; i < repeats; i++) {
      // Alternate who goes first, so neither side always meets a connection the other just warmed.
      const order = i % 2 === 0 ? sides : [...sides].reverse()
      for (const side of order) {
        const into = got.get(side.name) as Collected
        if (into.error) continue
        try {
          const res = await request(
            new URL(req.path, side.url),
            { ...side.headers, ...req.headers },
            config.probe.timeoutMs,
          )
          into.responses.push(res)
          into.exchanges.push({
            headers: res.headers,
            bodyHash: createHash("sha1").update(res.body).digest("hex"),
            stamp: stampRegex?.exec(res.body)?.[1],
          })
        } catch (error) {
          into.error = errorText(error)
        }
      }
    }
    for (const side of sides) {
      const o = observation(project, side, req, got.get(side.name) as Collected)
      const stored: Observation = { ...o, id: store.addObservation(o) }
      observations.push(stored)
      done++
      opts.onObservation?.(stored, side.name, done, total)
    }
  })

  for (const side of sides) store.finishRun(side.runId)
  return {
    batch: (sides[0] as Side).runId,
    runs: sides.map((s) => ({ target: s.name, runId: s.runId })),
    observations,
    missingHeaders,
  }
}

export async function runTarget(project: Project, opts: RunOptions) {
  const { target, onObservation, ...rest } = opts
  const result = await runBatch(project, {
    ...rest,
    targets: [target],
    onObservation: onObservation ? (o, _, done, total) => onObservation(o, done, total) : undefined,
  })
  return {
    runId: result.runs[0]!.runId,
    observations: result.observations,
    missingHeaders: result.missingHeaders[target] ?? [],
  }
}
