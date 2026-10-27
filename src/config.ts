import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"

export const CONFIG_FILE = "harness.config.json"
export const LOCK_FILE = "harness.lock.json"
export const STATE_DIR = ".harness"

export const LEDGER_FILE = "harness.ledger.json"
export const PROBES_DIR = "harness/probes"
export const SOURCES_DIR = "harness/sources"

const headers = z.record(z.string(), z.string())

export const fieldPolicy = z.enum(["must-match", "if-slower", "ignore"])
export type FieldPolicy = z.infer<typeof fieldPolicy>

// How a record field is judged. `order` lists values from worst to best, so a move up the list is
// an improvement the ratchet keeps rather than a difference; `optional` skips the field whenever
// either side lacks it, for a probe that only sometimes knows the answer.
export const fieldSpec = z.union([
  fieldPolicy,
  z.object({
    policy: fieldPolicy.default("must-match"),
    order: z.array(z.string()).optional(),
    optional: z.boolean().default(false),
  }),
])
export type FieldSpec = z.infer<typeof fieldSpec>

const target = z.object({
  url: z.string().url(),
  headers: headers.optional(),
  cookies: headers.optional(),
  // A target that leaves the ratchet never tightens the lock, such as a local dev server whose
  // timings say nothing about production.
  ratchet: z.boolean().default(true),
  // Anything the project's probes want to know about this target, such as how to purge it.
  options: z.record(z.string(), z.unknown()).default({}),
  note: z.string().optional(),
})
export type Target = z.infer<typeof target>

const vantage = z.object({
  // A runner started with `hch runner serve`; without one the vantage is this machine.
  url: z.string().url().optional(),
  token: z.string().optional(),
  region: z.string().optional(),
  // How probes on this vantage get a browser: a Chromium binary, or a CDP endpoint such as a
  // Browser Run session.
  browser: z
    .object({ executablePath: z.string().optional(), cdp: z.string().optional() })
    .default({}),
  note: z.string().optional(),
})
export type Vantage = z.infer<typeof vantage>

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
  vantages: z.record(z.string(), vantage).default({ local: { browser: {} } }),
  // The share of readers each region holds, from `hch survey` or by hand, such as
  // { "weur": 0.8, "enam": 0.15 }. Launch readiness weighs each route's result by it.
  regions: z.record(z.string(), z.number()).default({}),
  probes: z.string().default(PROBES_DIR),
  sources: z.string().default(SOURCES_DIR),
  survey: z
    .object({
      since: z.string().default("30d"),
      // Handed to each source module as ctx.options, keyed by the module's name.
      sources: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
      weightBy: z.enum(["views", "entries"]).default("views"),
    })
    .prefault({}),
  run: z
    .object({
      repeats: z.number().int().min(1).default(6),
      concurrency: z.number().int().min(1).default(4),
      timeoutMs: z.number().int().min(100).default(15_000),
    })
    .prefault({}),
  record: z
    .object({
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
    })
    .prefault({}),
  defaults: z
    .object({
      probe: z.string().default("http"),
      weight: z.number().default(1),
    })
    .prefault({}),
  allow: z.array(allowance).default([]),
})
export type Config = z.infer<typeof configSchema>

export const summarySchema = z.object({
  n: z.number(),
  min: z.number(),
  p25: z.number(),
  median: z.number(),
  p75: z.number(),
  max: z.number(),
})

export const expectSchema = z.object({
  // The probe definition the lock was taken with. Numbers from another version measure something
  // else, so they are not judged against it.
  probe: z.object({ name: z.string(), hash: z.string() }).optional(),
  status: z.number().int().optional(),
  record: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  metric: z.string().optional(),
  timing: z.record(z.string(), summarySchema).default({}),
  // Ceilings on the primary metric's median, set by hand, per vantage or `*` for all.
  max: z.record(z.string(), z.number()).default({}),
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
  probe: z.string().optional(),
  conditions: z.record(z.string(), z.unknown()).optional(),
  headers: headers.optional(),
  query: z.string().optional(),
  fields: z.record(z.string(), fieldSpec).optional(),
  note: z.string().optional(),
  expect: expectSchema.optional(),
  history: z.array(historyEntry).default([]),
})
export type CaseDef = z.infer<typeof caseSchema>

const routeSchema = z.object({
  samples: z.array(z.string()).default([]),
  weight: z.number().optional(),
  traffic: z
    .object({ views: z.number(), entries: z.number(), share: z.number(), entryShare: z.number() })
    .optional(),
  fields: z.record(z.string(), fieldSpec).optional(),
  source: z.string().optional(),
  declared: z.object({ mode: z.string(), revalidate: z.number().optional() }).optional(),
  note: z.string().optional(),
  cases: z.record(z.string(), caseSchema).default({ default: { history: [] } }),
})
export type RouteDef = z.infer<typeof routeSchema>

export const lockSchema = z.object({
  version: z.literal(2),
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
  if (Object.keys(config.vantages).length === 0) config.vantages = { local: { browser: {} } }
  return config
}

export function readLock(root: string): Lock {
  const file = join(root, LOCK_FILE)
  if (!existsSync(file)) return { version: 2, routes: {} }
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

// Sorted keys, or two people writing the same records produce different files and every review
// diff is noise.
export function writeSorted(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(sortKeys(value), null, 2) + "\n")
}

export function writeLock(root: string, lock: Lock): void {
  writeSorted(join(root, LOCK_FILE), lock)
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
