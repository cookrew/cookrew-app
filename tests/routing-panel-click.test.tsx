import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { connectPage, findChrome, launchChrome, serveBuild, waitForCanvas, type CdpPage, type Served } from '../scripts/perf-dom-probe.mjs'

/**
 * THE ROUTING PANEL, CLICKED.
 *
 * The real App on the demo api (tests/perf/fixtures/route-preview), built
 * with Vite and driven in a headless Chrome with real clicks: ADD → API key
 * → deepseek types exactly one line, `magpie provider add deepseek `,
 * WITHOUT Enter, and leaves the Setup pane holding the keyboard focus so the
 * paste lands there; INSTALL types its line WITH Enter. There is no DOM test
 * environment in this project, so the clicks are a browser's.
 *
 * Needs a Chrome (scripts/perf-dom-probe.mjs findChrome; COOKREW_CHROME to
 * name one). Without it the file reports why and skips.
 */

const FIXTURE = path.join(__dirname, 'perf', 'fixtures', 'route-preview')
const chrome = findChrome()
if (!chrome) process.stdout.write('routing-panel-click: no Chrome found — skipped (set COOKREW_CHROME)\n')
const describeWithChrome = chrome ? describe : describe.skip

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describeWithChrome('the Routing panel, clicked', () => {
  let out = ''
  let served: Served | null = null

  beforeAll(async () => {
    out = mkdtempSync(path.join(tmpdir(), 'cookrew-route-click-'))
    await build({ root: FIXTURE, configFile: false, logLevel: 'silent', base: './', plugins: [react()], build: { outDir: out, emptyOutDir: true, minify: false } })
    served = await serveBuild(out, null, { remote: false })
  }, 240_000)

  afterAll(() => {
    served?.close()
    if (out) rmSync(out, { recursive: true, force: true })
  })

  async function click(page: CdpPage, selector: string): Promise<void> {
    const r = await page.evaluate<string>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'MISSING'; el.click(); return 'ok' })()`)
    expect(r, selector).toBe('ok')
  }

  it('ADD → API key → deepseek types the key line once, without Enter, and focuses the pane; INSTALL types with Enter', async () => {
    const browser = await launchChrome({ width: 1280, height: 900, chrome })
    try {
      const page: CdpPage = await connectPage(browser.port)
      await page.send('Page.enable')
      await page.send('Runtime.enable')
      const errors: string[] = []
      page.on('Runtime.exceptionThrown', (params) => {
        const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
        errors.push(details?.exception?.description ?? details?.text ?? 'exception')
      })
      await page.send('Page.navigate', { url: `http://127.0.0.1:${served!.port}/index.html` })
      await waitForCanvas(page, 90_000, 800)
      await page.evaluate("window.__routeStatus('online')")
      await click(page, '.cr-routing-entry')
      await sleep(400)
      await click(page, '.cr-routing-add .cr-routing-btn')
      await sleep(200)
      await click(page, '.cr-routing-menu button[aria-expanded]')
      await sleep(200)
      await click(page, '[data-preset="deepseek"]')
      // The Setup card is created through the normal path and typed into once it is on the canvas.
      await sleep(1500)
      const typed = await page.evaluate<{ terminalId: string; data: string }[]>('window.__typed()')
      expect(typed.map((t) => t.data)).toEqual(['magpie provider add deepseek '])
      expect(await page.evaluate<boolean>('window.__setupFocused()'), 'the Setup pane holds the focus after the key line').toBe(true)
      // The same card again: INSTALL types its line with Enter, and nothing else was typed in between.
      await page.evaluate("window.__routeStatus('absent')")
      await sleep(300)
      await click(page, '.cr-routing-status .cr-routing-btn')
      await sleep(600)
      const after = await page.evaluate<{ terminalId: string; data: string }[]>('window.__typed()')
      expect(after.map((t) => t.data)).toEqual(['magpie provider add deepseek ', 'curl -fsSL https://usemagpie.ai/install.sh | sh\r'])
      expect(new Set(after.map((t) => t.terminalId)).size, 'one Setup card for both lines').toBe(1)
      expect(await page.evaluate<number>("document.querySelectorAll('.cr-routing-panel input').length")).toBe(0)
      expect(errors).toEqual([])
      page.close()
    } finally {
      await browser.kill()
    }
  }, 240_000)
})
