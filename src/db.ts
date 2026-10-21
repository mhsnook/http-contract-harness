import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { CacheClass } from "./cache.ts"
import { STATE_DIR } from "./config.ts"
import type { ResponseRecord } from "./record.ts"

export type Run = {
  id: number
  target: string
  label: string | null
  url: string
  startedAt: string
  finishedAt: string | null
  gitSha: string | null
  note: string | null
  machine: string
  settings: string
  /** The first run of the batch this run was measured in, interleaved with the batch's other runs. */
  batch: number | null
}

export type Observation = {
  id: number
  runId: number
  route: string
  caseId: string
  sample: string
  path: string
  status: number | null
  record: ResponseRecord | null
  cache: CacheClass
  cacheSignal: string
  ttfb: number[]
  total: number[]
  bytes: number | null
  error: string | null
  direction: string
  // Every metric the direction measured, one sample per repeat; `ttfb` holds the one the timing
  // verdict reads, whatever its name.
  metrics: Record<string, number[]>
  /** Filled in on read, from the observation's run. */
  target?: string
  batch?: number | null
}

const SCHEMA = `
create table if not exists runs (
  id integer primary key autoincrement,
  target text not null,
  label text,
  url text not null,
  started_at text not null,
  finished_at text,
  git_sha text,
  note text,
  machine text not null default '{}',
  settings text not null default '{}',
  batch integer
);
create table if not exists observations (
  id integer primary key autoincrement,
  run_id integer not null references runs(id) on delete cascade,
  route text not null,
  case_id text not null,
  sample text not null,
  path text not null,
  status integer,
  record text,
  cache text not null,
  cache_signal text not null,
  ttfb text not null,
  total text not null,
  bytes integer,
  error text,
  direction text not null default 'hit',
  metrics text not null default '{}'
);
create index if not exists observations_case on observations(route, case_id, sample, run_id);
create index if not exists runs_target on runs(target, label, id);
`

type Row = Record<string, unknown>

const toRun = (r: Row): Run => ({
  id: r.id as number,
  target: r.target as string,
  label: (r.label as string | null) ?? null,
  url: r.url as string,
  startedAt: r.started_at as string,
  finishedAt: (r.finished_at as string | null) ?? null,
  gitSha: (r.git_sha as string | null) ?? null,
  note: (r.note as string | null) ?? null,
  machine: r.machine as string,
  settings: r.settings as string,
  batch: (r.batch as number | null) ?? null,
})

const toObservation = (r: Row): Observation => ({
  id: r.id as number,
  runId: r.run_id as number,
  route: r.route as string,
  caseId: r.case_id as string,
  sample: r.sample as string,
  path: r.path as string,
  status: (r.status as number | null) ?? null,
  record: r.record ? (JSON.parse(r.record as string) as ResponseRecord) : null,
  cache: r.cache as CacheClass,
  cacheSignal: r.cache_signal as string,
  ttfb: JSON.parse(r.ttfb as string) as number[],
  total: JSON.parse(r.total as string) as number[],
  bytes: (r.bytes as number | null) ?? null,
  error: (r.error as string | null) ?? null,
  direction: (r.direction as string | undefined) ?? "hit",
  metrics: JSON.parse((r.metrics as string | undefined) ?? "{}") as Record<string, number[]>,
  target: r.target as string | undefined,
  batch: (r.batch as number | null | undefined) ?? null,
})

const OBSERVATION = "o.*, r.target as target, r.batch as batch"

