import type { Observation } from "./db.ts"
import type { Project } from "./project.ts"
import type { TargetEvaluation } from "./report.ts"
import { evaluate } from "./verdict.ts"

export function statusOf(project: Project, targets?: string[], label?: string): TargetEvaluation[] {
  const { config, lock, store } = project
  const names = targets?.length ? targets : Object.keys(config.targets)
  const reference = store.latestFor(config.baseline)
  return names.map((target) => {
    if (!config.targets[target]) throw new Error(`No target "${target}"`)
    const observations = store.latestFor(target, label)
    const batches = [...new Set(observations.flatMap((o) => (o.batch == null ? [] : [o.batch])))]
    const previous = new Map(
      batches.flatMap((b) => {
        const p = store.previousBatch(target, b)
        return p === undefined ? [] : [[b, p] as const]
      }),
    )
    return {
      target,
      evaluation: evaluate({
        config,
        lock,
        target,
        observations,
        reference: target === config.baseline ? [] : reference,
        peers: store.inBatches([...batches, ...previous.values()]),
        previous,
      }),
    }
  })
}

// `#12` or `12` is a run; `port@isr-60` the latest of port's runs labelled isr-60; `port` a target.
export function resolveRef(
  project: Project,
  ref: string,
): { name: string; observations: Observation[] } {
  const id = /^#?(\d+)$/.exec(ref)?.[1]
  if (id) {
    const run = project.store.run(Number(id))
    if (!run) throw new Error(`No run ${id}`)
    return {
      name: `${run.target}#${run.id}${run.label ? `@${run.label}` : ""}`,
      observations: project.store.observationsOf(run.id),
    }
  }
  const [target, label] = ref.split("@") as [string, string | undefined]
  if (!project.config.targets[target]) throw new Error(`"${ref}" is neither a run id nor a target`)
  const observations = project.store.latestFor(target, label)
  if (observations.length === 0)
    throw new Error(
      `No observations for ${ref} yet. Run \`portside run --target ${target}${label ? ` --label ${label}` : ""}\`.`,
    )
  return { name: ref, observations }
}

export function compareRefs(
  project: Project,
  before: string,
  after: string,
): TargetEvaluation & { before: string } {
  const a = resolveRef(project, before)
  const b = resolveRef(project, after)
  const target = b.name.split(/[#@]/)[0] as string
  return {
    before: a.name,
    target: b.name,
    evaluation: evaluate({
      config: project.config,
      lock: project.lock,
      target,
      observations: b.observations,
      reference: a.observations,
      useLock: false,
    }),
  }
}
