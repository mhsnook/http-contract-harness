import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"

export const CONFIG_FILE = "portside.config.json"
export const LOCK_FILE = "portside.lock.json"
export const STATE_DIR = ".portside"

const headers = z.record(z.string(), z.string())

export const cachePolicy = z.enum(["must-match", "if-slower", "ignore"])
export type CachePolicy = z.infer<typeof cachePolicy>

const target = z.object({
  url: z.string().url(),
  headers: headers.optional(),
  // A target that leaves the ratchet never tightens the lock, such as a local dev server whose
  // timings say nothing about production.
  ratchet: z.boolean().default(true),
  note: z.string().optional(),
})
export type Target = z.infer<typeof target>

const allowance = z.object({
  id: z.string(),
  why: z.string(),
  field: z.string(),
  path: z.string().optional(),
  target: z.string().optional(),
  expected: z.string().optional(),
  actual: z.string().optional(),
})
export type Allowance = z.infer<typeof allowance>

export const configSchema = z.object({
  $schema: z.string().optional(),
  baseline: z.string(),
  targets: z.record(z.string(), target),
  probe: z
    .object({
      repeats: z.number().int().min(1).default(6),
      concurrency: z.number().int().min(1).default(4),
      timeoutMs: z.number().int().min(100).default(15_000),
      // A regex whose first group changes on every fresh render, such as a render id in a meta tag.
      renderStamp: z.string().optional(),
      headers: z.array(z.string()).default(["vary", "x-robots-tag"]),
      htmlCacheControl: z.boolean().default(false),
      errorsMatchOnStatus: z.boolean().default(true),
    })
    .prefault({}),
  perf: z
    .object({
      threshold: z.number().min(0).default(0.1),
      minDeltaMs: z.number().min(0).default(25),
    })
    .prefault({}),
  discover: z
    .object({
      sitemap: z.string().default("/sitemap.xml"),
      samplesPerRoute: z.number().int().min(1).default(3),
      minVariants: z.number().int().min(2).default(3),
      expand: z.record(z.string(), z.array(z.string())).default({}),
      next: z.object({ dir: z.string().default(".next") }).optional(),
    })
    .prefault({}),
  defaults: z
    .object({
      cachePolicy: cachePolicy.default("if-slower"),
      weight: z.number().default(1),
    })
    .prefault({}),
  allow: z.array(allowance).default([]),
})
export type Config = z.infer<typeof configSchema>

const summarySchema = z.object({
  n: z.number(),
  min: z.number(),
  p25: z.number(),
  median: z.number(),
  p75: z.number(),
  max: z.number(),
})

export const expectSchema = z.object({
  status: z.number().int().optional(),
  record: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  cache: z.enum(["cached", "uncached"]).optional(),
  ttfb: summarySchema.optional(),
  // A ceiling on the median, not the p75.
  ttfbMax: z.number().optional(),
  lockedFrom: z.string().optional(),
  lockedAt: z.string().optional(),
})
export type Expect = z.infer<typeof expectSchema>

const historyEntry = z.object({
  at: z.string(),
  by: z.enum(["lock", "ratchet", "loosen"]),
  field: z.string(),
  from: z.unknown().optional(),
  to: z.unknown().optional(),
  reason: z.string().optional(),
})
export type HistoryEntry = z.infer<typeof historyEntry>

const caseSchema = z.object({
  headers: headers.optional(),
  query: z.string().optional(),
  note: z.string().optional(),
  expect: expectSchema.optional(),
  history: z.array(historyEntry).default([]),
})
export type CaseDef = z.infer<typeof caseSchema>

const routeSchema = z.object({
  samples: z.array(z.string()).default([]),
  weight: z.number().optional(),
  cachePolicy: cachePolicy.optional(),
  source: z.string().optional(),
  declared: z.object({ mode: z.string(), revalidate: z.number().optional() }).optional(),
  note: z.string().optional(),
  cases: z.record(z.string(), caseSchema).default({ default: { history: [] } }),
})
export type RouteDef = z.infer<typeof routeSchema>

export const lockSchema = z.object({
  version: z.literal(1),
  routes: z.record(z.string(), routeSchema).default({}),
})
export type Lock = z.infer<typeof lockSchema>

export function findRoot(from = process.cwd()): string | undefined {
  let dir = resolve(from)
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

// A header whose variable is unset is dropped rather than sent empty: an empty bypass header
// reaches the WAF as a failed bypass, which reads as the site blocking the probe.
export function expandHeaders(
  values: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { headers: Record<string, string>; missing: string[] } {
  const out: Record<string, string> = {}
  const missing: string[] = []
  for (const [name, raw] of Object.entries(values ?? {})) {
    let unset = false
    const value = raw.replace(/\$\{(\w+)\}/g, (_, key: string) => {
      const found = env[key]
      if (found === undefined) {
        unset = true
        missing.push(key)
      }
      return found ?? ""
    })
    if (!unset) out[name.toLowerCase()] = value
  }
  return { headers: out, missing }
}

function parseFile<T>(file: string, schema: z.ZodType<T>): T {
  const raw = JSON.parse(readFileSync(file, "utf8"))
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`${file} is not valid:\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

export function readConfig(root: string): Config {
  const config = parseFile(join(root, CONFIG_FILE), configSchema)
  if (!config.targets[config.baseline]) {
    throw new Error(`baseline "${config.baseline}" is not one of the targets in ${CONFIG_FILE}`)
  }
  return config
}

export function readLock(root: string): Lock {
  const file = join(root, LOCK_FILE)
  if (!existsSync(file)) return { version: 1, routes: {} }
  return parseFile(file, lockSchema)
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    )
  }
  return value
}

// Sorted keys, or two people locking the same routes write different files and every review diff
// is noise.
export function writeLock(root: string, lock: Lock): void {
  writeFileSync(join(root, LOCK_FILE), JSON.stringify(sortKeys(lock), null, 2) + "\n")
}

export function writeConfig(root: string, config: unknown): void {
  writeFileSync(join(root, CONFIG_FILE), JSON.stringify(config, null, 2) + "\n")
}

export const caseKey = (pattern: string, caseId: string) => `${pattern}#${caseId}`

export function parseCaseKey(key: string): { pattern: string; caseId: string } {
  const at = key.lastIndexOf("#")
  if (at === -1) return { pattern: key, caseId: "default" }
  return { pattern: key.slice(0, at), caseId: key.slice(at + 1) }
}
