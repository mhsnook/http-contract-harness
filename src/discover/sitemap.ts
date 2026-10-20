const LOC = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/g

// Locations are read as paths whatever host they name: a preview's sitemap lists production URLs.
export async function sitemapPaths(
  baseURL: string,
  sitemap: string,
  headers: Record<string, string>,
  limit = 50_000,
): Promise<{ paths: string[]; files: string[]; errors: string[] }> {
  const paths = new Set<string>()
  const files: string[] = []
  const errors: string[] = []

  const read = async (location: string, depth: number) => {
    const url = new URL(location, baseURL)
    const local = new URL(url.pathname + url.search, baseURL)
    let text: string
    try {
      const res = await fetch(local, { headers, redirect: "follow" })
      if (!res.ok) {
        errors.push(`${local.pathname}: ${res.status}`)
        return
      }
      text = await res.text()
    } catch (error) {
      errors.push(`${local.pathname}: ${(error as Error).message}`)
      return
    }
    files.push(local.pathname)
    const locs = [...text.matchAll(LOC)].map((m) => m[1] as string)
    const isIndex = /<sitemapindex\b/i.test(text)
    for (const loc of locs) {
      if (paths.size >= limit) return
      if (isIndex && depth < 2) await read(loc, depth + 1)
      else if (!isIndex) {
        const u = new URL(loc, baseURL)
        paths.add(u.pathname + u.search)
      }
    }
  }

  await read(sitemap, 0)
  return { paths: [...paths], files, errors }
}
