# Design

The harness grew out of the HTTP contract suite, the cross-framework comparison and the timing
recorder written for one Next.js → vinext port (findaprotest.info, moving from Vercel to Cloudflare
Workers). This records what it kept from them, what it changed, and why.

## The method in the tool, the measuring in the project

The first two versions measured things themselves: a fixed set of directions (warm, revalidate,
cold, load, reload, navigate), each with its own logic for busting a cache or deciding when a page
had settled. Every one of those decisions turned out to be specific to the stack it was worked out
on: vinext leaves the query string out of its page-cache key, its router aborts the RSC fetch it
has just read, findaprotest prefetches its event list as soon as a page goes idle. A port to
TanStack Start would need different answers, and the agent doing that port is the one placed to
find them.

So the measuring moved into the project, as probes and sources the agent writes, and the tool
kept what does not change from one stack to the next:

- the record: runs, batches, observations, traffic, the lock, experiments and findings
- how numbers are judged: interleaved batches, paired comparison, drift correction, confirmation
  across batches, field policies
- comparability: a probe's version is a hash of its code, and numbers from two versions are never
  compared
- the phases, and what each needs before the next makes sense

The direction logic survives as starter probes, with what each one assumes written at the top.

## What lives where

| What                                            | Where                   | Committed | Written by           |
| ----------------------------------------------- | ----------------------- | --------- | -------------------- |
| Targets, vantages, regions, allowed differences | `harness.config.json`   | yes       | a person             |
| Routes, samples, cases, expectations            | `harness.lock.json`     | yes       | the CLI and a person |
| Experiments and findings                        | `harness.ledger.json`   | yes       | the CLI              |
| How things are measured                         | `harness/probes/*.mjs`  | yes       | the agent            |
| Where traffic numbers come from                 | `harness/sources/*.mjs` | yes       | the agent            |
| Every measurement and every traffic import      | `.harness/harness.db`   | no        | `run`, `survey`      |

The inventory is committed because a route that disappears is the failure a port most often
causes and least often notices. The contract suite this came from kept its routes as a literal
list for the same reason: a glob over the app directory passes when a route goes away.

The lock is the ratchet's memory and it changes in review: every lock, tightening and loosening
shows up in a diff, and each case keeps its own history with the reason for each change. Keys are
sorted on write, so two people locking the same routes produce the same file.

Measurements are local because they are large, machine-specific and only meaningful next to the
ones taken in the same batch. SQLite through `node:sqlite` needs no native build, which keeps
`npx` working.

## Normalising responses

From the contract suite: keep only what two runs of the same build agree on, and what a port has
to reproduce. Status, `Location`, `content-type`, non-HTML `cache-control`, `vary` and
`x-robots-tag`, plus `<html lang>`, the canonical URL and the robots meta tag from HTML bodies.
Everything per-request (`date`, `etag`, `set-cookie`, `cf-ray`, `x-vercel-id`) is dropped. HTML
`cache-control` is dropped by default because every host and CDN rewrites it.

Every request is made with redirects off. Followed, a 301 → 200 chain reads as a 200, and every
redirect the site promises stops being checked.

Locations and canonical URLs that point at the target's own host are stored as paths, and the
sample's parameter values are replaced by their names, whole segments only. An earlier version
replaced substrings and skipped one-character values to avoid false matches; then `/event/london/1`
stayed `/event/{event}/1`, every sample disagreed with the lock, and the fixture site's own
baseline failed against itself.

## Probe versions

A probe's version is a SHA-256 over its file and every local module it imports, transitively. The
starter `navigate` imports `page`, so editing `page` is a new version of both. Each observation
stores the version that took it, and each lock stores the version it was taken with. A case whose
lock and latest measurement disagree reads as stale and is not judged; experiments refuse to
compare a before and an after taken by different versions. Probes are imported with their hash in
the URL, because Node caches modules by URL and a long `serve` would otherwise keep running old
code. Runners receive the whole bundle and check its hash before running it.

