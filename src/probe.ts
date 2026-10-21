import { exec as execCallback } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, posix, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import type { Browser } from "playwright-core"
import { classify, hintOf, type Exchange } from "./cache.ts"
import type { FieldSpec } from "./config.ts"
import { normalise, type RecordOptions, type ResponseRecord } from "./record.ts"

const execAsync = promisify(execCallback)

export type HttpResult = {
  url: string
  status: number
  headers: Record<string, string>
  body: string
  bodyHash: string
  ttfb: number
  total: number
  bytes: number
}

export type ProbeTarget = {
  name: string
  url: string
  headers: Record<string, string>
  cookies: Record<string, string>
  options: Record<string, unknown>
}

export type ProbeContext = {
  target: ProbeTarget
  route: string
  sample: string
  path: string
  params: Record<string, string>
  conditions: Record<string, unknown>
  headers: Record<string, string>
  repeat: number
  vantage: { name: string; region?: string }
  // Kept for this target, case and sample across the repeats of one batch.
  state: Record<string, unknown>
  request(
    path: string,
    init?: { headers?: Record<string, string>; method?: string },
  ): Promise<HttpResult>
  browser(): Promise<Browser>
  exec(command: string, env?: Record<string, string>): Promise<{ stdout: string; stderr: string }>
  record(res: HttpResult): ResponseRecord
  cacheHint(headers: Record<string, string>): { hint?: "hit" | "miss" | "bypass"; header?: string }
  classify(exchanges: Exchange[]): { cache: "cached" | "uncached" | "unknown"; signal: string }
  servedFrom(headers: Record<string, string>): string | undefined
  log(message: string): void
}

export type ProbeSample = {
  metrics: Record<string, number>
  record?: ResponseRecord
  served?: string
  // This repeat does not count, and why: a purge that did not take, a page that never hydrated.
  skip?: string
  // Not timed but kept for summarise, such as the request that filled a cache.
  warmup?: boolean
  evidence?: Record<string, unknown>
}

export type Probe = {
  describe: string
  primary: string
  repeats?: number
  // Run this probe's cases one at a time rather than in the concurrency pool, as a browser needs.
  sequential?: boolean
  fields?: Record<string, FieldSpec>
  prepare?(ctx: ProbeContext): Promise<void>
  measure(ctx: ProbeContext): Promise<ProbeSample>
  summarise?(
    samples: ProbeSample[],
    ctx: ProbeContext,
  ): { record?: ResponseRecord; note?: string } | undefined
}

export const hashOf = (source: string) =>
  createHash("sha256").update(source).digest("hex").slice(0, 12)

// A probe's files: the module itself and every local module it imports, by path relative to the
// probes directory. The hash covers all of them, so editing a shared helper is a new version of
// every probe that uses it.
export type ProbeBundle = { entry: string; files: Record<string, string> }

export type LoadedProbe = Probe & { name: string; hash: string; bundle: ProbeBundle }

