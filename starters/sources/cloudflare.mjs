// HTML requests per path and country from a Cloudflare zone's GraphQL Analytics API.
//
// Written from Cloudflare's GraphQL schema documentation and not yet run against a real zone:
// field names, the plan's retention and the query's time limits all need checking on the first run.
// An entry is counted as an HTML request whose Referer is another host or absent.
//
// Needs CLOUDFLARE_API_TOKEN (Analytics read) in the environment, and in portside.config.json:
//   "survey": { "sources": { "cloudflare": { "zone": "<zone id>", "host": "www.example.com" } } }

const QUERY = `query($zone: String!, $since: Time!, $until: Time!) {
  viewer { zones(filter: { zoneTag: $zone }) {
    httpRequestsAdaptiveGroups(
      limit: 10000
      filter: { datetime_geq: $since, datetime_lt: $until, edgeResponseContentTypeName: "html", requestSource: "eyeball" }
      orderBy: [count_DESC]
    ) { count dimensions { clientRequestPath clientCountryName clientRefererHost } }
  } }
}`

const days = (since) => Number(/^(\d+)d$/.exec(since)?.[1] ?? 1)

export default {
  describe: "Cloudflare zone analytics: HTML requests, entries and countries",
  async rows(ctx) {
    if (!ctx.env.CLOUDFLARE_API_TOKEN) throw new Error("CLOUDFLARE_API_TOKEN is not set")
    if (!ctx.options.zone) throw new Error("survey.sources.cloudflare.zone is not set")
    const until = new Date()
    const since = new Date(until.getTime() - days(ctx.since) * 86_400_000)
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.env.CLOUDFLARE_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: QUERY,
        variables: {
          zone: ctx.options.zone,
          since: since.toISOString(),
          until: until.toISOString(),
        },
      }),
    })
    const json = await res.json()
    if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "))
    const groups = json.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups ?? []
    const own = ctx.options.host
    return groups.map((g) => {
      const d = g.dimensions
      const external = !d.clientRefererHost || (own && d.clientRefererHost !== own)
      return {
        path: d.clientRequestPath,
        country: d.clientCountryName,
        views: g.count,
        entries: external ? g.count : 0,
      }
    })
  },
}
