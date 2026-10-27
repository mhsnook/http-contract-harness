import { spawn } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import pc from "picocolors"
import { CONFIG_FILE, PROBES_DIR, writeLock } from "../config.ts"
import { readLedger } from "../ledger.ts"
import { openProject } from "../project.ts"
import { randomUUID } from "node:crypto"
import { serveRunner } from "../runner.ts"
import { serve } from "../server/server.ts"
import { DEMO_TRAFFIC, startSite, type Fixes, type SiteKind } from "./sites.ts"

export const STEPS = ["survey", "inventory", "profile", "dev", "production", "experiment"] as const
export type Step = (typeof STEPS)[number]

export type DemoOptions = {
  dir?: string
  until?: Step
  port?: number
  browser?: string
  repeats?: number
  quiet?: boolean
  serve?: boolean
}

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "../..")
const CLI = existsSync(join(HERE, "../cli.js")) ? join(HERE, "../cli.js") : join(HERE, "../cli.ts")

/**
 * Four simulated sites, a project that measures them, and every phase of a port walked through
 * with the real CLI, so what it prints is what a person or an agent would see. The sites keep
 * running afterwards, with switches that stand in for deploying a fix.
 */
export async function runDemo(opts: DemoOptions = {}) {
  const fixes: Fixes = { redirect: false, eventCache: false, prerender: false }
  const kinds: SiteKind[] = ["current", "current-dev", "port-dev", "port"]
  const sites = await Promise.all(kinds.map((k) => startSite(k, fixes)))
  const url = Object.fromEntries(kinds.map((k, i) => [k, sites[i]!.url])) as Record<
    SiteKind,
    string
  >

  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "harness-demo-"))
  mkdirSync(dir, { recursive: true })
  const purge = `node -e "fetch(new URL('/__purge?path=' + encodeURIComponent(process.env.HARNESS_PATH), process.env.HARNESS_URL))"`
  const browser = opts.browser ?? process.env.HARNESS_CHROMIUM
  const token = randomUUID()
  const runner = await serveRunner({
    port: 0,
    host: "127.0.0.1",
    token,
    region: "nam",
    browser: browser ? { executablePath: browser } : {},
    cwd: dir,
  })
  writeFileSync(
    join(dir, CONFIG_FILE),
    JSON.stringify(
      {
        baseline: "current",
        targets: {
          current: {
            url: url.current,
            options: { purge },
            note: "the site readers use today, on Vercel",
          },
          "current-dev": {
            url: url["current-dev"],
            vantages: ["local"],
            options: { purge: false },
            note: "the current site in dev mode",
          },
          "port-dev": {
            url: url["port-dev"],
            vantages: ["local"],
            options: { purge: false },
            note: "the port in dev mode",
          },
          port: { url: url.port, options: { purge }, note: "the port, deployed on Cloudflare" },
        },
        tracks: [
          { name: "dev", baseline: "current-dev", port: "port-dev" },
          { name: "production", baseline: "current", port: "port" },
        ],
        vantages: {
          local: {
            region: "weur",
            note: "this machine, standing in for western Europe",
            browser: browser ? { executablePath: browser } : {},
          },
          nam: {
            url: runner.url,
            token,
            region: "nam",
            note: "a runner on this machine too, standing in for one in North America",
          },
        },
        run: { repeats: opts.repeats ?? 5, concurrency: 4 },
        allow: [
          {
            id: "edge-cache-control",
            why: "Cloudflare keeps the route's cache policy at the edge and tells browsers to revalidate",
            field: "cache-control",
            path: "^/api/",
            target: "port",
            expected: "^public, ",
            actual: "^private, max-age=0",
          },
        ],
      },
      null,
      2,
    ),
  )
  writeLock(dir, { version: 2, routes: {} })
  cpSync(join(ROOT, "starters/probes"), join(dir, PROBES_DIR), { recursive: true })
  writeFileSync(join(dir, "traffic.csv"), DEMO_TRAFFIC)

  const print = (text: string) => {
    if (!opts.quiet) console.log(text)
  }
  const say = (text: string) => print(`\n${pc.bold(pc.cyan("▌"))} ${pc.bold(text)}`)
  // Asynchronous on purpose: the simulated sites run in this process, so blocking on the CLI
  // would leave them unable to answer it.
  const hch = (...args: string[]) =>
    new Promise<void>((resolve, reject) => {
      print(pc.dim(`\n$ hch ${args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(" ")}`))
      const child = spawn(process.execPath, [CLI, ...args], {
        cwd: dir,
        stdio: opts.quiet ? "ignore" : "inherit",
        env: { ...process.env, FORCE_COLOR: opts.quiet ? "0" : "1" },
      })
      child.on("error", reject)
      child.on("close", (code) =>
        code === 2 ? reject(new Error(`hch ${args.join(" ")} failed`)) : resolve(),
      )
    })
  const deploy = (fix: keyof Fixes, what: string) => {
    fixes[fix] = true
    print(pc.dim(`\n(deployed: ${what})`))
  }
  const stopAfter = (step: Step) => opts.until === step

  const steps: Record<Step, () => Promise<void>> = {
    survey: async () => {
      say("1. Survey: which routes readers view and land on, and where they are")
      await hch("survey", "--csv", "traffic.csv", "--regions")
    },
    inventory: async () => {
      say("2. Inventory: declare the route patterns, then fill them from the sitemap")
      for (const p of ["/event/:city/:id", "/blog/:slug", "/:country/:city"])
        await hch("route", "add", p)
      await hch("route", "add", "/old-events")
      await hch("route", "add", "/api/events")
      await hch("discover")
      say(
        "…and the ways readers reach the important routes: a cold cache, a locale cookie, a refresh",
      )
      await hch(
        "case",
        "add",
        "/event/:city/:id",
        "cold",
        "--probe",
        "http",
        "--condition",
        "cache=cold",
      )
      await hch("case", "add", "/event/:city/:id", "spanish", "--cookie", "locale=es")
      await hch(
        "case",
        "add",
        "/about",
        "refresh",
        "--probe",
        "http",
        "--condition",
        "cache=revalidate",
      )
      if (browser) {
        await hch(
          "case",
          "add",
          "/event/:city/:id",
          "click-in",
          "--probe",
          "navigate",
          "--condition",
          "from=/",
        )
        await hch("case", "add", "/", "first-load", "--probe", "page")
      }
      await hch("routes")
    },
    profile: async () => {
      say("3. Profile: benchmark the current site, in production and in dev mode, and lock it in")
      await hch("run", "--target", "current", "--target", "current-dev")
      await hch("lock", "--from", "current")
      await hch(
        "note",
        "The current site caches event pages at the edge after the first request (x-vercel-cache: HIT); a cold render takes about 70ms",
        "--route",
        "/event/:city/:id",
        "--tag",
        "cache",
      )
      await hch("plan")
    },
    dev: async () => {
      say("4. Dev parity: the port in dev mode, against the current site in dev mode")
      await hch("run", "--target", "current-dev", "--target", "port-dev")
      await hch("status", "--target", "port-dev")
      await hch("show", "/old-events")
      deploy("redirect", "the port's /old-events redirect answers 301 again")
      await hch("run", "--target", "current-dev", "--target", "port-dev")
      say("The port renders blog posts faster than the current site: a change to carry back")
      await hch("status", "--target", "current-dev", "--target", "port-dev", "--all")
    },
    production: async () => {
      say("5. Production parity: the deployed port, against production, from where readers are")
      await hch("run", "--target", "current", "--target", "port")
      await hch("run", "--target", "current", "--target", "port")
      await hch("status", "--target", "port")
      await hch("show", "/event/:city/:id#default")
    },
    experiment: async () => {
      say("6. Improve: one theory, measured before and after, decided and written down")
      await hch(
        "experiment",
        "start",
        "Cache the event page at the edge for 60 seconds",
        "--route",
        "/event/:city/:id",
        "--target",
        "port",
      )
      deploy("eventCache", "the event page is cached at the edge")
      const id = readLedger(dir).experiments.at(-1)?.id ?? ""
      await hch("experiment", "measure", id)
      await hch(
        "experiment",
        "decide",
        id,
        "keep",
        "--why",
        "TTFB fell by the render time and the cache header matches production again",
      )
      say("…and a theory that did not pan out, written down so no one tries it again")
      await hch(
        "experiment",
        "start",
        "Prerender the city pages at build time",
        "--route",
        "/:country/:city",
        "--target",
        "port",
      )
      deploy("prerender", "the city pages are prerendered at build time")
      const second = readLedger(dir).experiments.at(-1)?.id ?? ""
      await hch("experiment", "measure", second)
      await hch(
        "experiment",
        "decide",
        second,
        "discard",
        "--why",
        "No change: the edge cache already serves these pages, so a prerender saves only the first request",
      )
      await hch("experiment", "list")
      say("The port now beats the lock on a cold event page: the ratchet raises the bar")
      await hch("run", "--target", "current", "--target", "port")
      await hch("ratchet")
      await hch("status", "--all")
      await hch("plan")
    },
  }

  for (const step of STEPS) {
    await steps[step]()
    if (stopAfter(step)) {
      const next = STEPS[STEPS.indexOf(step) + 1]
      if (next) say(`Stopped after ${step}. Carry on from ${next} in ${dir} with hch, live.`)
      break
    }
  }

  const switches = Object.keys(fixes)
    .map((f) => `  curl -X POST '${url.port}/__demo/fix?name=${f}&on=1'`)
    .join("\n")
  let dashboard: { url: string; close(): Promise<void> } | undefined
  if (opts.serve !== false) {
    const project = openProject(dir)
    dashboard = await serve(project, { port: opts.port ?? 4800, host: "127.0.0.1" })
    print(
      [
        "",
        pc.bold(`Dashboard: ${dashboard.url}`),
        `Project:   ${dir}   (cd there and run hch commands against the simulated sites)`,
        `Sites:     ${kinds.map((k) => `${k} ${url[k]}`).join(", ")}`,
        "Switches that stand in for deploying a fix:",
        switches,
        "Ctrl-C stops everything.",
      ].join("\n"),
    )
  }
  return {
    dir,
    url,
    fixes,
    dashboard,
    stop: async () => {
      await dashboard?.close()
      await runner.close()
      for (const s of sites) s.server.close()
    },
  }
}
