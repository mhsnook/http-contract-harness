---
name: http-contract-harness
description: Port a website to a new framework or host route by route with the HTTP contract harness (hch). Use when asked to port, migrate or re-platform a site (for example Next.js to TanStack Start, or Vercel to Cloudflare), to check a route still behaves and performs as it did, to benchmark the current site, to try a rendering or caching strategy on a route, or when a harness.config.json is present.
---

# Porting a site with the HTTP contract harness

The harness (`hch`, short for `http-contract-harness`) keeps the record of a port: every route,
every measurement, the contract the port is held to, the experiments tried and what was learned.
You decide how things are measured, by writing probes, and you do the port.

Run every command with `--json` and read the JSON. Start every session with:

```sh
hch plan --json
```

It names the current phase, its checks, and the next commands. Work the phases in order.

## The phases

1. **survey**: which routes readers view and land on, and where they are. Enable a source in
   `harness/sources/` (rename a `_starter` after checking it against the real account) or use
   `hch survey --csv <export>`. Then `hch survey --regions`.
2. **inventory**: every route, with samples and the cases that reach it differently. `hch discover`,
   `--next .next`, `--traffic`; `hch route add`; `hch case add <route> <id> --probe <p> --condition k=v`.
3. **profile**: benchmark the current site on every track, usually dev mode and production. Read
   the probes in `harness/probes/` first and change them if they do not count what matters for
   this stack. Then `hch run`, `hch lock`, and `hch note "<finding>" --route <route>` for anything
   you learned about the stack.
4. **parity:dev**, then **parity:production**: bring the port up to the current site, in dev mode
   first, then deployed. `hch run`, `hch status --json`, `hch show "<route>" --json`. Heaviest
   failing priority routes first. `hch prompt "<route>" --target <port>` says what differs and how
   to check a fix. A timing failure needs two batches in a row; one warning that says "run again to
   confirm" calls for another run, not a change.
5. **improve**: one theory at a time.
   1. `hch experiment list --route <route> --json` and `hch notes --route <route> --json`. Do not
      repeat a discarded idea unless something it depended on has changed.
   2. `hch experiment start "<theory>" --route <route> --json` measures before.
   3. Change one thing and deploy it.
   4. `hch experiment measure <id> --json`. `change` is corrected for drift; `broken` names a case
      whose contract broke.
   5. `hch experiment decide <id> keep|discard --why "<what you measured and why it settles it>"`.
6. **launch**: `plan.readiness.score` is the share of priority traffic, weighted by region, that
   passes on the production port.

## Probes are yours

A probe in `harness/probes/` decides what a measurement means: how a cold request is made, when a
page counts as loaded, when a client navigation has finished, which response fields form the
contract. The starters (`http`, `page`, `navigate`, `command`) say at the top what they assume.
Changing a probe makes its existing locks stale until the cases are measured and locked again;
say so when you change one.

## Ask a person before

- `hch lock --force`, `hch loosen`: they change the bar. Pass the person's words as `--reason`.
- adding to `allow` in `harness.config.json`, or removing a route.

Never make a failing route pass by loosening it unless a person asked. A failing route is the
harness working.

`hch guide` prints the full guide.
