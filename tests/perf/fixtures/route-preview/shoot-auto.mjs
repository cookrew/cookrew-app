// The Add menu's auto-group item, disabled and enabled, on the demo api:
//   node tests/perf/fixtures/route-preview/shoot-auto.mjs → /tmp/e2e-panel-auto-{disabled,enabled}.png
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { connectPage, findChrome, launchChrome, serveBuild, waitForCanvas } from '../../../../scripts/perf-dom-probe.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const chrome = findChrome()
if (!chrome) throw new Error('no Chrome found (set COOKREW_CHROME)')
const out = mkdtempSync(path.join(tmpdir(), 'cookrew-e2e-panel-'))
await build({ root: here, configFile: false, logLevel: 'silent', base: './', plugins: [react()], build: { outDir: out, emptyOutDir: true, minify: false } })
const served = await serveBuild(out, null, { remote: false })
const browser = await launchChrome({ width: 1280, height: 900, chrome })

/** A real click at the element's centre, through CDP. */
async function click(page, selector) {
  const box = await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  if (!box) throw new Error(`no ${selector}`)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
}

try {
  for (const on of [false, true]) {
    const page = await connectPage(browser.port)
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    await page.send('Page.navigate', { url: `http://127.0.0.1:${served.port}/index.html` })
    await waitForCanvas(page, 90_000, 800)
    await page.evaluate("window.__routeStatus('online')")
    await page.evaluate(`window.__routeAuto(${on})`)
    await sleep(300)
    await click(page, '.cr-routing-entry')
    await sleep(500)
    await click(page, '.cr-routing-add .cr-routing-btn')
    await sleep(400)
    const item = await page.evaluate(`(() => { const el = document.querySelector('[data-item="auto-group"]'); return el ? { disabled: el.disabled, text: el.textContent } : null })()`)
    const shot = await page.send('Page.captureScreenshot', { format: 'png' })
    const file = `/tmp/e2e-panel-auto-${on ? 'enabled' : 'disabled'}.png`
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    process.stdout.write(`${file} · ${JSON.stringify(item)}\n`)
    page.close()
  }
} finally {
  await browser.kill()
  served.close()
  rmSync(out, { recursive: true, force: true })
}
