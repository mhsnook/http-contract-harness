// Regenerates docs/screenshots: the dashboard at each stage of `hch demo`, so the README can
// show a port moving through its phases. Needs a build (`pnpm build`) and a Chromium
// (HARNESS_CHROMIUM, or Playwright's). Takes about ten minutes, most of it the demo measuring.
//
//   node scripts/screenshots.mjs [--out docs/screenshots] [--verbose]
//
// --verbose prints the demo's own output as well, which FORCE_COLOR=1 keeps in colour.
import { mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { chromium } from "playwright-core"
import { runDemo } from "../dist/demo/index.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const { values } = parseArgs({
  options: {
    out: { type: "string", default: "docs/screenshots" },
    verbose: { type: "boolean", default: false },
  },
})
const OUT = resolve(ROOT, values.out)
const CHROMIUM =
  process.env.HARNESS_CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ executablePath: CHROMIUM })
const PORT = 4870
const stages = {
  inventory: { file: "1-inventory" },
  profile: { file: "2-profile" },
  "dev-failing": { file: "3-dev-failing" },
  "dev-passing": { file: "4-dev-passing" },
  "production-failing": { file: "5-production-failing", open: "/:country/:city", hover: true },
  experiment: { file: "6-experiment" },
  "good-enough": { file: "7-good-enough", open: "/:country/:city" },
}

async function shoot({ file, open, hover }) {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 900 },
    deviceScaleFactor: 1.5,
  })
  await page.goto(`http://127.0.0.1:${PORT}/`)
  await page.waitForSelector("tr.route")
  await page.selectOption("#state", "all")
  if (open) await page.click(`tr.route[data-route="${open}"]`)
  // The target cards repeat what the table says, at a size that pushes the table off the shot.
  await page.evaluate(() => (document.getElementById("targets").style.display = "none"))
  // A real hover scrolls the page mid-capture, so show the first failing card's button directly.
  if (hover)
    await page.evaluate(() => {
      const card = [...document.querySelectorAll(".detail .card")].find((c) =>
        c.querySelector(".pill.fail"),
      )
      if (card) card.querySelector(".copy").style.opacity = "1"
    })
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(OUT, `${file}.png`), fullPage: true })
  await page.close()
  console.error(`  ${file}.png`)
}

const demo = await runDemo({
  port: PORT,
  browser: CHROMIUM,
  quiet: !values.verbose,
  checkpoint: async (name) => {
    if (stages[name]) await shoot(stages[name])
  },
})
await demo.stop()
await browser.close()
console.error(`Screenshots in ${OUT}`)
