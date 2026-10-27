// Page views, entry pages and countries from Plausible's Stats API (v2).
//
// Written from Plausible's API documentation and not yet run against a real site: check the
// response shape on your first run.
//
// Needs PLAUSIBLE_API_KEY in the environment, and in harness.config.json:
//   "survey": { "sources": { "plausible": { "site": "example.com", "host": "https://plausible.io" } } }

async function query(ctx, body) {
  const host = ctx.options.host ?? "https://plausible.io"
  const res = await fetch(new URL("/api/v2/query", host), {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.env.PLAUSIBLE_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ site_id: ctx.options.site, date_range: ctx.since, ...body }),
  })
  if (!res.ok) throw new Error(`Plausible answered ${res.status}: ${await res.text()}`)
  return (await res.json()).results ?? []
}

export default {
  describe: "Plausible: page views, entries and countries",
  async rows(ctx) {
    if (!ctx.env.PLAUSIBLE_API_KEY) throw new Error("PLAUSIBLE_API_KEY is not set")
    if (!ctx.options.site) throw new Error("survey.sources.plausible.site is not set")
    const [pages, entries] = await Promise.all([
      query(ctx, {
        metrics: ["pageviews"],
        dimensions: ["event:page", "visit:country"],
        pagination: { limit: 10000 },
      }),
      query(ctx, {
        metrics: ["visits"],
        dimensions: ["visit:entry_page", "visit:country"],
        pagination: { limit: 10000 },
      }),
    ])
    return [
      ...pages.map((r) => ({
        path: r.dimensions[0],
        country: r.dimensions[1],
        views: r.metrics[0],
      })),
      ...entries.map((r) => ({
        path: r.dimensions[0],
        country: r.dimensions[1],
        entries: r.metrics[0],
      })),
    ]
  },
}
