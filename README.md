# portside

Port a website route by route. Portside records what every route of the current site does over
HTTP, locks that in as a contract, and holds the new site to it, one route at a time: status codes
and redirects, headers, what the page declares to crawlers, whether a cache answered, and how fast
the first byte arrived.

It is built for moving between frameworks and hosts, such as off Next.js and Vercel, where the
rendering strategy, the cache and the database location all change at once. Matching the old
caching strategy is one way to keep a route fast; on new infrastructure it is often not the only
way. Portside judges both, and lets a route pass on speed alone when you decide its caching
strategy no longer matters.

The bar only moves up. When either site gets faster on a route, `portside ratchet` raises the bar
for both, so an improvement made during the port can be carried back to the current site, and the
two move together until the switch.

## Install

Portside needs Node 22.13 or later. It is not on npm yet; until it is, build it from this
repository:

```sh
git clone <this repository> portside && cd portside
pnpm install && pnpm build
pnpm link --global     # puts `portside` on your PATH
```

Once it is published, `npx @scenetest/portside` will do the same.

## Quick start

```sh
cd your-site
portside init --baseline-url https://www.example.com --candidate-url https://preview.example.dev
portside discover                     # routes and samples from the sitemap
portside run                          # every route on both sites, interleaved
portside lock                         # what the current site does becomes the contract
portside status                       # every route that does not meet it yet
portside serve                        # the same, live, at http://127.0.0.1:4800
```

Commit `portside.config.json` and `portside.lock.json`. `init` adds `.portside/`, where the
measurements live, to `.gitignore`.

## How it works

### Targets

A target is a running copy of the site: production, a preview deployment, `localhost`. The config
names one of them the baseline, usually the site you are porting from.

```json
{
  "baseline": "legacy",
  "targets": {
    "legacy": { "url": "https://www.example.com", "headers": { "x-bypass": "${BYPASS_SECRET}" } },
    "port": { "url": "https://preview.example.dev" },
    "local": { "url": "http://localhost:3000", "ratchet": false }
  }
}
```

`${NAME}` in a header reads the environment, so a WAF bypass secret stays out of the file. A
header whose variable is unset is not sent, and `run` says so.

### The inventory

`portside.lock.json` lists every route the site has, as a pattern (`/event/:city/:id`), with one
to three sample URLs and one or more cases. A case is a variation of the request that the site
answers differently: a cookie that sends a reader to another locale, a header that bypasses a
cache, a query string the site redirects away.

```sh
portside case add / es-cookie --cookie locale=es
portside case add /event/:city/:id with-query --query utm_source=x
portside case add /pricing logged-in --cookie session=test-session
```

The inventory is committed on purpose. When a route disappears in the port, it shows up as a
failing route rather than quietly leaving a glob.

Three sources fill it:

- **`--sitemap`** (the default) reads the baseline's sitemap, following sitemap indexes. Portside
  groups the URLs into patterns when it can. It cannot recover a route table from URLs alone, so
  declare the patterns you know with `portside route add` and rerun `discover --rebuild`, which
  folds the guesses nobody has touched into them.
- **`--next .next`** reads a Next.js build: every app and pages route, what the build declared for
  each (static, ISR and its window, on demand, dynamic), the paths it prerendered as samples, and
  the redirects in `next.config` with their `has` conditions as cases. It lists middleware
  matchers too, since middleware cannot be enumerated: add a case for each cookie or header it
  branches on.
- **`--urls top-pages.csv`** reads a list of paths, or an analytics export such as Plausible's or
  Google Analytics' top pages. Visit counts become route weights, and the heaviest routes sort
  first everywhere.

`discover` only adds. A route in the lock that no source lists any more is reported, not removed.

### Runs and batches

`portside run` requests every sample of every case on every target, six times each by default,
with redirects never followed. Each result goes into a local SQLite database as it arrives.

The targets in a run are interleaved request by request: legacy, port, legacy, port. Timings taken
minutes apart differ by whatever the machine and the network did in between, which on a laptop is
often more than the difference between the two sites. Interleaved, both sites share those
conditions, and the timing verdict compares them within the batch.

`--label` tags a run, so you can try a rendering strategy on the port and compare it with another:

