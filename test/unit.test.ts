import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { classify } from "../src/cache.ts"
import { expandHeaders } from "../src/config.ts"
import { readUrlList } from "../src/discover/urls.ts"
import { bundleOf, hashBundle, servedFrom } from "../src/probe.ts"
import {
  borrowSamples,
  expandPattern,
  fromNextPath,
  inferPatterns,
  matchPattern,
  templateWith,
} from "../src/patterns.ts"
import { normalise } from "../src/record.ts"
import { callChange, summarise } from "../src/stats.ts"

describe("patterns", () => {
  it("reads Next app paths", () => {
    expect(fromNextPath("/[locale]/(protest-routes)/page")).toBe("/:locale")
    expect(fromNextPath("/[locale]/event/[city]/[eventId]/page")).toBe(
      "/:locale/event/:city/:eventId",
    )
    expect(fromNextPath("/[locale]/[country]/[...cityPath]/page")).toBe(
      "/:locale/:country/:cityPath+",
    )
    expect(fromNextPath("/docs/[[...slug]]/page")).toBe("/docs/:slug*")
    expect(fromNextPath("/api/events/route")).toBe("/api/events")
  })

  it("matches and extracts parameters", () => {
    expect(matchPattern("/event/:city/:id", "/event/london/abc")).toEqual({
      city: "london",
      id: "abc",
    })
    expect(matchPattern("/event/:city/:id", "/event/london/abc?utm=x")).toEqual({
      city: "london",
      id: "abc",
    })
    expect(matchPattern("/event/:city/:id", "/event/london")).toBeUndefined()
    expect(matchPattern("/uk/:path+", "/uk/a/b")).toEqual({ path: "a/b" })
    expect(matchPattern("/docs/:slug*", "/docs")).toEqual({ slug: "" })
    expect(matchPattern("/", "/")).toEqual({})
    expect(matchPattern("/", "/?page=2")).toEqual({})
  })

  it("templates a sample's parameters out of a location", () => {
    expect(templateWith("/es/event/london/abc", { city: "london", id: "abc" })).toBe(
      "/es/event/{city}/{id}",
    )
  })

  it("expands a locale parameter into its literal options", () => {
    expect(expandPattern("/:locale/about", { locale: ["", "es"] })).toEqual(["/about", "/es/about"])
    expect(expandPattern("/:locale", { locale: ["", "es"] })).toEqual(["/", "/es"])
  })

  it("infers patterns without collapsing top-level pages", () => {
    const inferred = inferPatterns([
      "/",
      "/about",
      "/blog",
      "/contact",
      "/blog/a",
      "/blog/b",
      "/blog/c",
      "/legal/terms",
      "/event/london/1",
      "/event/paris/2",
      "/event/rome/3",
    ])
    expect([...inferred.keys()].sort()).toEqual(
      [
        "/",
        "/about",
        "/blog",
        "/blog/:blog",
        "/contact",
        "/event/:event/:event2",
        "/legal/terms",
      ].sort(),
    )
    expect(inferred.get("/blog/:blog")).toEqual(["/blog/a", "/blog/b", "/blog/c"])
  })

  it("borrows samples for a route nothing lists", () => {
    const sampled = new Map([["/event/:city/:id", ["/event/london/abc"]]])
    expect(borrowSamples("/event/:city/:id/opengraph-image", sampled)).toEqual([
      "/event/london/abc/opengraph-image",
    ])
  })
})

describe("cache classification", () => {
  const ex = (headers: Record<string, string>, bodyHash = "a", stamp?: string) => ({
    headers,
    bodyHash,
    stamp,
  })

  it("believes a CDN's hit header on the repeats", () => {
    expect(
      classify([ex({ "cf-cache-status": "MISS" }), ex({ "cf-cache-status": "HIT" })]).cache,
    ).toBe("cached")
    expect(
      classify([ex({ "x-vercel-cache": "MISS" }), ex({ "x-vercel-cache": "STALE" })]).cache,
    ).toBe("cached")
  })

  it("calls a route uncached when every repeat misses or bypasses", () => {
    expect(
      classify([ex({ "cf-cache-status": "DYNAMIC" }), ex({ "cf-cache-status": "DYNAMIC" })]).cache,
    ).toBe("uncached")
  })

  it("reads bodies when no header says", () => {
    expect(classify([ex({}, "a"), ex({}, "b"), ex({}, "c")]).cache).toBe("uncached")
    expect(classify([ex({}, "a"), ex({}, "b"), ex({}, "b")]).cache).toBe("cached")
    expect(classify([ex({}, "a"), ex({}, "a"), ex({}, "a")]).cache).toBe("unknown")
  })

  it("prefers a render stamp over the body", () => {
    expect(classify([ex({}, "a", "1"), ex({}, "a", "2"), ex({}, "a", "3")]).cache).toBe("uncached")
    expect(classify([ex({}, "a", "1"), ex({}, "b", "1"), ex({}, "c", "1")]).cache).toBe("cached")
  })
})

