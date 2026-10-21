import { readFileSync, statSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { join } from "node:path"
import { CONFIG_FILE, LEDGER_FILE, LOCK_FILE, readConfig, readLock } from "../config.ts"
import type { Project } from "../project.ts"
import { lock, loosen, ratchet } from "../ratchet.ts"
import { readLedger } from "../ledger.ts"
import { planOf } from "../plan.ts"
import { runBatch } from "../run.ts"
import { compareRefs, statusOf } from "../status.ts"

type Running = { targets: string[]; label?: string; done: number; total: number }

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString("utf8")
  return text ? JSON.parse(text) : {}
}

function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  res.end(JSON.stringify(value))
}

const mtime = (file: string) => {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

// Polls the database and the lock file rather than relying on its own actions, so runs and locks
// made from the CLI, by a person or an agent, reach the dashboard too.
export async function serve(project: Project, opts: { port: number; host: string }) {
  const html = readFileSync(new URL("./dashboard.html", import.meta.url), "utf8")
  const clients = new Set<ServerResponse>()
  let running: Running | null = null

  const broadcast = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of clients) client.write(frame)
  }

  const lockFile = join(project.root, LOCK_FILE)
  const configFile = join(project.root, CONFIG_FILE)
  const ledgerFile = join(project.root, LEDGER_FILE)
  const snapshot = () => ({
    observation: project.store.maxObservationId(),
    lock: mtime(lockFile),
    config: mtime(configFile),
    ledger: mtime(ledgerFile),
  })
  let seen = snapshot()
  const watcher = setInterval(() => {
    const now = snapshot()
    if (now.lock !== seen.lock) {
      try {
        project.lock = readLock(project.root)
      } catch (error) {
        broadcast("problem", { message: (error as Error).message })
      }
    }
    if (now.config !== seen.config) {
      try {
        project.config = readConfig(project.root)
      } catch (error) {
        broadcast("problem", { message: (error as Error).message })
      }
    }
    if (
      now.observation !== seen.observation ||
      now.lock !== seen.lock ||
      now.config !== seen.config ||
      now.ledger !== seen.ledger
    ) {
      broadcast("change", { running })
    }
    seen = now
  }, 750)

  const startRuns = async (targets: string[], label?: string, route?: string) => {
    running = { targets, label, done: 0, total: 0 }
    try {
      await runBatch(project, {
        targets,
        label,
        routes: route ? (p) => p === route || p.startsWith(route) : undefined,
        onObservation: (_, done, total) => {
          if (!running) return
          running.done = done
          running.total = total
          broadcast("progress", running)
        },
      })
    } catch (error) {
      broadcast("problem", { message: (error as Error).message })
    } finally {
      running = null
      broadcast("change", { running })
    }
  }

  const state = async () => ({
    plan: await planOf(project),
    ledger: readLedger(project.root),
    vantages: Object.entries(project.config.vantages).map(([name, v]) => ({
      name,
      region: v.region ?? null,
      remote: Boolean(v.url),
    })),
    project: {
      root: project.root,
      baseline: project.config.baseline,
      targets: Object.entries(project.config.targets).map(([name, t]) => ({
        name,
        url: t.url,
        ratchet: t.ratchet,
      })),
    },
    status: await statusOf(project),
    runs: project.store.runs(15),
    running,
  })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        return res.end(html)
      }
      if (req.method === "GET" && url.pathname === "/api/stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        })
        res.write(`event: hello\ndata: {}\n\n`)
        clients.add(res)
        req.on("close", () => clients.delete(res))
        return
      }
      if (req.method === "GET" && url.pathname === "/api/state")
        return send(res, 200, await state())
      if (req.method === "GET" && url.pathname === "/api/route") {
        const pattern = url.searchParams.get("pattern") ?? ""
        const route = project.lock.routes[pattern]
        if (!route) return send(res, 404, { error: `${pattern} is not in the lock` })
        const observations = Object.fromEntries(
          Object.keys(project.config.targets).flatMap((t) =>
            Object.keys(project.config.vantages).map((v) => [
              `${t}/${v}`,
              project.store.latestFor(t, v).filter((o) => o.route === pattern),
            ]),
          ),
        )
        return send(res, 200, { pattern, route, observations })
      }
      if (req.method === "GET" && url.pathname === "/api/compare") {
        return send(
          res,
          200,
          await compareRefs(
            project,
            url.searchParams.get("before") ?? "",
            url.searchParams.get("after") ?? "",
          ),
        )
      }
      if (req.method === "POST" && url.pathname === "/api/run") {
        if (running)
          return send(res, 409, { error: `already running ${running.targets.join(", ")}` })
        const input = await body(req)
        const targets: string[] = input.targets?.length
          ? input.targets
          : Object.keys(project.config.targets)
        for (const t of targets)
          if (!project.config.targets[t]) return send(res, 400, { error: `No target "${t}"` })
        void startRuns(targets, input.label || undefined, input.route || undefined)
        return send(res, 202, { started: targets })
      }
      if (req.method === "POST" && url.pathname === "/api/lock") {
        const input = await body(req)
        const keys: string[] | undefined = input.keys
        const changes = await lock(project, {
          from: input.from ?? project.config.baseline,
          only: keys ? (key) => keys.includes(key) : undefined,
          force: Boolean(input.force),
          reason: input.reason,
        })
        broadcast("change", { running })
        return send(res, 200, changes)
      }
      if (req.method === "POST" && url.pathname === "/api/ratchet") {
        const input = await body(req)
        const changes = await ratchet(project, { dryRun: Boolean(input.dryRun) })
        broadcast("change", { running })
        return send(res, 200, changes)
      }
      if (req.method === "POST" && url.pathname === "/api/loosen") {
        const input = await body(req)
        const changes = loosen(project, input.key, input)
        broadcast("change", { running })
        return send(res, 200, changes)
      }
      send(res, 404, { error: "not found" })
    } catch (error) {
      send(res, 400, { error: (error as Error).message })
    }
  })

  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : opts.port
  return {
    url: `http://${opts.host}:${port}`,
    close: async () => {
      clearInterval(watcher)
      for (const client of clients) client.end()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
