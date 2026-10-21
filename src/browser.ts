import type { Browser, BrowserContext, Page, Request, Response } from "playwright-core"
import type { CaseDef, Config } from "./config.ts"

export type Measured = {
  primary: number
  metrics: Record<string, number>
  status?: number
  headers?: Record<string, string>
}

export type BrowserSide = {
  url: string
  headers: Record<string, string>
  cookies?: Record<string, string>
}

export async function openBrowser(config: Config): Promise<Browser> {
  let playwright: typeof import("playwright-core")
  try {
    playwright = await import("playwright-core")
  } catch {
    throw new Error(
      "The load, reload and navigate directions drive a browser: install playwright-core next to portside (pnpm add -D playwright-core)",
    )
  }
  return playwright.chromium.launch({
    headless: config.browser.headless,
    executablePath: config.browser.executablePath ?? process.env.PORTSIDE_CHROMIUM,
  })
}

async function contextFor(browser: Browser, side: BrowserSide, extra: Record<string, string>) {
  const context = await browser.newContext()
  const origin = new URL(side.url).origin
  if (side.cookies) {
    await context.addCookies(
      Object.entries(side.cookies).map(([name, value]) => ({ name, value, url: origin })),
    )
  }
  const headers = { ...side.headers, ...extra }
  if (Object.keys(headers).length > 0) {
    // Same-origin only: a bypass secret sent to every origin would reach analytics and font hosts.
    await context.route(
      (url) => url.origin === origin,
      (route) => route.continue({ headers: { ...route.request().headers(), ...headers } }),
    )
  }
  await context.addInitScript(() => {
    const w = window as unknown as { __portsideLcp?: number }
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__portsideLcp = entry.startTime
    }).observe({ type: "largest-contentful-paint", buffered: true })
  })
  return context
}

// Only the target's own requests count: a third party that hangs, or a stream that never ends,
// would otherwise keep a page from ever settling.
function watchNetwork(page: Page, origin: string) {
  const inFlight = new Set<Request>()
  let lastActivity = Date.now()
  const counts = (r: Request) =>
    !["eventsource", "websocket"].includes(r.resourceType()) && new URL(r.url()).origin === origin
  page.on("request", (r) => {
    if (!counts(r)) return
    inFlight.add(r)
    lastActivity = Date.now()
  })
  const end = (r: Request) => {
    if (inFlight.delete(r)) lastActivity = Date.now()
  }
  page.on("requestfinished", end)
  page.on("requestfailed", end)
  return {
    reset: () => {
      lastActivity = Date.now()
    },
    quiet: async (quietMs: number, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (inFlight.size === 0 && Date.now() - lastActivity >= quietMs) return lastActivity
        await new Promise((r) => setTimeout(r, 25))
      }
      const open = [...inFlight].slice(0, 3).map((r) => new URL(r.url()).pathname)
      throw new Error(
        `the network never went quiet for ${quietMs}ms; still open: ${open.join(", ")}`,
      )
    },
  }
}

async function pageTimings(page: Page) {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming
    const lcp = (window as unknown as { __portsideLcp?: number }).__portsideLcp
    return {
      ttfb: nav ? nav.responseStart : undefined,
      domContentLoaded: nav ? nav.domContentLoadedEventEnd : undefined,
      load: nav ? nav.loadEventEnd : undefined,
      lcp,
    }
  })
}

const defined = (values: Record<string, number | undefined>) =>
  Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === "number")) as Record<
    string,
    number
  >

const pathOf = (url: string) => {
  const u = new URL(url)
  return u.pathname + u.search
}

async function fullLoad(page: Page, url: string, def: CaseDef, quietMs: number, reload: boolean) {
  const network = watchNetwork(page, new URL(url).origin)
  let response: Response | null
  if (reload) {
    await page.goto(url, { waitUntil: "load" })
    await network.quiet(quietMs)
    response = await page.reload({ waitUntil: "load" })
  } else {
    response = await page.goto(url, { waitUntil: "load" })
  }
  await network.quiet(quietMs)
  if (def.ready) await page.waitForSelector(def.ready, { state: "visible" })
  const t = await pageTimings(page)
  const metrics = defined(t)
  return {
    primary: t.lcp ?? t.load ?? 0,
    metrics,
    status: response?.status(),
    headers: response ? await response.allHeaders() : undefined,
  }
}

