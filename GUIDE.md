# Porting a site with portside

You are porting a site, route by route. Portside keeps the record: the routes, every measurement,
the contract the port is held to, the experiments and what was learned. You decide how things are
measured, by writing probes, and you do the port. Pass `--json` to every command and read the JSON.

Start every session with `portside plan --json`. It names the current phase, its checks, and the
next commands. Work the phases in order.

## The files

- `portside.config.json`: targets, vantages, regions, allowed differences. A person owns it;
  change it when they ask, or when a command says to.
- `portside.lock.json`: the routes, their samples and cases, and what each case is held to.
  Commands write it.
- `portside.ledger.json`: experiments and findings. Commands write it.
- `portside/probes/*.mjs`: how things are measured. Yours to write and change.
- `portside/sources/*.mjs`: where traffic numbers come from. Yours to write and change. A file
  starting with `_` is switched off.
- `.portside/portside.db`: every measurement. Never edit it.

## 1. Survey

Find out which routes matter and where readers are, before measuring anything.

- Write or enable a source for the analytics the site has. Read the starter for that platform,
  check its queries against the real account, then rename it without the `_`. Without an API, ask
  for an export and use `portside survey --csv <file>`.
- `portside survey --regions --json`. Read `routes` (views and entries per route), `uncovered`
  (traffic no route matches) and `regions`.
- Entries matter as much as views: a route readers land on from search or a link is where a slow
  first load costs the most.

## 2. Inventory

- `portside discover` (the sitemap), `--next .next` on a Next.js app, and `--traffic` for the
  surveyed paths. Declare patterns you know with `portside route add` and run
  `portside discover --rebuild` to fold the guesses into them.
- For each priority route (`plan.priority`), add a case for every way readers reach it that the
  site answers differently: a locale cookie, a logged-in session, a query the proxy redirects, a
  client-side navigation, a cold cache. `portside case add <route> <id> --probe <p> --condition k=v`.

## 3. Profile

- Read the starter probes before running them, and decide whether each one counts what matters
  for this site. If not, change it, or copy it under a new name and change that. Things to decide
  per stack:
  - how a cold request is made: what purges the cache, and whether a query string reaches the key
  - when a page counts as loaded: LCP, a selector, the load event
  - when a client-side navigation has finished, and which request carries the new page
  - which response fields belong in the contract
- `portside run --target <baseline> --json`, from every vantage the plan asks for.
- `portside lock --from <baseline>`.
- Record what you learned about the stack: `portside note "<finding>" --route <route> --tag <tag>`.
  Write the finding so the next agent can act on it without repeating your work.

## 4. Parity

- `portside run --json`, then `portside status --json`. Work on the heaviest failing priority
  routes first. `portside show "<route>" --json` explains one: `contract.diffs` (field, expected,
  actual, policy), `perf` (metric, actual, baseline, against, paired, call, note), and `stale` when
  the lock was taken with another version of the probe.
- A timing failure needs two batches in a row. A single warning that says "run again to confirm"
  calls for one more run, not a change.

## 5. Improve

Every change made to speed a route up runs the same way:

1. **Check what was tried.** `portside experiment list --route <route> --json` and
   `portside notes --route <route> --json`. Do not repeat a discarded idea unless something it
   depended on has changed; say what.
2. **Read the route** with `portside show`, and the platform's own numbers when you have access.
   Form one theory.
3. **Measure before.** `portside experiment start "<theory>" --route <route> --json`.
4. **Change one thing**, and deploy it to the target.
5. **Measure after.** `portside experiment measure <id> --json`. `result.cases[].change` is
   corrected for drift; `deltaMs` is the corrected change; `broken` names a case whose contract the
   change broke.
6. **Decide and write it down.** `portside experiment decide <id> keep|discard --why "…"`, saying
   what you measured and why it settles the theory. Add a finding if you learned something about
   the stack.

`noise` is a result: the change did not move the route enough to see. Changing a probe in the
middle of an experiment makes it incomparable; start a new one.

## 6. Launch

`plan.readiness.score` is the share of priority traffic, weighted by region, whose routes pass on
the port. `portside status --gate` exits non-zero while any route fails.

## What needs a person

These change the bar the port is held to. Ask before running them, and pass the person's own words
as the reason:

- `portside lock --force --reason "…"`, `portside loosen … --reason "…"`
- adding to `allow`, or removing a route

Changing a probe changes what every case it measures is compared with: those locks go stale until
they are measured and locked again. Say so when you change one.

Never make a failing route pass by loosening it unless a person asked. A failing route is the tool
working.
