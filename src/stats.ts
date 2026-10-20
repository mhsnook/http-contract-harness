export type Summary = {
  n: number
  min: number
  p25: number
  median: number
  p75: number
  max: number
}

function quantile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  const a = sorted[lo] as number
  const b = sorted[hi] as number
  return a + (b - a) * (i - lo)
}

const round = (n: number) => Math.round(n * 10) / 10

export function summarise(values: number[]): Summary | undefined {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (clean.length === 0) return undefined
  return {
    n: clean.length,
    min: round(clean[0] as number),
    p25: round(quantile(clean, 0.25)),
    median: round(quantile(clean, 0.5)),
    p75: round(quantile(clean, 0.75)),
    max: round(clean[clean.length - 1] as number),
  }
}

export type PerfCall = "better" | "worse" | "noise"

// Both floors are needed: without `minDeltaMs`, 2ms → 4ms on localhost is a 100% regression.
export function callChange(
  before: Summary,
  after: Summary,
  threshold: number,
  minDeltaMs = 0,
): PerfCall {
  if (before.median === 0) return "noise"
  const delta = Math.abs(after.median - before.median)
  if (delta / before.median < threshold || delta < minDeltaMs) return "noise"
  if (after.p25 > before.p75) return "worse"
  if (after.p75 < before.p25) return "better"
  return "noise"
}
