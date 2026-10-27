import {
  caseKey,
  findRoot,
  readConfig,
  readLock,
  writeLock,
  type CaseDef,
  type Config,
  type Lock,
  type RouteDef,
} from "./config.ts"
import { join } from "node:path"
import { Store } from "./db.ts"
import type { EngineRequest } from "./engine.ts"
import { bySpecificity } from "./patterns.ts"
import { loadProbes, type LoadedProbe } from "./probe.ts"

export type Project = {
  root: string
  config: Config
  lock: Lock
  store: Store
  saveLock(): void
  probes(): Promise<Map<string, LoadedProbe>>
}

export function openProject(cwd = process.cwd()): Project {
  const root = findRoot(cwd)
  if (!root) {
    throw new Error("No harness.config.json here or in any parent. Run `hch init` first.")
  }
  const project: Project = {
    root,
    config: readConfig(root),
    lock: readLock(root),
    store: Store.open(root),
    saveLock: () => writeLock(root, project.lock),
    probes: () => loadProbes(join(root, project.config.probes)),
  }
  return project
}

export type CaseRequest = EngineRequest & { key: string }

export const probeOf = (config: Config, def: CaseDef) => def.probe ?? config.defaults.probe

export function withQuery(path: string, query: string | undefined): string {
  if (!query) return path
  return path + (path.includes("?") ? "&" : "?") + query.replace(/^\?/, "")
}

export function* casesOf(lock: Lock): Generator<[string, RouteDef, string, CaseDef]> {
  for (const pattern of Object.keys(lock.routes).sort(bySpecificity)) {
    const route = lock.routes[pattern] as RouteDef
    for (const [caseId, def] of Object.entries(route.cases)) yield [pattern, route, caseId, def]
  }
}

export function requestsOf(
  config: Config,
  lock: Lock,
  only?: (pattern: string) => boolean,
): CaseRequest[] {
  const out: CaseRequest[] = []
  for (const [pattern, route, caseId, def] of casesOf(lock)) {
    if (only && !only(pattern)) continue
    for (const sample of route.samples) {
      out.push({
        route: pattern,
        caseId,
        key: caseKey(pattern, caseId),
        sample,
        path: withQuery(sample, def.query),
        headers: Object.fromEntries(
          Object.entries(def.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
        ),
        probe: probeOf(config, def),
        conditions: def.conditions ?? {},
      })
    }
  }
  return out
}

export const weightOf = (config: Config, route: RouteDef) => route.weight ?? config.defaults.weight