```sh
portside run --target port --label isr-60 --route /event
portside compare port@dynamic port@isr-60
```

### Three verdicts per case

**Contract.** The status, the `Location` header, `content-type`, `cache-control` (except on HTML,
where every host sets its own), `vary`, `x-robots-tag`, and what an HTML page declares: `lang`, the
canonical URL and the robots meta tag. Locations and canonical URLs are kept as paths when they
point at the target's own host, with the sample's parameters templated back in, so
`/event/{city}/{id}` on one host matches the same on another. Two responses with the same error
status match whatever their bodies say.

**Cache.** Whether repeated requests were answered from a cache. Portside reads the hit and miss
headers CDNs and frameworks send (`cf-cache-status`, `x-vercel-cache`, `x-nextjs-cache`, `age` and
others) on every request after the first. Without one, it compares the bodies: a body that changes
on every request was rendered every time, and one that repeats byte for byte after changing was
served from a cache in between. Bodies that never change settle nothing, and the cache reads
`unknown`. Give the config a `renderStamp`, a regex for a token your pages render fresh each time,
and those become an answer too.

**Timing.** Time to first byte, from your machine, in the same batch:

| Situation                                                     | Verdict |
| ------------------------------------------------------------- | ------- |
| A target is slower than the baseline, in two batches in a row | fail    |
| A target is slower than the baseline in this batch only       | warn    |
| The baseline is slower than another target                    | warn    |
| Only timings from another run to compare with                 | warn    |
| The median is over a ceiling set with `loosen --ttfb`         | fail    |

"Slower" means the middle halves of the two distributions do not overlap and the medians differ by
at least 10% and 25 ms. The warning on the baseline is the cue to carry the port's change back.

**Cache policy.** Each route says how much a cache mismatch matters. `if-slower`, the default,
fails a route that lost its cache only when it also got slower, and warns when it is still fast
enough. `must-match` always fails; `ignore` never does.

```sh
portside route add /search --cache-policy ignore
```

### Lock, ratchet, loosen

`portside lock` writes what the baseline does today into the lock, case by case. From then on,
every target is judged by the lock rather than by the baseline's latest run. A case that already
has a lock keeps it; `lock --force --reason "..."` replaces it.

`portside ratchet` tightens every lock a target now beats while still meeting its contract: a
faster timing record, or `cached` where the lock said `uncached`. It never loosens.

`portside loosen` is the one way down, and it takes a reason, which the lock keeps beside the case:

```sh
portside loosen "/search#default" --cache none --reason "Search is per query; it was never really cached"
portside loosen "/event/:city/:id#default" --ttfb 250 --reason "250ms is fine for event pages on the new host"
portside loosen "/api/events#default" --drop cache-control --reason "The edge owns this header now"
```

A ceiling set with `--ttfb` settles timing for that case on every target: someone has decided what
is fast enough there.

A difference that every target will always have, such as a host that rewrites a header, goes in
the config's `allow` list instead, with a reason. `status` reports an allowance that matched
nothing, so the list does not outlive the differences it describes.

```json
"allow": [
  {
    "id": "edge-cache-control",
    "why": "Workers Cache keeps the route's policy at the edge and tells browsers to revalidate",
    "field": "cache-control",
    "path": "^/api/",
    "target": "port",
    "expected": "^public, ",
    "actual": "^private, max-age=0"
  }
]
```

### Directions

A reader reaches a route in more than one way, and a port can be fast in one and slow in another.
Each case has a direction, `hit` unless it says otherwise:

| Direction    | What it measures                                                              | Primary metric                            |
| ------------ | ----------------------------------------------------------------------------- | ----------------------------------------- |
| `hit`        | The same URL requested repeatedly, the way a warm cache answers it            | time to first byte                        |
| `revalidate` | A conditional request with the ETag or Last-Modified the first answer carried | time to first byte                        |
| `cold`       | The target's `purge` command, then one request, for every repeat              | time to first byte                        |
| `load`       | A fresh browser loading the page                                              | LCP, else `load`                          |
| `reload`     | The same browser loading it again, with its cache warm                        | LCP, else `load`                          |
| `navigate`   | A browser on `from` clicking the link to the route                            | the navigation's own response, or `ready` |
| `scene`      | A command of your own, such as a Playwright spec or a scenetest scene         | what it reports                           |

