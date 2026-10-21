# Driving portside as an agent

Portside tracks a route-by-route port of a website. You drive it with the `portside` CLI. Pass
`--json` to every command and read the JSON, not the human output.

## The files

- `portside.config.json`: the targets (running copies of the site), which one is the baseline,
  and the allowed differences. A person owns this file. Edit it only when asked.
- `portside.lock.json`: the inventory of routes, their sample URLs and cases, and each case's
  expectations with their history. Commands write it; you may read it freely.
- `.portside/portside.db`: the measurements. Never edit it.

## The loop

1. `portside status --json` lists every target with its routes. Each route has a `state`
   (`pass`, `warn`, `fail`, `unknown`) and a `weight`. Work on the heaviest failing routes first.
2. `portside show "<route>" --json` explains one route: per target and per case, the contract
   differences (`contract.diffs`), the cache verdict (`cache.expected`, `cache.actual`,
   `cache.signal`) and the timing verdict (`perf.actual`, `perf.baseline`, `perf.against`,
   `perf.paired`, `perf.call`, `perf.note`).
3. Change the code of the target you are working on, deploy or restart it, then measure again:
   `portside run --route "<route>" --json`. A run measures every target together, which keeps the
   timings comparable. Do not run targets one at a time to compare them.
4. Check `portside status --json` again. A timing failure needs two batches in a row to count, so
   a single `warn` with the note "run again to confirm" calls for one more run, not a fix.

## Reading verdicts

- `contract.diffs[]` with no `allowed` field is a real difference: `field`, `expected` (from the
  lock or the baseline), `actual`, and the `sample` URL that showed it. `field: "error"` means the
  request failed.
- `reference: "none"` means nothing is locked and the target is the baseline: there is nothing to
  judge yet. `reference: "baseline"` means the case is unlocked and compared with the baseline's
  latest run.
- `cache.actual: "unknown"` means portside could not tell. Do not treat it as uncached.
- `perf.state: "warn"` on the baseline with a note naming another target means that target is
  faster on this route. Tell the person: the change may be worth carrying back to the current site.

## Experiments

Every change made to speed a route up runs the same way:

1. **Check what was tried.** `portside experiment list --route "<route>" --json`. If the same
   idea was discarded before, read its `decision.why` and do not try it again unless something it
   depended on has changed; say what.
2. **Read the route.** `portside show "<route>" --json`, and the platform's own numbers when the
   person has given you access to them. Form one theory about why it is slow.
3. **Measure before.** `portside experiment start "<theory>" --route "<route>" --json` measures
   the target and a reference together, before you change anything.
4. **Change one thing**, and deploy it to the target.
5. **Measure.** `portside experiment measure <id> --json`. Read `result.cases[]`: `change`
   (`better`, `worse`, `noise`) is already corrected for drift, `deltaMs` is the corrected change,
   and `broken` names any case whose contract the change broke.
6. **Decide, and write it down.** `portside experiment decide <id> keep|discard --why "…"`. The
   reason is for the next agent: say what you measured and why it settles the theory. Keeping an
   experiment that broke the contract is refused; fix it and measure again, or discard it.

`noise` is a result, not a failure: the change did not move the route by enough to see. Discard
it, or measure again with `--repeats` raised if the theory predicted a small change.

To cover a route from more directions first, `portside probe "<route>" --direction
hit,revalidate,cold,load,navigate --from <page that links to it>`. `cold` needs a `purge` command
on each target and `navigate` needs `--from`; if either is missing, ask the person rather than
inventing one.

## What needs a person

These commands change the bar the port is held to. Ask before you run them, and pass the person's
own words as the reason:

- `portside lock --force --reason "..."`: replaces a locked case.
- `portside loosen "<route#case>" --reason "..." ...`: lowers a bar.
- Adding to `allow` in the config.
- `portside route remove`.

These only add, measure or tighten, and you can run them when the task calls for it:

- `portside experiment start`, `measure`, `decide`
- `portside discover`, `portside route add`, `portside case add`, `portside route sample`
- `portside lock` without `--force`, which only locks unlocked cases
- `portside ratchet`; show the person what it tightened

Never make a failing route pass by loosening it unless a person asked for that. A failing route is
the tool working.

## Adding coverage

- A route the port must keep that the inventory lacks: `portside route add "/pattern/:param" --sample /pattern/real-value`.
- A branch in middleware or a proxy: add a case with the cookie, header or query that takes it,
  for example `portside case add / es-cookie --cookie locale=es`.
- After declaring patterns by hand, `portside discover --rebuild` folds the routes discovery
  guessed into them.
