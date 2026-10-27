# Porting a site with the HTTP contract harness

You are porting a site, route by route. The harness keeps the record: the routes, every measurement,
the contract the port is held to, the experiments and what was learned. You decide how things are
measured, by writing probes, and you do the port. Pass `--json` to every command and read the JSON.

Start every session with `hch plan --json`. It names the current phase, its checks, and the
next commands. Work the phases in order.

## The files

- `harness.config.json`: targets, vantages, regions, allowed differences. A person owns it;
  change it when they ask, or when a command says to.
- `harness.lock.json`: the routes, their samples and cases, and what each case is held to.
  Commands write it.
- `harness.ledger.json`: experiments and findings. Commands write it.
- `harness/probes/*.mjs`: how things are measured. Yours to write and change.
- `harness/sources/*.mjs`: where traffic numbers come from. Yours to write and change. A file
  starting with `_` is switched off.
- `.harness/harness.db`: every measurement. Never edit it.

## 1. Survey

Find out which routes matter and where readers are, before measuring anything.

- Write or enable a source for the analytics the site has. Read the starter for that platform,
  check its queries against the real account, then rename it without the `_`. Without an API, ask
  for an export and use `hch survey --csv <file>`.
- `hch survey --regions --json`. Read `routes` (views and entries per route), `uncovered`
  (traffic no route matches) and `regions`.
- Entries matter as much as views: a route readers land on from search or a link is where a slow
  first load costs the most.

## 2. Inventory

- `hch discover` (the sitemap), `--next .next` on a Next.js app, and `--traffic` for the
  surveyed paths. Declare patterns you know with `hch route add` and run
  `hch discover --rebuild` to fold the guesses into them.
- For each priority route (`plan.priority`), add a case for every way readers reach it that the
  site answers differently: a locale cookie, a logged-in session, a query the proxy redirects, a
  client-side navigation, a cold cache. `hch case add <route> <id> --probe <p> --condition k=v`.

## 3. Profile

- Read the starter probes before running them, and decide whether each one counts what matters
  for this site. If not, change it, or copy it under a new name and change that. Things to decide
  per stack:
  - how a cold request is made: what purges the cache, and whether a query string reaches the key
  - when a page counts as loaded: LCP, a selector, the load event
  - when a client-side navigation has finished, and which request carries the new page
  - which response fields belong in the contract
- `hch run --target <baseline> --json` for the current site's target on every track (the profile
  phase's `next` names them), from every vantage the plan asks for.
- `hch lock --from <baseline>`. Only production is locked; a dev track compares its two dev
  servers batch by batch.
- Record what you learned about the stack: `hch note "<finding>" --route <route> --tag <tag>`.
  Write the finding so the next agent can act on it without repeating your work.

## 4. Parity

There is one parity phase per track, in the order the config lists them, usually `parity:dev`
then `parity:production`. Dev parity is the cheaper loop: fix it there, then deploy and confirm.

- `hch run --target <track baseline> --target <track port> --json`, then `hch status --json`. Work on the heaviest failing priority
  routes first. `hch show "<route>" --json` explains one: `contract.diffs` (field, expected,
  actual, policy), `perf` (metric, actual, baseline, against, paired, call, note), and `stale` when
  the lock was taken with another version of the probe.
- A timing failure needs two batches in a row. A single warning that says "run again to confirm"
  calls for one more run, not a change.
- A warning on the current site that says "carry it back?" means the port is faster on that
  route. Tell a person; the change may be worth making on the current site too.

## 5. Improve

Every change made to speed a route up runs the same way:

1. **Check what was tried.** `hch experiment list --route <route> --json` and
   `hch notes --route <route> --json`. Do not repeat a discarded idea unless something it
   depended on has changed; say what.
2. **Read the route** with `hch show`, and the platform's own numbers when you have access.
   Form one theory.
3. **Measure before.** `hch experiment start "<theory>" --route <route> --json`.
4. **Change one thing**, and deploy it to the target.
5. **Measure after.** `hch experiment measure <id> --json`. `result.cases[].change` is
   corrected for drift; `deltaMs` is the corrected change; `broken` names a case whose contract the
   change broke.
6. **Decide and write it down.** `hch experiment decide <id> keep|discard --why "…"`, saying
   what you measured and why it settles the theory. Add a finding if you learned something about
   the stack.

`noise` is a result: the change did not move the route enough to see. Changing a probe in the
middle of an experiment makes it incomparable; start a new one.

## 6. Launch

`plan.readiness.score` is the share of priority traffic, weighted by region, whose routes pass on
the port. `hch status --gate` exits non-zero while any route fails.

## What needs a person

These change the bar the port is held to. Ask before running them, and pass the person's own words
as the reason:

- `hch lock --force --reason "…"`, `hch loosen … --reason "…"`
- adding to `allow`, or removing a route

Changing a probe changes what every case it measures is compared with: those locks go stale until
they are measured and locked again. Say so when you change one.

Never make a failing route pass by loosening it unless a person asked. A failing route is the tool
working.
