import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { STATE_DIR } from "./config.ts"
import type { ResponseRecord } from "./record.ts"

export type Run = {
  id: number
  target: string
  vantage: string
  region: string | null
  label: string | null
  url: string
  startedAt: string
  finishedAt: string | null
  gitSha: string | null
  note: string | null
  machine: string
  settings: string
  // The first run of the batch this run was measured in, interleaved with the batch's other runs.
  batch: number | null
}

export type Observation = {
  id: number
  runId: number
  route: string
  caseId: string
  sample: string
  path: string
  probe: string
  probeHash: string
  status: number | null
  record: ResponseRecord | null
  // The probe's primary metric, one value per counted repeat.
  primary: number[]
  metrics: Record<string, number[]>
  served: string | null
  skipped: string[]
  note: string | null
  error: string | null
  // Filled in on read, from the observation's run.
  target?: string
  vantage?: string
  region?: string | null
  batch?: number | null
}

export type TrafficRow = {
  source: string
  path: string
  views: number
  entries: number
  country: string | null
  region: string | null
}

const SCHEMA = `
create table if not exists runs (
  id integer primary key autoincrement,
  target text not null,
  vantage text not null default 'local',
  region text,
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
  probe text not null,
  probe_hash text not null,
  status integer,
  record text,
  primary_samples text not null,
  metrics text not null,
  served text,
  skipped text not null default '[]',
  note text,
  error text
);
create table if not exists traffic (
  id integer primary key autoincrement,
  imported integer not null,
  source text not null,
  path text not null,
  views real not null,
  entries real not null,
  country text,
  region text
);
create index if not exists observations_case on observations(route, case_id, sample, run_id);
create index if not exists runs_target on runs(target, vantage, label, id);
create index if not exists runs_batch on runs(batch);
create index if not exists traffic_import on traffic(imported);
`

type Row = Record<string, unknown>

const toRun = (r: Row): Run => ({
  id: r.id as number,
  target: r.target as string,
  vantage: r.vantage as string,
  region: (r.region as string | null) ?? null,
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
  probe: r.probe as string,
  probeHash: r.probe_hash as string,
  status: (r.status as number | null) ?? null,
  record: r.record ? (JSON.parse(r.record as string) as ResponseRecord) : null,
  primary: JSON.parse(r.primary_samples as string) as number[],
  metrics: JSON.parse(r.metrics as string) as Record<string, number[]>,
  served: (r.served as string | null) ?? null,
  skipped: JSON.parse(r.skipped as string) as string[],
  note: (r.note as string | null) ?? null,
  error: (r.error as string | null) ?? null,
  target: r.target as string | undefined,
  vantage: r.vantage as string | undefined,
  region: (r.region as string | null | undefined) ?? null,
  batch: (r.batch as number | null | undefined) ?? null,
})

const OBSERVATION =
  "o.*, r.target as target, r.vantage as vantage, r.region as region, r.batch as batch"

export class Store {
  readonly db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec("pragma journal_mode = wal; pragma foreign_keys = on;")
    // A database from before probes existed is kept under another name, not mixed into the new
    // one: its numbers were measured by definitions nobody can name any more.
    const columns = this.db.prepare("pragma table_info(observations)").all() as Row[]
    if (columns.length > 0 && !columns.some((c) => c.name === "probe")) {
      this.db.exec("alter table observations rename to observations_v1")
      this.db.exec("alter table runs rename to runs_v1")
    }
    this.db.exec(SCHEMA)
  }

  static open(root: string): Store {
    const dir = join(root, STATE_DIR)
    mkdirSync(dir, { recursive: true })
    return new Store(join(dir, "harness.db"))
  }

  startRun(run: Omit<Run, "id" | "finishedAt">): number {
    const result = this.db
      .prepare(
        `insert into runs (target, vantage, region, label, url, started_at, git_sha, note, machine, settings, batch)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.target,
        run.vantage,
        run.region,
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

  addObservation(o: Omit<Observation, "id" | "target" | "vantage" | "region" | "batch">): number {
    const result = this.db
      .prepare(
        `insert into observations
         (run_id, route, case_id, sample, path, probe, probe_hash, status, record, primary_samples, metrics, served, skipped, note, error)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.runId,
        o.route,
        o.caseId,
        o.sample,
        o.path,
        o.probe,
        o.probeHash,
        o.status,
        o.record ? JSON.stringify(o.record) : null,
        JSON.stringify(o.primary),
        JSON.stringify(o.metrics),
        o.served,
        JSON.stringify(o.skipped),
        o.note,
        o.error,
      )
    return Number(result.lastInsertRowid)
  }

  runs(limit = 50): Run[] {
    return this.db
      .prepare("select * from runs order by id desc limit ?")
      .all(limit)
      .map((r) => toRun(r as Row))
  }

  /** The newest run of each target from each vantage. */
  latestRuns(): Run[] {
    return this.db
      .prepare(
        "select * from runs where id in (select max(id) from runs group by target, vantage) order by id desc",
      )
      .all()
      .map((r) => toRun(r as Row))
  }

  run(id: number): Run | undefined {
    const row = this.db.prepare("select * from runs where id = ?").get(id)
    return row ? toRun(row as Row) : undefined
  }

  vantagesMeasured(): string[] {
    return this.db
      .prepare("select distinct vantage from runs order by vantage")
      .all()
      .map((r) => (r as Row).vantage as string)
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
  latestFor(target: string, vantage: string, label?: string): Observation[] {
    const filter = label === undefined ? "" : "and r2.label = ?"
    const params = label === undefined ? [target, vantage] : [target, vantage, label]
    return this.db
      .prepare(
        `select ${OBSERVATION} from observations o
         join runs r on r.id = o.run_id
         join (
           select o2.route, o2.case_id, o2.sample, max(o2.id) as id
           from observations o2 join runs r2 on r2.id = o2.run_id
           where r2.target = ? and r2.vantage = ? ${filter}
           group by o2.route, o2.case_id, o2.sample
         ) latest on latest.id = o.id
         order by o.route, o.case_id, o.sample`,
      )
      .all(...params)
      .map((r) => toObservation(r as Row))
  }

  previousBatch(target: string, vantage: string, batch: number): number | undefined {
    const row = this.db
      .prepare(
        "select max(batch) as batch from runs where target = ? and vantage = ? and batch < ? and finished_at is not null",
      )
      .get(target, vantage, batch) as Row | undefined
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

  importTraffic(rows: TrafficRow[]): number {
    const imported = Date.now()
    const insert = this.db.prepare(
      "insert into traffic (imported, source, path, views, entries, country, region) values (?, ?, ?, ?, ?, ?, ?)",
    )
    this.db.exec("begin")
    try {
      for (const r of rows) {
        insert.run(imported, r.source, r.path, r.views, r.entries, r.country, r.region)
      }
      this.db.exec("commit")
    } catch (error) {
      this.db.exec("rollback")
      throw error
    }
    return imported
  }

  // The latest import from each source, so re-running a survey replaces a source's rows.
  traffic(): TrafficRow[] {
    return this.db
      .prepare(
        `select t.* from traffic t
         join (select source, max(imported) as imported from traffic group by source) latest
           on latest.source = t.source and latest.imported = t.imported`,
      )
      .all()
      .map((r) => {
        const row = r as Row
        return {
          source: row.source as string,
          path: row.path as string,
          views: row.views as number,
          entries: row.entries as number,
          country: (row.country as string | null) ?? null,
          region: (row.region as string | null) ?? null,
        }
      })
  }

  close(): void {
    this.db.close()
  }
}
