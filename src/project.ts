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
import { Store } from "./db.ts"
import { bySpecificity } from "./patterns.ts"

export type Project = {
  root: string
  config: Config
  lock: Lock
  store: Store
  saveLock(): void
}

export function openProject(cwd = process.cwd()): Project {
  const root = findRoot(cwd)
  if (!root) {
    throw new Error("No portside.config.json here or in any parent. Run `portside init` first.")
  }
  const project: Project = {
    root,
    config: readConfig(root),
    lock: readLock(root),
    store: Store.open(root),
    saveLock: () => writeLock(root, project.lock),
  }
  return project
}

export type CaseRequest = {
  route: string
  caseId: string
  key: string
  sample: string
  path: string
  headers: Record<string, string>
}

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

export function requestsOf(lock: Lock, only?: (pattern: string) => boolean): CaseRequest[] {
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
      })
    }
  }
  return out
}

export const weightOf = (config: Config, route: RouteDef) => route.weight ?? config.defaults.weight
