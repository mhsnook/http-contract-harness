// One GET request per repeat, redirects never followed.
//
// conditions.cache picks how the cache is approached:
//   "warm"        (default) the same URL again and again; the first request is dropped as warmup
//   "revalidate"  a conditional request carrying the ETag or Last-Modified of a first answer,
//                 which is what a browser refresh sends to a page marked must-revalidate
//   "cold"        the target's purge command before every request, then the request
//
// A purge command lives in the target's options in harness.config.json, for example
//   "options": { "purge": "curl -s -X POST https://www.example.com/api/revalidate?path=$HARNESS_PATH" }
// and runs with HARNESS_URL, HARNESS_PATH and HARNESS_TARGET set. `"purge": false` says the
// target keeps no cache to clear, as a dev server that renders every request.
//
// Revisit for each stack: what counts as a cache hit (cacheHint knows the common CDN headers),
// whether a query string reaches the cache key (on vinext 1.0 it does not, so a nonce is not a
// cold request), and what a purge has to clear.

export default {
  describe: "GET with redirects off; warm, revalidate or cold",
  primary: "ttfb",
  fields: {
    cache: { policy: "if-slower", order: ["uncached", "cached"], optional: true },
  },

  async prepare(ctx) {
    const mode = ctx.conditions.cache ?? "warm"
    if (mode === "revalidate" && !ctx.state.validators) {
      const first = await ctx.request(ctx.path)
      const validators = {}
      if (first.headers["etag"]) validators["if-none-match"] = first.headers["etag"]
      if (first.headers["last-modified"])
        validators["if-modified-since"] = first.headers["last-modified"]
      if (Object.keys(validators).length === 0)
        throw new Error("no ETag or Last-Modified to revalidate with")
      ctx.state.validators = validators
    }
    if (mode === "cold") {
      const purge = ctx.conditions.purge ?? ctx.target.options.purge
      if (purge === false) return
      if (!purge) throw new Error(`target ${ctx.target.name} has no options.purge command`)
      await ctx.exec(String(purge))
    }
  },

  async measure(ctx) {
    const mode = ctx.conditions.cache ?? "warm"
    const res = await ctx.request(ctx.path, {
      headers: mode === "revalidate" ? ctx.state.validators : undefined,
    })
    const hint = ctx.cacheHint(res.headers)
    if (mode === "cold" && hint.hint === "hit") {
      return { metrics: {}, skip: `the purge did not take: ${hint.header}` }
    }
    const stamp = ctx.conditions.renderStamp
      ? new RegExp(String(ctx.conditions.renderStamp)).exec(res.body)?.[1]
      : undefined
    return {
      metrics: { ttfb: res.ttfb, total: res.total, bytes: res.bytes },
      record: ctx.record(res),
      served: ctx.servedFrom(res.headers),
      evidence: { headers: res.headers, bodyHash: res.bodyHash, stamp, hint: hint.header },
      // The first warm request may be the one that filled the cache.
      warmup: mode === "warm" && ctx.repeat === 0,
    }
  },

  summarise(samples, ctx) {
    const mode = ctx.conditions.cache ?? "warm"
    if (mode !== "warm")
      return { note: mode === "cold" ? "every counted request missed" : undefined }
    const { cache, signal } = ctx.classify(samples.map((s) => s.evidence))
    return { record: cache === "unknown" ? {} : { cache }, note: signal }
  },
}