```sh
portside probe /event/:city/:id --direction hit,revalidate,cold,load,navigate --from /
```

`probe` adds a case for each direction the route lacks and measures that route on every target at
once. `case add --direction` adds one at a time.

**Cold** requests need a purge, because a cache-busting query string is not a cold request: vinext,
for one, leaves the query out of its page-cache key. Give each target a `purge` command, run with
`PORTSIDE_URL`, `PORTSIDE_PATH` and `PORTSIDE_TARGET` set, such as a call to your app's own
revalidation endpoint. Portside then checks the cache header on the answer: a request the cache
still answered is not counted as cold, and a route whose purge never takes reports that instead of
a number.

**Browser** directions need `playwright-core`, which portside loads only when a case asks for a
browser. Set `browser.executablePath` in the config, or `PORTSIDE_CHROMIUM`, to use a Chromium you
already have. Only the target's own requests decide when a page has settled, so a slow analytics
host does not count against the site. `navigate` ends when the framework's own response for the new
page has arrived, or when the case's `ready` selector shows, not when the network goes quiet: a
page may start an idle prefetch right after it renders. It also records `soft`, which is 0 when the
click loaded a whole document, as it does on a page that never hydrated, and `prefetched`.

A target's `headers` reach the browser only on the target's own origin, so a bypass secret never
goes to a third party, but intercepting requests to add them turns the browser's cache off. A
target's `cookies` are scoped to its domain by the browser itself and leave the cache alone, so a
WAF rule that matches a cookie is the better bypass for `reload`.

**Scenes** are named in the config:

```json
"scenes": {
  "search": { "command": "pnpm exec playwright test e2e/search.spec.ts", "primary": "durationMs", "repeats": 3 }
}
```

The command runs once per repeat per target, with `PORTSIDE_BASE_URL`, `PORTSIDE_TARGET` and
`PORTSIDE_PATH` set. It may write a JSON object of numbers to the file `PORTSIDE_METRICS` names.
`primary` picks the one the timing verdict reads; `durationMs`, the wall time, is always there.

### Experiments

An experiment is one theory, tried on a few routes, kept or thrown away, and written down so nobody
tries it twice. The ledger is `portside.experiments.json`, and it is committed.

```sh
portside experiment start "Cache the event page for 60s at the edge" --route /event --target port
# make the one change and deploy it
portside experiment measure 2026-10-21-cache-the-event-page-for-60s-at-the-edge
portside experiment decide 2026-10-21-cache-the-event-page-for-60s-at-the-edge keep \
  --why "TTFB 140ms faster, and events stay fresh enough at 60s"
```

`start` lists every experiment already tried on those routes, with its decision and reason, then
measures a before batch: the target and a reference, usually the baseline, interleaved. `measure`
takes an after batch the same way. The two batches are minutes apart, so the reference, which the
experiment did not touch, measures the drift between them, and each case's change is corrected by
it before it is called better, worse or noise. `measure` also checks the after batch against the
lock, and `decide … keep` refuses an experiment that broke the contract on any case.

## Commands

| Command                                        | What it does                                                  |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `init`                                         | Write the config and an empty lock                            |
| `discover [--sitemap] [--next DIR] [--urls F]` | Add routes, samples, cases and weights to the lock            |
| `route add <pattern> [--sample P]…`            | Add a route by hand; `route sample`, `weight`, `remove` too   |
| `case add <pattern> <id> [--cookie k=v]…`      | Add a variation of the request: `--header k:v`, `--query q`   |
| `routes`                                       | List the inventory                                            |
| `run [--target T]… [--label L] [--route P]…`   | Measure, every target interleaved in one batch                |
| `runs`                                         | Recent runs                                                   |
| `status [--all] [--markdown] [--gate]`         | Every route against its lock, heaviest failures first         |
| `show <route>[#case]`                          | One route on every target, with its lock and history          |
| `compare <before> <after>`                     | Two runs or targets head to head: `12`, `port`, `port@isr-60` |
| `lock [--from T] [--route P]… [--case K]…`     | Write expectations from a target's latest observations        |
| `ratchet [--dry-run]`                          | Tighten every lock a target now beats                         |
| `probe <route> --direction D,…`                | Add direction cases to a route and measure it now             |
| `experiment start "<theory>" --route P…`       | Show what was tried there, then measure a before batch        |
| `experiment measure <id>`                      | Measure the after batch, corrected for drift                  |
| `experiment decide <id> keep\|discard --why …` | Write the decision down                                       |
| `experiment list` / `experiment show <id>`     | The ledger                                                    |
| `loosen <route#case> --reason …`               | Lower a bar by hand: `--ttfb`, `--cache`, `--drop`, `--set`   |
| `serve [--port 4800]`                          | The dashboard, which updates as runs and locks land           |
| `guide`                                        | Instructions for an agent driving portside                    |