export class Store {
  readonly db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec("pragma journal_mode = wal; pragma foreign_keys = on;")
    this.db.exec(SCHEMA)
    const columns = this.db.prepare("pragma table_info(runs)").all() as Row[]
    if (!columns.some((c) => c.name === "batch"))
      this.db.exec("alter table runs add column batch integer")
    this.db.exec("create index if not exists runs_batch on runs(batch)")
    const observed = this.db.prepare("pragma table_info(observations)").all() as Row[]
    if (!observed.some((c) => c.name === "direction")) {
      this.db.exec("alter table observations add column direction text not null default 'hit'")
      this.db.exec("alter table observations add column metrics text not null default '{}'")
    }
  }

  static open(root: string): Store {
    const dir = join(root, STATE_DIR)
    mkdirSync(dir, { recursive: true })
    return new Store(join(dir, "portside.db"))
  }

  startRun(run: Omit<Run, "id" | "finishedAt">): number {
    const result = this.db
      .prepare(
        `insert into runs (target, label, url, started_at, git_sha, note, machine, settings, batch)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.target,
        run.label,
        run.url,
        run.startedAt,
        run.gitSha,
        run.note,
        run.machine,
        run.settings,
        run.batch,
      )
    return Number(result.lastInsertRowid)
  }

  setBatch(runId: number, batch: number): void {
    this.db.prepare("update runs set batch = ? where id = ?").run(batch, runId)
  }

  finishRun(id: number): void {
    this.db
      .prepare("update runs set finished_at = ? where id = ?")
      .run(new Date().toISOString(), id)
  }

  addObservation(o: Omit<Observation, "id" | "target" | "batch">): number {
    const result = this.db
      .prepare(
        `insert into observations
         (run_id, route, case_id, sample, path, status, record, cache, cache_signal, ttfb, total, bytes, error, direction, metrics)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.runId,
        o.route,
        o.caseId,
        o.sample,
        o.path,
        o.status,
        o.record ? JSON.stringify(o.record) : null,
        o.cache,
        o.cacheSignal,
        JSON.stringify(o.ttfb),
        JSON.stringify(o.total),
        o.bytes,
        o.error,
        o.direction,
        JSON.stringify(o.metrics),
      )
    return Number(result.lastInsertRowid)
  }

  runs(limit = 50): Run[] {
    return this.db
      .prepare("select * from runs order by id desc limit ?")
      .all(limit)
      .map((r) => toRun(r as Row))
  }

  run(id: number): Run | undefined {
    const row = this.db.prepare("select * from runs where id = ?").get(id)
    return row ? toRun(row as Row) : undefined
  }

  latestRun(target: string, label?: string): Run | undefined {
    const row =
      label === undefined
        ? this.db
            .prepare("select * from runs where target = ? order by id desc limit 1")
            .get(target)
        : this.db
            .prepare("select * from runs where target = ? and label = ? order by id desc limit 1")
            .get(target, label)
    return row ? toRun(row as Row) : undefined
  }

  observationsOf(runId: number): Observation[] {
    return this.db
      .prepare(
        `select ${OBSERVATION} from observations o join runs r on r.id = o.run_id where o.run_id = ? order by o.id`,
      )
      .all(runId)
      .map((r) => toObservation(r as Row))
  }

  // Across runs, not from the latest run: a run of one route must not hide every other route.
  latestFor(target: string, label?: string): Observation[] {
    const filter = label === undefined ? "" : "and r.label = ?"
    const params = label === undefined ? [target] : [target, label]
    return this.db
      .prepare(
        `select ${OBSERVATION} from observations o
         join runs r on r.id = o.run_id
         join (
           select o2.route, o2.case_id, o2.sample, max(o2.id) as id
           from observations o2 join runs r2 on r2.id = o2.run_id
           where r2.target = ? ${filter.replace("r.", "r2.")}
           group by o2.route, o2.case_id, o2.sample
         ) latest on latest.id = o.id
         order by o.route, o.case_id, o.sample`,
      )
      .all(...params)
      .map((r) => toObservation(r as Row))
  }

  previousBatch(target: string, batch: number): number | undefined {
    const row = this.db
      .prepare(
        "select max(batch) as batch from runs where target = ? and batch < ? and finished_at is not null",
      )
      .get(target, batch) as Row | undefined
    return (row?.batch as number | null) ?? undefined
  }

  inBatches(batches: number[]): Observation[] {
    if (batches.length === 0) return []
    return this.db
      .prepare(
        `select ${OBSERVATION} from observations o join runs r on r.id = o.run_id
         where r.batch in (${batches.map(() => "?").join(",")}) order by o.id`,
      )
      .all(...batches)
      .map((r) => toObservation(r as Row))
  }

  maxObservationId(): number {
    const row = this.db.prepare("select coalesce(max(id), 0) as id from observations").get() as Row
    return row.id as number
  }

  close(): void {
    this.db.close()
  }
}
