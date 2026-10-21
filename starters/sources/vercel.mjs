// Page views per path and country from Vercel Web Analytics, through `vercel metrics`.
//
// Written from the `vercel metrics` documentation and not yet run against a real project. The
// dimension names are read from `vercel metrics schema` at run time; check them on the first
// run, and replace the parsing below once you have seen a real response.
//
// Needs the Vercel CLI, logged in and linked to the project, or VERCEL_TOKEN, and optionally:
//   "survey": { "sources": { "vercel": { "project": "my-project" } } }

const METRIC = "vercel.analytics.page_view.count"

function rowsIn(value, pathDim, countryDim, out = []) {
  if (Array.isArray(value)) for (const v of value) rowsIn(v, pathDim, countryDim, out)
  else if (value && typeof value === "object") {
    const dims = value.dimensions ?? value.groupBy ?? value
    const path = dims[pathDim]
    const count = value.value ?? value.count ?? value.sum
    if (typeof path === "string" && typeof count === "number") {
      out.push({ path, country: countryDim ? dims[countryDim] : undefined, views: count })
    } else for (const v of Object.values(value)) rowsIn(v, pathDim, countryDim, out)
  }
  return out
}

export default {
  describe: "Vercel Web Analytics page views, through vercel metrics",
  async rows(ctx) {
    const project = ctx.options.project ? ` --project ${ctx.options.project}` : ""
    const token = ctx.env.VERCEL_TOKEN ? ` --token ${ctx.env.VERCEL_TOKEN}` : ""
    const schema = JSON.parse(
      (await ctx.exec(`vercel metrics schema ${METRIC} --format json${token}`)).stdout,
    )
    const names =
      JSON.stringify(schema).match(/"[a-zA-Z]*(?:[Pp]ath|[Rr]oute|[Cc]ountry)[a-zA-Z]*"/g) ?? []
    const dims = [...new Set(names.map((n) => n.slice(1, -1)))]
    const pathDim = dims.find((d) => /path/i.test(d)) ?? dims.find((d) => /route/i.test(d))
    const countryDim = dims.find((d) => /country/i.test(d))
    if (!pathDim)
      throw new Error(`no path dimension in the schema for ${METRIC}: ${dims.join(", ")}`)
    const groups = [pathDim, countryDim]
      .filter(Boolean)
      .map((d) => ` --group-by ${d}`)
      .join("")
    const { stdout } = await ctx.exec(
      `vercel metrics ${METRIC}${groups} --since ${ctx.since} --limit 1000 --prod --format json${project}${token}`,
    )
    return rowsIn(JSON.parse(stdout), pathDim, countryDim)
  },
}
