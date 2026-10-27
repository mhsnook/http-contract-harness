import { judgedByLock, reachableFrom, referenceOf } from "./config.ts"
import type { Observation } from "./db.ts"
import type { Project } from "./project.ts"
import { evaluate, type Evaluation, type ProbeInfo } from "./verdict.ts"

export type TargetEvaluation = { target: string; vantage: string; evaluation: Evaluation }

export async function probeInfo(project: Project): Promise<Map<string, ProbeInfo>> {
  const loaded = await project.probes()
  return new Map(
    [...loaded].map(([name, p]) => [name, { hash: p.hash, primary: p.primary, fields: p.fields }]),
  )
}

/** The vantages to report on: the ones asked for, else every one that has measured anything. */
export function vantagesOf(project: Project, asked?: string[]): string[] {
  if (asked?.length) return asked
  const measured = project.store.vantagesMeasured()
  const configured = Object.keys(project.config.vantages)
  const both = configured.filter((v) => measured.includes(v))
  return both.length ? both : configured.slice(0, 1)
}

export async function statusOf(
  project: Project,
  opts: { targets?: string[]; vantages?: string[]; label?: string } = {},
): Promise<TargetEvaluation[]> {
  const { config, lock, store } = project
  const probes = await probeInfo(project)
  const names = opts.targets?.length ? opts.targets : Object.keys(config.targets)
  const out: TargetEvaluation[] = []
  for (const vantage of vantagesOf(project, opts.vantages)) {
    for (const target of names) {
      if (!config.targets[target]) throw new Error(`No target "${target}"`)
      if (!reachableFrom(config, target, vantage)) continue
      const against = referenceOf(config, target)
      const reference = target === against ? [] : store.latestFor(against, vantage)
      const observations = store.latestFor(target, vantage, opts.label)
      const batches = [...new Set(observations.flatMap((o) => (o.batch == null ? [] : [o.batch])))]
      const previous = new Map(
        batches.flatMap((b) => {
          const p = store.previousBatch(target, vantage, b)
          return p === undefined ? [] : [[b, p] as const]
        }),
      )
      out.push({
        target,
        vantage,
        evaluation: evaluate({
          config,
          lock,
          target,
          vantage,
          observations,
          probes,
          baseline: against,
          useLock: judgedByLock(config, target),
          reference,
          peers: store.inBatches([...batches, ...previous.values()]),
          previous,
        }),
      })
    }
  }
  return out
}

// `#12` or `12` is a run; `port@isr-60` the latest of port's runs labelled isr-60; `port` a
// target. Either may end in `/vantage`.
export function resolveRef(
  project: Project,
  ref: string,
  defaultVantage: string,
): { name: string; target: string; vantage: string; observations: Observation[] } {
  const id = /^#?(\d+)$/.exec(ref)?.[1]
  if (id) {
    const run = project.store.run(Number(id))
    if (!run) throw new Error(`No run ${id}`)
    return {
      name: `${run.target}#${run.id}${run.label ? `@${run.label}` : ""}/${run.vantage}`,
      target: run.target,
      vantage: run.vantage,
      observations: project.store.observationsOf(run.id),
    }
  }
  const [head, vantage = defaultVantage] = ref.split("/") as [string, string | undefined]
  const [target, label] = head.split("@") as [string, string | undefined]
  if (!project.config.targets[target]) throw new Error(`"${ref}" is neither a run id nor a target`)
  const observations = project.store.latestFor(target, vantage, label)
  if (observations.length === 0) {
    throw new Error(`No observations for ${ref} from ${vantage} yet.`)
  }
  return { name: `${head}/${vantage}`, target, vantage, observations }
}

export async function compareRefs(
  project: Project,
  before: string,
  after: string,
): Promise<TargetEvaluation & { before: string }> {
  const vantage = vantagesOf(project)[0] as string
  const a = resolveRef(project, before, vantage)
  const b = resolveRef(project, after, vantage)
  return {
    before: a.name,
    target: b.name,
    vantage: b.vantage,
    evaluation: evaluate({
      config: project.config,
      lock: project.lock,
      target: b.target,
      vantage: b.vantage,
      observations: b.observations,
      probes: await probeInfo(project),
      reference: a.observations,
      useLock: false,
      compare: true,
    }),
  }
}
