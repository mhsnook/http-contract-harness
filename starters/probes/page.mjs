// A real browser loading the page, from a fresh profile each repeat.
//
// conditions.reload: true loads the page, then reloads it in the same browser and measures the
//   reload, with the browser's cache warm.
// conditions.ready: a selector that means the page has what a reader came for; the probe waits
//   for it before reading the timings.
//
// The primary metric is LCP, falling back to the load event. Revisit for each stack: which
// metric says the page is usable (a dashboard might want a selector, a blog LCP), and whether the
// page keeps requests open, which the quiet-network wait below excludes only for other origins.

const QUIET_MS = 300

export function watch(page, origin) {
  const open = new Set()
  let last = Date.now()
  const counts = (r) =>
    !["eventsource", "websocket"].includes(r.resourceType()) && new URL(r.url()).origin === origin
  page.on("request", (r) => counts(r) && (open.add(r), (last = Date.now())))
  const end = (r) => open.delete(r) && (last = Date.now())
  page.on("requestfinished", end)
  page.on("requestfailed", end)
  return async (timeout = 20_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (open.size === 0 && Date.now() - last >= QUIET_MS) return last
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(
      `still loading: ${[...open]
        .slice(0, 3)
        .map((r) => new URL(r.url()).pathname)
        .join(", ")}`,
    )
  }
}

export async function openPage(ctx) {
  const browser = await ctx.browser()
  const context = await browser.newContext()
  const origin = new URL(ctx.target.url).origin
  const cookies = Object.entries(ctx.target.cookies)
  if (cookies.length)
    await context.addCookies(cookies.map(([name, value]) => ({ name, value, url: origin })))
  const headers = { ...ctx.target.headers, ...ctx.headers }
  // Same-origin only, so a bypass secret never reaches a third party. Intercepting requests turns
  // the browser cache off, which is why cookies are the better bypass for a reload.
  if (Object.keys(headers).length) {
    await context.route(
      (url) => url.origin === origin,
      (route) => route.continue({ headers: { ...route.request().headers(), ...headers } }),
    )
  }
  await context.addInitScript(() => {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__lcp = e.startTime
    }).observe({ type: "largest-contentful-paint", buffered: true })
  })
  return { context, page: await context.newPage(), origin }
}

export default {
  describe: "A browser loads the page, or reloads it warm",
  primary: "lcp",
  repeats: 5,
  sequential: true,

  async measure(ctx) {
    const { context, page, origin } = await openPage(ctx)
    try {
      const quiet = watch(page, origin)
      const url = new URL(ctx.path, ctx.target.url).href
      let response = await page.goto(url, { waitUntil: "load" })
      if (ctx.conditions.reload) {
        await quiet()
        response = await page.reload({ waitUntil: "load" })
      }
      await quiet()
      if (ctx.conditions.ready)
        await page.waitForSelector(String(ctx.conditions.ready), { state: "visible" })
      const t = await page.evaluate(() => {
        const nav = performance.getEntriesByType("navigation")[0]
        return {
          ttfb: nav?.responseStart,
          dcl: nav?.domContentLoadedEventEnd,
          load: nav?.loadEventEnd,
          lcp: window.__lcp,
        }
      })
      const metrics = Object.fromEntries(Object.entries(t).filter(([, v]) => typeof v === "number"))
      metrics.lcp ??= metrics.load
      const headers = response ? await response.allHeaders() : {}
      return {
        metrics,
        record: response ? { status: response.status() } : undefined,
        served: ctx.servedFrom(headers),
        evidence: { hint: ctx.cacheHint(headers).header },
      }
    } finally {
      await context.close()
    }
  },
}
