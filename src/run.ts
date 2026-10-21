import { execFile, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { arch, cpus, platform, release } from "node:os"
import { promisify } from "node:util"
import type { Browser } from "playwright-core"
import { measureInBrowser, openBrowser, type Measured } from "./browser.ts"
import { classify, hintOf, type CacheClass, type Exchange } from "./cache.ts"
import { BROWSER_DIRECTIONS, expandHeaders, type Direction, type Target } from "./config.ts"
import type { Observation } from "./db.ts"
import { matchPattern } from "./patterns.ts"
import { requestsOf, type CaseRequest, type Project } from "./project.ts"
import { normalise, type ResponseRecord } from "./record.ts"
import { runScene } from "./scene.ts"

const run = promisify(execFile)

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

const round = (n: number) => Math.round(n * 10) / 10

type Side = {
  name: string
  url: string
  headers: Record<string, string>
  runId: number
  target: Target
}

/** One target's samples of one case, as they arrive. */
type Collected = {
  first?: Probed
  primary: number[]
  metrics: Record<string, number[]>
  exchanges: Exchange[]
  validators?: Record<string, string>
  cold: { verified: number; refused: number; unverified: number }
  statuses: number[]
  hintHeaders: Record<string, string>[]
  error?: string
}

const fresh = (): Collected => ({
  primary: [],
  metrics: {},
  exchanges: [],
  cold: { verified: 0, refused: 0, unverified: 0 },
  statuses: [],
  hintHeaders: [],
})

function push(into: Collected, primary: number, metrics: Record<string, number>) {
  into.primary.push(round(primary))
  for (const [name, value] of Object.entries(metrics)) {
    ;(into.metrics[name] ??= []).push(round(value))
  }
}

type Context = {
  project: Project
  userAgent?: string
  stamp?: RegExp
  browser?: () => Promise<Browser>
}

async function httpSample(ctx: Context, side: Side, req: CaseRequest, into: Collected) {
  const { config } = ctx.project
  const direction = req.def.direction ?? "hit"
  const url = new URL(req.path, side.url)
  const headers = {
    ...(ctx.userAgent ? { "user-agent": ctx.userAgent } : {}),
    ...side.headers,
    ...req.headers,
  }

  if (direction === "revalidate" && !into.validators) {
    const primed = await request(url, headers, config.probe.timeoutMs)
    into.validators = {}
    if (primed.headers["etag"]) into.validators["if-none-match"] = primed.headers["etag"]
    if (primed.headers["last-modified"]) {
      into.validators["if-modified-since"] = primed.headers["last-modified"]
    }
    if (Object.keys(into.validators).length === 0) {
      throw new Error("no ETag or Last-Modified to revalidate with")
    }
  }
  if (direction === "cold") {
    if (!side.target.purge) throw new Error(`target ${side.name} has no purge command`)
    await run("sh", ["-c", side.target.purge], {
      cwd: ctx.project.root,
      env: {
        ...process.env,
        PORTSIDE_URL: url.href,
        PORTSIDE_PATH: req.path,
        PORTSIDE_TARGET: side.name,
      },
    })
  }

  const res = await request(
    url,
    direction === "revalidate" ? { ...headers, ...into.validators } : headers,
    config.probe.timeoutMs,
  )
  into.first ??= res
  into.exchanges.push({
    headers: res.headers,
    bodyHash: createHash("sha1").update(res.body).digest("hex"),
    stamp: ctx.stamp?.exec(res.body)?.[1],
  })

  if (direction === "cold") {
    // A purge that did not take leaves a cached answer, which says nothing about a cold render.
    const { hint } = hintOf(res.headers)
    if (hint === "hit") {
      into.cold.refused++
      return
    }
    if (hint) into.cold.verified++
    else into.cold.unverified++
  }
  push(into, res.ttfb, { ttfb: res.ttfb, total: res.total })
}

async function otherSample(ctx: Context, side: Side, req: CaseRequest, into: Collected) {
  const { config, root } = ctx.project
  const direction = req.def.direction as Direction
  let measured: Measured
  if (direction === "scene") {
    const scene = req.def.scene ? config.scenes[req.def.scene] : undefined
    if (!scene) throw new Error(`no scene named "${req.def.scene ?? ""}" in the config`)
    measured = await runScene(scene, { baseURL: side.url, target: side.name, path: req.path }, root)
  } else {
    const browser = await (ctx.browser as () => Promise<Browser>)()
    measured = await measureInBrowser(
      browser,
      { url: side.url, headers: side.headers, cookies: side.target.cookies },
      req.path,
      req.def,
      config,
    )
  }
  if (measured.status !== undefined) into.statuses.push(measured.status)
  if (measured.headers) into.hintHeaders.push(measured.headers)
  push(into, measured.primary, measured.metrics)
}

function majority(values: number[]): number | undefined {
  const counts = new Map<number, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
}

function observation(
  project: Project,
  side: Side,
  req: CaseRequest,
  got: Collected,
): Omit<Observation, "id" | "target" | "batch"> {
  const direction = req.def.direction ?? "hit"
  const base = {
    runId: side.runId,
    route: req.route,
    caseId: req.caseId,
    sample: req.sample,
    path: req.path,
    direction,
    metrics: got.metrics,
    ttfb: got.primary,
    total: got.metrics["total"] ?? [],
  }
  const failed = (error: string) => ({
    ...base,
    status: got.first?.status ?? null,
    record: null,
    cache: "unknown" as CacheClass,
    cacheSignal: "request failed",
    bytes: got.first?.bytes ?? null,
    error,
  })
  if (got.error) return failed(got.error)

  if (direction === "scene" || BROWSER_DIRECTIONS.includes(direction)) {
    if (got.primary.length === 0) return failed("no samples")
    const status = majority(got.statuses)
    const hints = got.hintHeaders.map((h) => hintOf(h).hint).filter(Boolean)
    const hits = hints.filter((h) => h === "hit").length
    const cache: CacheClass =
      hints.length === 0 ? "unknown" : hits * 2 >= hints.length ? "cached" : "uncached"
    const record: ResponseRecord = status === undefined ? {} : { status }
    return {
      ...base,
      status: status ?? null,
      record,
      cache,
      cacheSignal: hints.length
        ? `${hits} of ${hints.length} answers were hits`
        : "no cache header",
      bytes: null,
      error: null,
    }
  }

  const first = got.first
  if (!first) return failed("no response")
  const { probe } = project.config
  const record = normalise(first.status, first.headers, first.body, {
    baseURL: side.url,
    params: matchPattern(req.route, req.sample) ?? {},
    headers: probe.headers,
    htmlCacheControl: probe.htmlCacheControl,
  })
  if (direction === "cold") {
    const { verified, refused, unverified } = got.cold
    if (got.primary.length === 0)
      return failed(`the purge never took: ${refused} answers were hits`)
    return {
      ...base,
      status: first.status,
      record,
      cache: "unknown",
      cacheSignal: `cold: ${verified} misses confirmed, ${unverified} with no cache header, ${refused} purges that did not take`,
      bytes: first.bytes,
      error: null,
    }
  }
  if (direction === "revalidate") {
    return {
      ...base,
      status: first.status,
      record,
      cache: "unknown",
      cacheSignal:
        first.status === 304
          ? "revalidated: 304 Not Modified"
          : `revalidation answered ${first.status}`,
      bytes: first.bytes,
      error: null,
    }
  }
  const { cache, signal } = classify(got.exchanges)
  return {
    ...base,
    status: first.status,
    record,
    cache,
    cacheSignal: signal,
    bytes: first.bytes,
    error: null,
  }
}

// Targets are interleaved sample by sample, never run one after the other: the timing verdict
// compares targets within a batch, which only holds when they shared the machine and the network.
export async function runBatch(project: Project, opts: BatchOptions) {
  const { config, store } = project
  if (opts.targets.length === 0) throw new Error("No targets to run")
  const httpRepeats = opts.repeats ?? config.probe.repeats
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
        repeats: httpRepeats,
        concurrency,
        targets: opts.targets,
        missingHeaders: missing,
      }),
      batch,
    })
    batch ??= runId
    if (batch === runId) store.setBatch(runId, batch)
    return { name, url: target.url, headers, runId, target }
  })

  let browser: Promise<Browser> | undefined
  const ctx: Context = {
    project,
    userAgent: config.probe.userAgent,
    stamp: config.probe.renderStamp ? new RegExp(config.probe.renderStamp) : undefined,
    browser: () => (browser ??= openBrowser(config)),
  }
  const total = requests.length * sides.length
  let done = 0
  const observations: Observation[] = []

  const measure = async (req: CaseRequest) => {
    const direction = req.def.direction ?? "hit"
    const http = direction === "hit" || direction === "revalidate" || direction === "cold"
    const repeats =
      opts.repeats ??
      (direction === "scene"
        ? (config.scenes[req.def.scene ?? ""]?.repeats ?? 3)
        : http
          ? httpRepeats
          : config.browser.repeats)
    const got = new Map<string, Collected>(sides.map((s) => [s.name, fresh()]))
    for (let i = 0; i < repeats; i++) {
      // Alternate who goes first, so neither side always meets a connection the other just warmed.
      const order = i % 2 === 0 ? sides : [...sides].reverse()
      for (const side of order) {
        const into = got.get(side.name) as Collected
        if (into.error) continue
        try {
          if (http) await httpSample(ctx, side, req, into)
          else await otherSample(ctx, side, req, into)
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
  }

  const isHttp = (r: CaseRequest) =>
    ["hit", "revalidate", "cold", undefined].includes(r.def.direction)
  try {
    await inPool(requests.filter(isHttp), concurrency, measure)
    // One at a time: a browser or a scene competing with another for the CPU measures the contest.
    for (const req of requests.filter((r) => !isHttp(r))) await measure(req)
  } finally {
    if (browser) await (await browser.catch(() => undefined))?.close()
  }

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
