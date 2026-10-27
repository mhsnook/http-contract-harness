import { timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { runEngine, type EngineRequest, type EngineResult, type EngineSpec } from "./engine.ts"
import { probeFromBundle, type LoadedProbe, type ProbeBundle, type ProbeTarget } from "./probe.ts"
import type { RecordOptions } from "./record.ts"

export type RunnerPayload = {
  vantage: string
  targets: ProbeTarget[]
  requests: EngineRequest[]
  probes: { name: string; hash: string; bundle: ProbeBundle }[]
  repeats?: number
  defaultRepeats: number
  concurrency: number
  timeoutMs: number
  record: Omit<RecordOptions, "baseURL" | "params">
}

export type RunnerOptions = {
  port: number
  host: string
  token: string
  region?: string
  browser: { executablePath?: string; cdp?: string }
  cwd: string
}

const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/**
 * Runs probes for a harness client somewhere else, such as a VM in the region a site's readers
 * are in. It executes the probe code the client sends, so the token is the whole of its security:
 * run it behind HTTPS and give the token only to people who could run code on the machine anyway.
 */
export async function serveRunner(opts: RunnerOptions) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://runner")
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ ok: true, region: opts.region ?? null }))
    }
    if (req.method !== "POST" || url.pathname !== "/run") {
      res.writeHead(404)
      return res.end()
    }
    if (!same(req.headers.authorization ?? "", `Bearer ${opts.token}`)) {
      res.writeHead(401)
      return res.end()
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    let payload: RunnerPayload
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RunnerPayload
    } catch {
      res.writeHead(400)
      return res.end("not JSON")
    }
    res.writeHead(200, { "content-type": "application/x-ndjson" })
    const send = (line: unknown) => res.write(JSON.stringify(line) + "\n")
    try {
      const probes = new Map<string, LoadedProbe>()
      for (const p of payload.probes)
        probes.set(p.name, await probeFromBundle(p.name, p.bundle, p.hash))
      const spec: EngineSpec = {
        targets: payload.targets,
        requests: payload.requests,
        probes,
        repeats: payload.repeats,
        defaultRepeats: payload.defaultRepeats,
        concurrency: payload.concurrency,
        timeoutMs: payload.timeoutMs,
        record: payload.record,
        vantage: { name: payload.vantage, region: opts.region, browser: opts.browser },
        cwd: opts.cwd,
      }
      await runEngine(spec, (result) => {
        send({ type: "result", result })
      })
      send({ type: "done", region: opts.region ?? null })
    } catch (error) {
      send({ type: "error", message: (error as Error).message })
    }
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : opts.port
  return {
    url: `http://${opts.host}:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

export async function runRemote(
  vantage: { url: string; token?: string },
  payload: RunnerPayload,
  onResult: (result: EngineResult) => void,
): Promise<{ region: string | null }> {
  const res = await fetch(new URL("/run", vantage.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(vantage.token ? { authorization: `Bearer ${vantage.token}` } : {}),
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok || !res.body) throw new Error(`runner ${vantage.url} answered ${res.status}`)
  const decoder = new TextDecoder()
  let buffered = ""
  let region: string | null = null
  const handle = (line: string) => {
    if (!line.trim()) return
    const message = JSON.parse(line)
    if (message.type === "result") onResult(message.result as EngineResult)
    else if (message.type === "done") region = message.region
    else if (message.type === "error") throw new Error(`runner ${vantage.url}: ${message.message}`)
  }
  for await (const chunk of res.body) {
    buffered += decoder.decode(chunk as Uint8Array, { stream: true })
    const lines = buffered.split("\n")
    buffered = lines.pop() ?? ""
    for (const line of lines) handle(line)
  }
  handle(buffered)
  return { region }
}
