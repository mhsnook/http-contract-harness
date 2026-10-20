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

To try a rendering strategy on one route, label the runs:

```sh
portside run --target port --label strategy-a --route /event --json
portside run --target port --label strategy-b --route /event --json
portside compare port@strategy-a port@strategy-b --json
```

Report what you measured and recommend one. Labelled runs measured separately are minutes apart:
when the difference is small, run them again before you trust it.

## What needs a person

These commands change the bar the port is held to. Ask before you run them, and pass the person's
own words as the reason:

- `portside lock --force --reason "..."`: replaces a locked case.
- `portside loosen "<route#case>" --reason "..." ...`: lowers a bar.
- Adding to `allow` in the config.
- `portside route remove`.

These only add or tighten, and you can run them when the task calls for it:

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