/**
 * A soft navigation: load `from`, click the link to the sample, and time from the click until the
 * framework's own requests for the new page have finished, or `ready` is visible.
 */
async function navigate(
  page: Page,
  side: BrowserSide,
  path: string,
  def: CaseDef,
  quietMs: number,
) {
  if (!def.from) throw new Error("a navigate case needs `from`, the page whose link it clicks")
  const network = watchNetwork(page, new URL(side.url).origin)
  await page.goto(new URL(def.from, side.url).href, { waitUntil: "load" })
  await network.quiet(quietMs)

  const link = page
    .locator(def.link ?? `a[href="${path}"], a[href$="${new URL(side.url).host}${path}"]`)
    .first()
  if ((await link.count()) === 0) throw new Error(`${def.from} has no link to ${path}`)

  const target = path.split("?")[0] as string
  // Only requests the click started: a prefetch made while the link was in view is not this
  // navigation, and a navigation the router serves from its prefetch cache makes no request.
  let main: Request | undefined
  let mainEndedAt: number | undefined
  const onRequest = (r: Request) => {
    if (!main && r.resourceType() !== "image" && pathOf(r.url()).startsWith(target)) main = r
  }
  const onFinished = (r: Request) => {
    if (r === main) mainEndedAt ??= Date.now()
  }
  // vinext's router aborts its RSC fetch once it has read the payload, so a request that "failed"
  // with net::ERR_ABORTED after a 200 is a navigation that finished.
  const onFailed = async (r: Request) => {
    if (r !== main) return
    const at = Date.now()
    if (await r.response().catch(() => null)) mainEndedAt ??= at
  }
  const clickedAt = Date.now()
  page.on("request", onRequest)
  page.on("requestfinished", onFinished)
  page.on("requestfailed", onFailed)
  network.reset()
  await link.click()
  await page.waitForURL((u) => u.pathname + u.search === path || u.pathname === target)
  const urlAt = Date.now()
  const settledAt = await network.quiet(quietMs)
  let readyAt = settledAt
  if (def.ready) {
    await page.waitForSelector(def.ready, { state: "visible" })
    readyAt = Date.now()
  }
  page.off("request", onRequest)
  page.off("requestfinished", onFinished)
  page.off("requestfailed", onFailed)
  const timing = main?.timing()
  const response = main ? await main.response() : null
  // Settling waits for whatever the new page starts in the background, such as an idle prefetch,
  // so the navigation itself ends when its own response has arrived, or when `ready` shows.
  const responseMs = mainEndedAt === undefined ? undefined : mainEndedAt - clickedAt
  const readyMs = def.ready ? readyAt - clickedAt : undefined
  const navMs = readyMs ?? responseMs ?? urlAt - clickedAt
  return {
    primary: navMs,
    metrics: defined({
      navMs,
      responseMs,
      readyMs,
      settledMs: settledAt - clickedAt,
      ttfb: timing && timing.responseStart >= 0 ? timing.responseStart : undefined,
      // 0 when the click loaded a whole document, as it does when the page never hydrated.
      soft: main ? (main.resourceType() === "document" ? 0 : 1) : 1,
      prefetched: main ? 0 : 1,
    }),
    status: response?.status(),
    headers: response ? await response.allHeaders() : undefined,
  }
}

export async function measureInBrowser(
  browser: Browser,
  side: BrowserSide,
  path: string,
  def: CaseDef,
  config: Config,
): Promise<Measured> {
  let context: BrowserContext | undefined
  try {
    context = await contextFor(browser, side, def.headers ?? {})
    const page = await context.newPage()
    const url = new URL(path, side.url).href
    const { quietMs } = config.browser
    if (def.direction === "navigate") return await navigate(page, side, path, def, quietMs)
    return await fullLoad(page, url, def, quietMs, def.direction === "reload")
  } finally {
    await context?.close()
  }
}