## Detecting a cache (the `http` starter)

The contract suite could not tell a cached route from an uncached one, because the edge gives every
client the same `private, max-age=0, must-revalidate`. The manual check was to request a page whose
React keys came from `uuidv4()` several times and compare hashes. The harness does that on every route:

1. A hit header (`cf-cache-status`, `x-vercel-cache`, `x-nextjs-cache`, `x-vinext-cache`,
   `x-cache`, `age`, …) on any request after the first is a hit. Every request after the first
   reading miss or bypass is uncached.
2. Otherwise a `renderStamp` regex, when the case's conditions give one, compares a token the page renders
   fresh each time.
3. Otherwise the bodies: different on every request means rendered every time; a repeat after a
   change means a cache answered in between; identical every time settles nothing.

Against findaprotest's local production build, `/about` read "body changed on all 5 requests",
which matches the documented finding that `wrangler dev` has no edge cache. The home page, whose
bodies are deterministic, reads `unknown`, and is not judged on caching.

## Timing

This took three attempts, each measured against the same findaprotest build serving both targets,
where any failure is a false one.

1. **A fixed budget per case** (the baseline's p75 plus 20%, at least 25 ms). Four of 28 routes
   failed on the first run after locking. A budget from a handful of samples cannot absorb a
   laptop's variance.
2. **The locked distribution**, failing only when the two middle halves separate and the median
   moves by 10% and 25 ms. Across five separate runs: 2, 2, 1, 1 and 9 false failures. In the run
   with 9, every route was about 30 ms slower. The drift was between runs, and no statistic inside
   one run removes it.
3. **Interleaved batches.** `run` requests the targets in turn, alternating which goes first, and
   the verdict compares targets within the batch. Five batches, two targets, 28 routes: no false
   failures.

A real slowdown had to show up as well. A proxy in front of the port that added 60 ms to event
pages failed exactly the three event cases from the second batch on. The same proxy with no added
delay still costs about 8–12 ms at the median, with tails past 40 ms, and a different two or three
undelayed routes crossed the bar in each batch. That is why a slowdown needs two batches in a row
to fail: the first is a warning that asks for another run.

Timings from a different batch, such as the lock's own record or a run of one target alone, only
ever warn. The lock still keeps the baseline's distribution, as a record the ratchet moves down
and as the fallback when nothing is paired.

A ceiling set by hand (`loosen --ttfb`) settles the timing verdict on every target, since a person
has decided what is fast enough for that route.

## What the starter probes encode

Each of these came out of reading what the frameworks do, or out of a measurement that came back
wrong.

- **Cold needs a purge.** The usual cold-cache trick, a unique query string per request, does not
  work on vinext 1.0: its shared page cache builds the key without the user query ("The user query
  leaves both the URL and `resolvedUrl`", in `createSharedAppPageCacheIdentity`). A purge command
  per target replaces it, and the cache header on each answer confirms the request missed, so a
  purge that did not take cannot pass for a cold render.
- **Client navigation needs a browser.** vinext's RSC request carries a `.rsc` suffix, a validated
  `_rsc` cache-busting value, and render-mode, router-state and mounted-slot headers; Next's
  differs. Reproducing either by hand would mean reimplementing each framework's client router, so
  `navigate` clicks a real link and lets the framework make its own requests.
- **A navigation ends at its own response.** On findaprotest, time until the network went quiet
  read about 1.6 s for `/` → `/about`. Nearly all of it was the `/api/events` prefetch that starts
  once the page goes idle. The click's own RSC response arrived in 120–250 ms.
- **An aborted RSC fetch can be a finished one.** vinext's router aborts its RSC fetch after
  reading it, so Playwright reports `net::ERR_ABORTED` on a request that answered 200 with
  `text/x-component`. `navigate` counts such a request as finished.
- **Only the target's own requests decide when a page has settled.** On the first try the home
  page never settled, because third-party requests stayed open.
- **A bypass secret stays on its origin.** Playwright's `extraHTTPHeaders` sends headers to every
  origin a page touches, so the harness adds them by intercepting the target's own requests only,
  which turns the browser cache off. Cookies are scoped by the browser and leave the cache alone.

## Experiments

An experiment's before and after batches are minutes apart, which is the drift problem from
**Timing** again. The reference target is untouched by the experiment, so its median's change
between the two batches is taken as the drift, and the target's change is corrected by it before it
is called. The ledger is a committed JSON file rather than rows in the database, because its point
is that the next person or agent sees what was tried and why it was kept or thrown away.

## Running in concert

A route's bar is shared by every target. When the port beats the lock, `ratchet` raises it for
the current site too, and the current site shows a warning naming the faster target. That is the
point at which an improvement found during the port gets carried back, so both sites move up
together and the switch itself changes as little as possible. A target with `ratchet: false`,
such as `localhost`, never moves the bar.

## Survey and phases

Before measuring, the port needs to know which routes matter. Sources return rows of path, views,
entries and country; `survey` stores the latest import from each source, ranks routes by views and
by entries separately, since a route readers land on from outside pays for a slow first load in a
way a route reached by clicking does not, and lists the traffic no route in the inventory covers.
The priority routes are the smallest set holding 80% of the views, joined with the smallest set
holding 80% of the entries.

Countries map to coarse regions, because a country cannot say which side of North America a
reader is on. A source that knows better can report a region itself.

`plan` is computed, never stored: from the traffic, the lock, the database and the ledger, it
works out which phase's checks still fail. A phase only counts as done when every phase before it
is, so an empty project does not read as having finished parity on no routes at all.

## Vantages

A vantage is where a batch runs: this machine, or a runner on another one that receives the
probes' code and streams observations back. Regional measurement needs a machine in the region,
and a runner on a small VM in each region a site's readers are in is the plainest way to get one.

Cloudflare offers regional placement, with limits checked on 2026-10-21: Browser Run takes no
region parameter and opens sessions near whatever launches them; Durable Object location hints and
Worker placement regions both place code as a best effort and say nothing about where outbound
requests originate. A Browser Run session can still serve a vantage through `browser.cdp`. Because
none of it is guaranteed, probes report where the platform says it answered, and that, not the
vantage's label, is the evidence. A probe running inside Cloudflare's network that requests a
Cloudflare-hosted port does not cross the internet, while the same probe to another host does,
which flatters the port; the comparison is fairest from outside both platforms.

## Toward SceneTest Cloud

The verdict functions take observations and a lock and return plain data, with no I/O, so they
can run anywhere observations can be read. The likely path, once the standalone tool has users:

- A runner box records a batch, the same way it records scenes, and uploads the observations.
- The PR coordinator stores them next to the run's event log and evaluates against the lock in
  the PR's head commit, which is already in the box.
- The dashboard renders the same per-route table, and `status --markdown` becomes a PR comment.
- The pass/fail policy table in scenetest-cloud's `gate.cjs` (`no-new`, `must-pass`, budgets)
  maps onto the cache policy and allowances here; the two should converge on one vocabulary.

## Not built yet

- A Cloudflare runner: a Worker and Durable Objects with location hints that run probes and launch
  Browser Run sessions. Probes would have to be bundled into it at deploy time, since a Worker
  cannot evaluate code it receives.
- More route tables: the vinext route table from its build output, Astro, Remix, SvelteKit.
- Reading real readers' timing per route from the platforms (Speed Insights and `vercel.function_invocation.ttfb_ms` on
  Vercel, `edgeTimeToFirstByteMs` on Cloudflare) beside the probes' numbers. The survey reads
  traffic from them already, through sources.
- Sending a share of real traffic to the port, so its platform numbers mean something.
- An MCP server over the same commands.
- Sharing measurements across a team, for example by syncing the SQLite file to object storage.
