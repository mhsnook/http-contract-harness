import { createServer, type Server } from "node:http"
import { randomUUID } from "node:crypto"

export type Flavour = "legacy" | "port"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * A small site in two versions. The port differs from the legacy site in the ways real ports do:
 * one redirect changed its status, the event page lost its cache and got slower, a JSON route's
 * cache-control changed with the host, and the blog got faster than it ever was.
 */
export function site(flavour: Flavour): Promise<{ url: string; server: Server }> {
  const hits = new Map<string, number>()
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x")
    const path = url.pathname
    const seen = (hits.get(req.url ?? "") ?? 0) + 1
    hits.set(req.url ?? "", seen)
    const html = (body: string, headers: Record<string, string> = {}) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers })
      res.end(
        `<!doctype html><html lang="en"><head><link rel="canonical" href="${path}"></head><body>${body}</body></html>`,
      )
    }

    if (path === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" })
      return res.end(
        `<sitemapindex><sitemap><loc>https://prod.example/sitemap-pages.xml</loc></sitemap></sitemapindex>`,
      )
    }
    if (path === "/sitemap-pages.xml") {
      res.writeHead(200, { "content-type": "application/xml" })
      const pages = [
        "/",
        "/about",
        "/blog/a",
        "/blog/b",
        "/blog/c",
        "/event/london/1",
        "/event/paris/2",
        "/event/rome/3",
      ]
      return res.end(
        `<urlset>${pages.map((p) => `<url><loc>https://prod.example${p}</loc></url>`).join("")}</urlset>`,
      )
    }
    if (path === "/") return html("home", { "cf-cache-status": seen > 1 ? "HIT" : "MISS" })
    if (path === "/about") return html("about")
    if (path === "/old") {
      res.writeHead(flavour === "legacy" ? 301 : 308, { location: "/about" })
      return res.end()
    }
    if (path.startsWith("/blog/")) {
      if (flavour === "legacy") await sleep(40)
      return html(`post <meta name="render" content="${randomUUID()}">`)
    }
    const event = /^\/event\/([^/]+)\/([^/]+)$/.exec(path)
    if (event) {
      if (req.headers.cookie?.includes("locale=es")) {
        res.writeHead(307, { location: `/es${path}` })
        return res.end()
      }
      if (flavour === "port") {
        await sleep(80)
        return html(`event ${randomUUID()}`, { "x-vinext-cache": "MISS" })
      }
      return html(`event`, { "x-vercel-cache": seen > 1 ? "HIT" : "MISS" })
    }
    if (path === "/api/data") {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control":
          flavour === "legacy" ? "public, max-age=60" : "private, max-age=0, must-revalidate",
      })
      return res.end("{}")
    }
    res.writeHead(404, { "content-type": flavour === "legacy" ? "text/html" : "text/plain" })
    res.end("not found")
  })
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      resolve({ url: `http://127.0.0.1:${port}`, server })
    }),
  )
}
