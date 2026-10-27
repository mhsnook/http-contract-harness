import type { Browser } from "playwright-core"
import { matchPattern } from "./patterns.ts"
import {
  contextFor,
  type ContextInput,
  type LoadedProbe,
  type ProbeSample,
  type ProbeTarget,
} from "./probe.ts"
import type { RecordOptions, ResponseRecord } from "./record.ts"

export type EngineRequest = {
  route: string
  caseId: string
  sample: string
  path: string
  headers: Record<string, string>
  probe: string
  conditions: Record<string, unknown>
}

export type EngineVantage = {
  name: string
  region?: string
  browser: { executablePath?: string; cdp?: string }
}

export type EngineSpec = {
  targets: ProbeTarget[]
  requests: EngineRequest[]
  probes: Map<string, LoadedProbe>
  repeats?: number
  defaultRepeats: number
  concurrency: number
  timeoutMs: number
  record: Omit<RecordOptions, "baseURL" | "params">
  vantage: EngineVantage
  cwd: string
}

export type EngineResult = {
  target: string
  request: EngineRequest
  probe: string
  probeHash: string
  status: number | null
  record: ResponseRecord | null
  primary: number[]
  metrics: Record<string, number[]>
  served: string | null
  skipped: string[]
  note: string | null
  error: string | null
}

export async function openBrowser(browser: EngineVantage["browser"]): Promise<Browser> {
  let playwright: typeof import("playwright-core")
  try {
    playwright = await import("playwright-core")
  } catch {
    throw new Error("A probe asked for a browser: install playwright-core next to the harness")
  }
  if (browser.cdp) return playwright.chromium.connectOverCDP(browser.cdp)
  return playwright.chromium.launch({
    executablePath: browser.executablePath ?? process.env.HARNESS_CHROMIUM,
  })
}

const round = (n: number) => Math.round(n * 10) / 10

const errorText = (error: unknown) =>
  error instanceof Error
    ? ((error.cause as Error | undefined)?.message ?? error.message)
    : String(error)

function majority<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
}

async function inPool<T>(items: T[], size: number, task: (item: T) => Promise<void>) {
  let next = 0
  const worker = async () => {
    while (next < items.length) await task(items[next++] as T)
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker))
}

// Targets are interleaved repeat by repeat, never run one after the other: verdicts compare
// targets within a batch, which only holds when they shared the machine and the network.
export async function runEngine(
  spec: EngineSpec,
  onResult: (result: EngineResult) => void | Promise<void>,
): Promise<void> {
  let browser: Promise<Browser> | undefined
  const getBrowser = () => (browser ??= openBrowser(spec.vantage.browser))

  const measure = async (request: EngineRequest) => {
    const probe = spec.probes.get(request.probe)
    const failAll = async (error: string) => {
      for (const target of spec.targets) {
        await onResult({
          target: target.name,
          request,
          probe: request.probe,
          probeHash: probe?.hash ?? "",
          status: null,
          record: null,
          primary: [],
          metrics: {},
          served: null,
          skipped: [],
          note: null,
          error,
        })
      }
    }
    if (!probe) return failAll(`no probe named "${request.probe}" in the probes directory`)
    const repeats = spec.repeats ?? probe.repeats ?? spec.defaultRepeats
    const params = matchPattern(request.route, request.sample) ?? {}
    const sides = spec.targets.map((target) => {
      const input: ContextInput = {
        target,
        route: request.route,
        sample: request.sample,
        path: request.path,
        params,
        conditions: request.conditions,
        headers: request.headers,
        vantage: { name: spec.vantage.name, region: spec.vantage.region },
        state: {},
        record: spec.record,
        timeoutMs: spec.timeoutMs,
        cwd: spec.cwd,
        browser: getBrowser,
        log: (message) => console.error(`[${target.name} ${request.path}] ${message}`),
      }
      return { target, input, samples: [] as ProbeSample[], error: undefined as string | undefined }
    })

    for (let i = 0; i < repeats; i++) {
      // Alternate who goes first, so neither side always meets a connection the other just warmed.
      const order = i % 2 === 0 ? sides : [...sides].reverse()
      for (const side of order) {
        if (side.error) continue
        const ctx = contextFor(side.input, i)
        try {
          await probe.prepare?.(ctx)
          side.samples.push(await probe.measure(ctx))
        } catch (error) {
          side.error = errorText(error)
        }
      }
    }

    for (const side of sides) {
      const counted = side.samples.filter((s) => !s.skip && !s.warmup)
      const metrics: Record<string, number[]> = {}
      for (const s of counted) {
        for (const [name, value] of Object.entries(s.metrics)) {
          if (Number.isFinite(value)) (metrics[name] ??= []).push(round(value))
        }
      }
      let record: ResponseRecord | null = side.samples.find((s) => s.record)?.record ?? null
      let note: string | null = null
      let error = side.error ?? null
      if (!error && probe.summarise) {
        try {
          const summary = probe.summarise(
            side.samples.filter((s) => !s.skip),
            contextFor(side.input, repeats),
          )
          if (summary?.record) record = { ...(record ?? {}), ...summary.record }
          note = summary?.note ?? null
        } catch (e) {
          error = `summarise: ${errorText(e)}`
        }
      }
      const skipped = side.samples.flatMap((s) => (s.skip ? [s.skip] : []))
      if (!error && counted.length === 0) {
        error = skipped.length ? `no repeat counted: ${skipped[0]}` : "no repeat counted"
      }
      await onResult({
        target: side.target.name,
        request,
        probe: probe.name,
        probeHash: probe.hash,
        status: typeof record?.["status"] === "number" ? (record["status"] as number) : null,
        record,
        primary: metrics[probe.primary] ?? [],
        metrics,
        served: majority(counted.flatMap((s) => (s.served ? [s.served] : []))) ?? null,
        skipped,
        note,
        error,
      })
    }
  }

  const sequential = (r: EngineRequest) => spec.probes.get(r.probe)?.sequential === true
  try {
    await inPool(
      spec.requests.filter((r) => !sequential(r)),
      spec.concurrency,
      measure,
    )
    // One at a time: two browsers competing for the CPU measure the contest, not the sites.
    for (const request of spec.requests.filter(sequential)) await measure(request)
  } finally {
    if (browser) await (await browser.catch(() => undefined))?.close()
  }
}