describe("normalise", () => {
  const opts = {
    baseURL: "https://a.example",
    params: { city: "london", id: "abc" },
    headers: ["vary"],
    htmlCacheControl: false,
  }

  it("keeps only what two runs agree on", () => {
    const record = normalise(
      308,
      {
        location: "https://a.example/event/london/abc",
        date: "now",
        etag: "x",
        "cache-control": "public",
        vary: "accept",
      },
      undefined,
      opts,
    )
    expect(record).toEqual({
      status: 308,
      location: "/event/{city}/{id}",
      "cache-control": "public",
      vary: "accept",
    })
  })

  it("keeps a redirect to another host whole", () => {
    expect(normalise(301, { location: "https://b.example/x" }, undefined, opts)["location"]).toBe(
      "https://b.example/x",
    )
  })

  it("reads what an HTML page declares, and drops its cache-control", () => {
    const html = `<html lang="es"><head><link rel="canonical" href="https://a.example/event/london/abc"><meta name="robots" content="noindex"></head></html>`
    const record = normalise(
      200,
      { "content-type": "text/html; charset=utf-8", "cache-control": "private" },
      html,
      opts,
    )
    expect(record).toEqual({
      status: 200,
      "content-type": "text/html; charset=utf-8",
      "html.lang": "es",
      "html.canonical": "/event/{city}/{id}",
      "html.robots": "noindex",
    })
  })
})

describe("stats", () => {
  it("only calls a change when the middle halves separate", () => {
    const before = summarise([100, 102, 104, 106, 108])!
    expect(callChange(before, summarise([150, 152, 154, 156, 158])!, 0.1)).toBe("worse")
    expect(callChange(before, summarise([60, 62, 64, 66, 68])!, 0.1)).toBe("better")
    expect(callChange(before, summarise([90, 100, 110, 120, 105])!, 0.1)).toBe("noise")
    expect(callChange(summarise([2, 2, 2, 2])!, summarise([6, 6, 6, 6])!, 0.1, 25)).toBe("noise")
  })
})

describe("headers", () => {
  it("reads secrets from the environment and drops a header whose variable is unset", () => {
    expect(
      expandHeaders({ "X-Bypass": "${SECRET}", "x-other": "${NOPE}" }, { SECRET: "s" }),
    ).toEqual({
      headers: { "x-bypass": "s" },
      missing: ["NOPE"],
    })
  })
})

describe("URL lists", () => {
  const file = (text: string) => {
    const dir = mkdtempSync(join(tmpdir(), "portside-urls-"))
    writeFileSync(join(dir, "list"), text)
    return join(dir, "list")
  }

  it("reads an analytics export by its header", () => {
    const list = readUrlList(
      file('name,visitors,pageviews\n/,"1,200",3000\n/event/london/abc,40,90\n'),
    )
    expect([...list]).toEqual([
      ["/", 1200],
      ["/event/london/abc", 40],
    ])
  })

  it("reads a plain list of paths or URLs with optional counts", () => {
    const list = readUrlList(file("# top pages\nhttps://example.com/about 12\n/blog\n/about,3\n"))
    expect([...list]).toEqual([
      ["/about", 15],
      ["/blog", 1],
    ])
  })
})

describe("probes", () => {
  it("reads where each platform says it answered", () => {
    expect(servedFrom({ "cf-ray": "8f1c2a3b4c5d6e7f-FRA" })).toBe("cloudflare:FRA")
    expect(servedFrom({ "x-vercel-id": "fra1::iad1::abc-123" })).toBe("vercel:fra1>iad1")
    expect(servedFrom({ "x-amz-cf-pop": "LHR61-P1" })).toBe("cloudfront:LHR61-P1")
    expect(servedFrom({})).toBeUndefined()
  })

  it("versions a probe by its own file and every local module it imports", () => {
    const dir = mkdtempSync(join(tmpdir(), "portside-bundle-"))
    writeFileSync(join(dir, "_shared.mjs"), "export const x = 1\n")
    writeFileSync(
      join(dir, "a.mjs"),
      'import { x } from "./_shared.mjs"\nexport default { primary: "x", measure: async () => ({ metrics: { x } }) }\n',
    )
    const before = bundleOf(dir, "a.mjs")
    expect(Object.keys(before.files).sort()).toEqual(["_shared.mjs", "a.mjs"])
    writeFileSync(join(dir, "_shared.mjs"), "export const x = 2\n")
    expect(hashBundle(bundleOf(dir, "a.mjs"))).not.toBe(hashBundle(before))
  })
})
