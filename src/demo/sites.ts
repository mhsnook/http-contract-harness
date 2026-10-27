import { randomUUID } from "node:crypto"
import { createServer, type Server } from "node:http"

export type SiteKind = "current" | "current-dev" | "port-dev" | "port"

// What a fix "deployed" during the demo changes. The port starts with a redirect that changed
// status and an event page its new host does not cache. `prerender` changes nothing a reader
// sees, which is the point of the experiment that tries it.
export type Fixes = { redirect: boolean; eventCache: boolean; prerender: boolean }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const jitter = (ms: number) => ms + Math.round((Math.random() - 0.5) * ms * 0.2)

const EVENTS = [
  ["london", "climate-march"],
  ["london", "nhs-rally"],
  ["paris", "greve-generale"],
  ["berlin", "mietenstopp"],
  ["new-york", "tenants-union"],
]
const CITIES = [
  ["uk", "london"],
  ["france", "paris"],
  ["germany", "berlin"],
  ["us", "new-york"],
]
const POSTS = ["how-we-verify-events", "a-year-of-protests", "organising-online"]

function page(path: string, title: string, body: string, fresh: boolean) {
  const stamp = fresh ? `<meta name="render-id" content="${randomUUID()}">` : ""
  return `<!doctype html><html lang="en"><head><title>${title}</title>
<link rel="canonical" href="https://www.example.org${path}">${stamp}</head>
<body><header><a href="/">Home</a> <a href="/about">About</a> <a href="/blog">Blog</a></header>
<main><h1>${title}</h1>${body}</main></body></html>`
}

/**
 * One of four copies of a small events site: the current site in production on a Vercel-like
 * host and in dev mode, and the port in dev mode and deployed on a Cloudflare-like host.
 */
export function startSite(kind: SiteKind, fixes: Fixes): Promise<{ url: string; server: Server }> {
  const hits = new Map<string, number>()
  const isDev = kind === "current-dev" || kind === "port-dev"
  const isPort = kind === "port-dev" || kind === "port"

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://site")
    const path = url.pathname
    const seen = (hits.get(path) ?? 0) + 1
    hits.set(path, seen)

    const edge = (cached: boolean): Record<string, string> => {
      if (isDev) return {}
      if (kind === "current") {
        return {
          "x-vercel-id": `fra1::iad1::${randomUUID().slice(0, 8)}`,
          "x-vercel-cache": cached ? "HIT" : "MISS",
        }
      }
      return {
        "cf-ray": `${randomUUID().replace(/-/g, "").slice(0, 16)}-FRA`,
        "x-vinext-cache": cached ? "HIT" : "MISS",
      }
    }
    // Dev servers render every request; a deployment renders once and serves the cache after.
    const render = async (
      path: string,
      title: string,
      body: string,
      opts: { cacheable?: boolean; renderMs?: number; hitMs?: number } = {},
    ) => {
      const cacheable = opts.cacheable ?? true
      const cached = !isDev && cacheable && seen > 1
      const ms = isDev
        ? jitter((opts.renderMs ?? 60) * 2.5)
        : cached
          ? jitter(opts.hitMs ?? 12)
          : jitter(opts.renderMs ?? 60)
      await sleep(ms)
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...edge(cached) })
      res.end(page(path, title, body, !cached))
    }

    if (path === "/__demo/fix" && req.method === "POST") {
      const name = url.searchParams.get("name") as keyof Fixes
      if (name in fixes) fixes[name] = url.searchParams.get("on") !== "0"
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify(fixes))
    }
    if (path === "/__purge") {
      hits.delete(url.searchParams.get("path") ?? "")
      res.writeHead(204)
      return res.end()
    }
    if (path === "/sitemap.xml") {
      const urls = [
        "/",
        "/about",
        "/blog",
        ...POSTS.map((p) => `/blog/${p}`),
        ...EVENTS.map(([c, e]) => `/event/${c}/${e}`),
        ...CITIES.map(([c, city]) => `/${c}/${city}`),
      ]
      res.writeHead(200, { "content-type": "application/xml" })
      return res.end(
        `<urlset>${urls.map((u) => `<url><loc>https://www.example.org${u}</loc></url>`).join("")}</urlset>`,
      )
    }
    if (path === "/") {
      const links = EVENTS.map(([c, e]) => `<li><a href="/event/${c}/${e}">${e}</a></li>`).join("")
      return render(path, "Find a protest near you", `<ul>${links}</ul>`, { renderMs: 50 })
    }
    if (path === "/about") {
      if (!isDev && req.headers["if-none-match"] === '"about-3"') {
        res.writeHead(304, { etag: '"about-3"', ...edge(true) })
        return res.end()
      }
      await sleep(isDev ? jitter(90) : jitter(15))
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        etag: '"about-3"',
        ...edge(seen > 1),
      })
      return res.end(page(path, "About", "<p>Who we are.</p>", false))
    }
    if (path === "/old-events") {
      res.writeHead(isPort && !fixes.redirect ? 308 : 301, { location: "/" })
      return res.end()
    }
    if (path === "/blog")
      return render(path, "Blog", POSTS.map((p) => `<a href="/blog/${p}">${p}</a>`).join(" "), {
        renderMs: 40,
      })
    if (path.startsWith("/blog/"))
      return render(path, "Blog post", "<article>…</article>", { renderMs: isPort ? 30 : 90 })
    const event = /^\/event\/([^/]+)\/([^/]+)$/.exec(path)
    if (event) {
      if (req.headers.cookie?.includes("locale=es")) {
        res.writeHead(307, { location: `/es${path}` })
        return res.end()
      }
      const lostCache = kind === "port" && !fixes.eventCache
      return render(path, "Event", "<p>Where, when, who.</p>", {
        cacheable: !lostCache,
        renderMs: lostCache ? 140 : kind === "port" ? 35 : 70,
      })
    }
    const city = /^\/([a-z-]+)\/([a-z-]+)$/.exec(path)
    if (city && CITIES.some(([c, n]) => c === city[1] && n === city[2])) {
      // The port serves these from a data cache in one region rather than from the edge.
      return render(path, `Protests in ${city[2]}`, "<ul><li>…</li></ul>", {
        renderMs: 80,
        hitMs: kind === "port" ? 50 : undefined,
      })
    }
    if (path === "/api/events") {
      await sleep(isDev ? jitter(120) : jitter(20))
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control":
          kind === "port" ? "private, max-age=0, must-revalidate" : "public, s-maxage=300",
        ...edge(seen > 1),
      })
      return res.end(JSON.stringify(EVENTS))
    }
    res.writeHead(404, { "content-type": "text/html" })
    res.end(page(path, "Not found", "", false))
  })
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve({
        url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`,
        server,
      })
    }),
  )
}

export const DEMO_TRAFFIC = `page,pageviews,entrances,country
/,4200,2600,GB
/,900,500,US
/event/london/climate-march,2100,1800,GB
/event/london/nhs-rally,1300,1100,GB
/event/paris/greve-generale,800,700,FR
/event/berlin/mietenstopp,600,520,DE
/event/new-york/tenants-union,700,610,US
/uk/london,1500,900,GB
/france/paris,400,250,FR
/us/new-york,350,200,US
/about,500,80,GB
/blog,200,40,GB
/blog/how-we-verify-events,260,210,GB
/donate,180,20,GB
/old-events,60,1500,GB
`