Every command takes `--json`. `status --gate` exits 1 when any route fails.

## Live sites

The targets can be any URLs. The loop is most useful against two production-like deployments side
by side: `www.` on the current platform and `port.` on the new one, each with its own CDN settings,
behind the same WAF rules. Portside then measures what readers would get, CDN, WAF and the distance
to the data included, rather than what a framework does on localhost.

- Run from a machine near your readers, and from the same machine every time. Timings say how the
  two sites compare from there.
- The WAF has to let the probe through on both sites. Use the same bypass on both, a header for the
  HTTP directions and a cookie for the browser ones, so neither site takes a different path
  through it.
- Purging `www.` to measure cold requests makes the next real reader's request cold too. Keep cold
  cases to the routes you are working on.
- Portside only makes `GET` requests: six per case by default, four cases at a time. Lower
  `probe.concurrency` if that is more than a production site should take from one client.

### Platform observability

Both platforms report what real readers got, which no probe from one machine can. Portside does not
read them yet. This is what each offers, checked on 2026-10-21:

- **Vercel**: `vercel metrics` queries request, function and Speed Insights metrics, such as
  `vercel.function_invocation.ttfb_ms` and `vercel.speed_insights.lcp_ms`, filtered and grouped by
  dimensions such as `requestPath`, with `--format json`. Metrics other than Web Analytics and
  Speed Insights need Observability Plus. `vercel logs requests --json` lists CDN request records,
  with fields such as `cacheResult`.
- **Cloudflare**: the Workers Observability API queries invocation telemetry, such as CPU time,
  request path, status and country, with percentiles, kept for seven days once `observability` is
  enabled in the Wrangler config. The zone's GraphQL Analytics API (`httpRequestsAdaptiveGroups`)
  has `edgeTimeToFirstByteMs` quantiles and `cacheStatus` per path, on Pro plans and up.

The `port.` site only has real readers once some traffic is sent to it.

## The dashboard

`portside serve` shows every route on every target, heaviest first, with what each one is
compared with and why it is not green. It can start runs, lock unlocked cases and ratchet. It
watches the database and the lock file, so a run or a lock made from the CLI, by you or by an
agent, appears on it as it happens.

## In CI

Run the baseline and the preview together and gate on the result:

```sh
portside run --target legacy --target preview
portside status --markdown > portside.md     # post it as a pull request comment
portside status --gate
```

The measurements live in `.portside/`, which is not committed, so cache it between jobs if you
want the two-batch confirmation to span runs. Timing from a CI runner says how the sites compare
from that runner; contract and cache verdicts do not depend on where they run.

## With an agent

`portside guide` prints instructions for a coding agent: the loop, the JSON each command returns,
and what to bring back to a person rather than decide alone. Point your agent at it, or paste it
into its instructions.

## Limits

- Timing is measured from where portside runs. The browser directions measure one Chromium on one
  machine, not your readers' devices.
- Cache detection is a best effort without a hit header or a `renderStamp`. A route that reads
  `unknown` is not judged on caching.
- Pattern inference from a sitemap is a starting point. A framework's route table is better.
- Only `GET` requests are made. Portside never submits a form or calls a mutating route.

## Development

```sh
pnpm install
pnpm test          # unit tests and an end-to-end run against two local fixture sites
pnpm typecheck
pnpm build
pnpm format
```

[docs/design.md](docs/design.md) records why it works the way it does.
