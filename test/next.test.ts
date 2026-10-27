import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { nextRoutes } from "../src/discover/next.ts"

const dir = mkdtempSync(join(tmpdir(), "harness-next-"))
const write = (file: string, value: unknown) => {
  mkdirSync(join(dir, file, ".."), { recursive: true })
  writeFileSync(join(dir, file), JSON.stringify(value))
}

write("server/app-paths-manifest.json", {
  "/_not-found/page": "",
  "/page": "",
  "/[locale]/(protest-routes)/page": "",
  "/[locale]/about/page": "",
  "/[locale]/event/[city]/[eventId]/page": "",
  "/[locale]/[country]/[...cityPath]/page": "",
  "/api/events/route": "",
})
write("prerender-manifest.json", {
  routes: {
    "/en/about": { initialRevalidateSeconds: false, srcRoute: "/[locale]/about" },
    "/en/event/london/abc": {
      initialRevalidateSeconds: 900,
      srcRoute: "/[locale]/event/[city]/[eventId]",
    },
  },
  dynamicRoutes: { "/[locale]/[country]/[...cityPath]": {} },
})
write("routes-manifest.json", {
  redirects: [
    { source: "/:path+/", destination: "/:path+", statusCode: 308, internal: true },
    { source: "/community/:path*", destination: "/directory/:path*", statusCode: 308 },
    {
      source: "/",
      destination: "/es",
      statusCode: 307,
      has: [{ type: "cookie", key: "locale", value: "es" }],
    },
  ],
})
write("server/middleware-manifest.json", {
  middleware: { "/": { matchers: [{ originalSource: "/((?!api|_next).*)" }] } },
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("Next build discovery", () => {
  const { routes, middleware } = nextRoutes(dir)
  const byPattern = new Map(routes.map((r) => [r.pattern, r]))

  it("reads every app route and skips the framework's own", () => {
    expect([...byPattern.keys()]).toEqual(
      expect.arrayContaining([
        "/:locale",
        "/:locale/about",
        "/:locale/event/:city/:eventId",
        "/:locale/:country/:cityPath+",
        "/api/events",
      ]),
    )
    expect(byPattern.has("/_not-found")).toBe(false)
  })

  it("says what the build declared for each route", () => {
    expect(byPattern.get("/:locale/about")!.declared).toEqual({ mode: "static" })
    expect(byPattern.get("/:locale/event/:city/:eventId")!.declared).toEqual({
      mode: "isr",
      revalidate: 900,
    })
    expect(byPattern.get("/:locale/:country/:cityPath+")!.declared).toEqual({ mode: "on-demand" })
    expect(byPattern.get("/:locale")!.declared).toEqual({ mode: "dynamic" })
    expect(byPattern.get("/api/events")!.declared).toEqual({ mode: "handler" })
  })

  it("takes prerendered paths as samples", () => {
    expect(byPattern.get("/:locale/event/:city/:eventId")!.samples).toEqual([
      "/en/event/london/abc",
    ])
  })

  it("turns next.config redirects into routes, and their conditions into cases", () => {
    expect(byPattern.get("/community/:path*")!.samples).toEqual(["/community/sample"])
    expect(byPattern.get("/")!.cases).toEqual({
      "when-cookie-locale": {
        headers: { cookie: "locale=es" },
        note: 'next.config redirect when [{"type":"cookie","key":"locale","value":"es"}]',
      },
    })
    expect(byPattern.get("/")!.declared).toEqual({ mode: "dynamic" })
    expect(byPattern.get("/community/:path*")!.declared).toEqual({ mode: "redirect" })
    expect(byPattern.has("/:path+/")).toBe(false)
  })

  it("lists middleware matchers, which a build cannot enumerate", () => {
    expect(middleware).toEqual(["/((?!api|_next).*)"])
  })
})
