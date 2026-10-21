// A client-side navigation: a browser on conditions.from clicks the link to the route.
//
// conditions.from: the page to start on (required)
// conditions.link: a selector for the link, if `a[href="<path>"]` does not find it
// conditions.ready: a selector that means the new page has what a reader came for
//
// The navigation ends when the framework's own response for the new page has arrived, or when
// `ready` shows, not when the network goes quiet: a page may start an idle prefetch as soon as it
// renders. `soft` is 0 when the click loaded a whole document, which is what a page that never
// hydrated does; `prefetched` is 1 when the router used a prefetch and made no request.
//
// Revisit for each stack: which request carries the new page (Next and vinext send an RSC fetch
// with `_rsc`, TanStack Start loads route data its own way), and how its end can be seen.

import { openPage, watch } from "./page.mjs"

const QUIET_MS = 300

export default {
  describe: "A browser clicks into the route from another page",
  primary: "navMs",
  repeats: 5,
  sequential: true,

  async measure(ctx) {
    const from = ctx.conditions.from
    if (!from) throw new Error("navigate needs conditions.from, the page whose link it clicks")
    const { context, page, origin } = await openPage(ctx)
    try {
      const quiet = watch(page, origin)
      await page.goto(new URL(String(from), ctx.target.url).href, { waitUntil: "load" })
      // Clicking before the page hydrates follows the link as a plain document load.
      await quiet()
      const selector =
        ctx.conditions.link ??
        `a[href="${ctx.path}"], a[href$="${new URL(ctx.target.url).host}${ctx.path}"]`
      const link = page.locator(String(selector)).first()
      if ((await link.count()) === 0) throw new Error(`${from} has no link to ${ctx.path}`)

      const target = ctx.path.split("?")[0]
      let main
      let endedAt
      const pathOf = (url) => new URL(url).pathname
      // Only a request the click started: a prefetch made while the link was in view is not
      // this navigation.
      const onRequest = (r) => {
        if (
          !main &&
          r.resourceType() !== "image" &&
          new URL(r.url()).origin === origin &&
          pathOf(r.url()).startsWith(target)
        )
          main = r
      }
      const onFinished = (r) => {
        if (r === main) endedAt ??= Date.now()
      }
      // vinext's router aborts its RSC fetch once it has read the payload, so a request that
      // failed with net::ERR_ABORTED after a 200 is a navigation that finished.
      const onFailed = async (r) => {
        if (r !== main) return
        const at = Date.now()
        if (await r.response().catch(() => null)) endedAt ??= at
      }
      page.on("request", onRequest)
      page.on("requestfinished", onFinished)
      page.on("requestfailed", onFailed)
      const clickedAt = Date.now()
      await link.click()
      await page.waitForURL((u) => u.pathname === target)
      const urlAt = Date.now()
      let readyAt
      if (ctx.conditions.ready) {
        await page.waitForSelector(String(ctx.conditions.ready), { state: "visible" })
        readyAt = Date.now()
      }
      await page.waitForTimeout(QUIET_MS)
      const response = main ? await main.response() : null
      const timing = main?.timing()
      const responseMs = endedAt === undefined ? undefined : endedAt - clickedAt
      const metrics = {
        navMs: readyAt !== undefined ? readyAt - clickedAt : (responseMs ?? urlAt - clickedAt),
        urlMs: urlAt - clickedAt,
        soft: main ? (main.resourceType() === "document" ? 0 : 1) : 1,
        prefetched: main ? 0 : 1,
      }
      if (responseMs !== undefined) metrics.responseMs = responseMs
      if (timing && timing.responseStart >= 0) metrics.ttfb = timing.responseStart
      const headers = response ? await response.allHeaders() : {}
      return {
        metrics,
        record: response ? { status: response.status() } : undefined,
        served: ctx.servedFrom(headers),
      }
    } finally {
      await context.close()
    }
  },
}
