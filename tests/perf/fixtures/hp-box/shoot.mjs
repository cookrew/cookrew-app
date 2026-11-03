// The HP box stills: node tests/perf/fixtures/hp-box/shoot.mjs → /tmp/hp-box-<scene>.png
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { connectPage, findChrome, launchChrome, serveBuild } from '../../../../scripts/perf-dom-probe.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const SCENES = ['ticking', 'paused-exposure', 'question', 'answer', 'inbox-sous']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = findChrome()
if (!chrome) throw new Error('no Chrome found (set COOKREW_CHROME)')
const out = mkdtempSync(path.join(tmpdir(), 'cookrew-hp-box-'))
await build({ root: here, configFile: false, logLevel: 'silent', base: './', plugins: [react()], build: { outDir: out, emptyOutDir: true, minify: false } })
const served = await serveBuild(out, null, { remote: false })
const browser = await launchChrome({ width: 1100, height: 520, chrome })
try {
  for (const scene of SCENES) {
    const page = await connectPage(browser.port)
    await page.send('Page.enable')
    await page.send('Page.navigate', { url: `http://127.0.0.1:${served.port}/index.html?scene=${scene}` })
    await sleep(1800)
    const shot = await page.send('Page.captureScreenshot', { format: 'png' })
    const file = `/tmp/hp-box-${scene}.png`
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    process.stdout.write(`${file}\n`)
    page.close()
  }
} finally {
  await browser.kill()
  served.close()
  rmSync(out, { recursive: true, force: true })
}