const LOCAL_IMPORT =
  /(?:import|export)\s[^"']*?from\s*["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g

export function bundleOf(dir: string, entry: string): ProbeBundle {
  const files: Record<string, string> = {}
  const visit = (rel: string) => {
    const normal = posix.normalize(rel)
    if (normal.startsWith(".."))
      throw new Error(`${entry} imports ${rel}, outside the probes directory`)
    if (files[normal] !== undefined) return
    const source = readFileSync(join(dir, normal), "utf8")
    files[normal] = source
    for (const m of source.matchAll(LOCAL_IMPORT)) {
      visit(posix.join(posix.dirname(normal), (m[1] ?? m[2]) as string))
    }
  }
  visit(entry)
  return { entry: posix.normalize(entry), files }
}

export const hashBundle = (bundle: ProbeBundle) =>
  hashOf(
    JSON.stringify([
      bundle.entry,
      ...Object.entries(bundle.files).sort(([a], [b]) => a.localeCompare(b)),
    ]),
  )

function check(name: string, mod: Partial<Probe>, file: string): Probe {
  if (typeof mod.measure !== "function") throw new Error(`${file}: a probe exports measure(ctx)`)
  if (typeof mod.primary !== "string") {
    throw new Error(`${file}: a probe exports primary, the metric the verdict reads`)
  }
  return { describe: name, ...mod } as Probe
}

// The hash goes on the import URL: Node caches modules by URL, so a probe edited during a long
// `serve` would otherwise keep running its old code.
async function importEntry(name: string, file: string, bundle: ProbeBundle, hash: string) {
  const mod = await import(`${pathToFileURL(file).href}?v=${hash}`)
  return { ...check(name, mod.default ?? mod, file), name, hash, bundle } satisfies LoadedProbe
}

// Files starting with `_` are helpers for other probes, never probes themselves.
export async function loadProbes(dir: string): Promise<Map<string, LoadedProbe>> {
  const probes = new Map<string, LoadedProbe>()
  const root = resolve(dir)
  if (!existsSync(root)) return probes
  for (const entry of readdirSync(root).sort()) {
    const match = /^([^_].*)\.(mjs|js)$/.exec(entry)
    if (!match) continue
    const bundle = bundleOf(root, entry)
    probes.set(
      match[1] as string,
      await importEntry(match[1] as string, join(root, entry), bundle, hashBundle(bundle)),
    )
  }
  return probes
}

/** A probe sent by a client to a runner, written out and checked against the hash it came with. */
export async function probeFromBundle(name: string, bundle: ProbeBundle, hash: string) {
  if (hashBundle(bundle) !== hash) throw new Error(`probe ${name} does not match its hash`)
  const dir = join(tmpdir(), "portside-probes", hash)
  for (const [rel, source] of Object.entries(bundle.files)) {
    const file = join(dir, rel)
    mkdirSync(dirname(file), { recursive: true })
    if (!existsSync(file)) writeFileSync(file, source)
  }
  return importEntry(name, join(dir, bundle.entry), bundle, hash)
}

// Each platform says where it answered in its own header. These are the ones a port between the
// big hosts meets; a probe can read anything else itself.
export function servedFrom(headers: Record<string, string>): string | undefined {
  const ray = headers["cf-ray"]?.split("-").pop()
  if (ray) return `cloudflare:${ray}`
  const vercel = headers["x-vercel-id"]
  if (vercel) {
    const regions = vercel.split("::").slice(0, -1)
    return `vercel:${regions.join(">")}`
  }
  const cloudfront = headers["x-amz-cf-pop"]
  if (cloudfront) return `cloudfront:${cloudfront}`
  const fastly = headers["x-served-by"]?.split(",").pop()?.trim().split("-").pop()
  if (fastly) return `fastly:${fastly}`
  const fly = headers["fly-request-id"]?.split("-").pop()
  if (fly) return `fly:${fly}`
  return undefined
}

export type ContextInput = {
  target: ProbeTarget
  route: string
  sample: string
  path: string
  params: Record<string, string>
  conditions: Record<string, unknown>
  headers: Record<string, string>
  vantage: { name: string; region?: string }
  state: Record<string, unknown>
  record: Omit<RecordOptions, "baseURL" | "params">
  timeoutMs: number
  cwd: string
  browser: () => Promise<Browser>
  log: (message: string) => void
}

export function contextFor(input: ContextInput, repeat: number): ProbeContext {
  const { target } = input
  return {
    target,
    route: input.route,
    sample: input.sample,
    path: input.path,
    params: input.params,
    conditions: input.conditions,
    headers: input.headers,
    repeat,
    vantage: input.vantage,
    state: input.state,
    async request(path, init = {}) {
      const url = new URL(path, target.url)
      const t0 = performance.now()
      // redirect: "manual", or a 301 → 200 chain reads as a 200 and every redirect the site
      // promises stops being checked.
      const res = await fetch(url, {
        method: init.method ?? "GET",
        headers: { ...target.headers, ...input.headers, ...init.headers },
        redirect: "manual",
        signal: AbortSignal.timeout(input.timeoutMs),
      })
      const ttfb = performance.now() - t0
      const buffer = Buffer.from(await res.arrayBuffer())
      const total = performance.now() - t0
      const body = buffer.toString("utf8")
      return {
        url: url.href,
        status: res.status,
        headers: Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v])),
        body,
        bodyHash: createHash("sha1").update(buffer).digest("hex"),
        ttfb,
        total,
        bytes: buffer.length,
      }
    },
    browser: input.browser,
    async exec(command, env = {}) {
      return execAsync(command, {
        cwd: input.cwd,
        env: {
          ...process.env,
          PORTSIDE_BASE_URL: target.url,
          PORTSIDE_URL: new URL(input.path, target.url).href,
          PORTSIDE_PATH: input.path,
          PORTSIDE_TARGET: target.name,
          PORTSIDE_VANTAGE: input.vantage.name,
          ...env,
        },
      })
    },
    record: (res) =>
      normalise(res.status, res.headers, res.body, {
        ...input.record,
        baseURL: target.url,
        params: input.params,
      }),
    cacheHint: hintOf,
    classify,
    servedFrom,
    log: input.log,
  }
}
