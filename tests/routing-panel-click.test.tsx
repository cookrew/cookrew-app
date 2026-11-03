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
 * with Vite and driven in a headless Chrome with real pointer clicks
 * (CDP Input.dispatchMouseEvent at each element's centre): ADD → API key
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

  /** A REAL click: the pointer moves to the element's centre and presses, through CDP — what a hand does, not el.click(). */
  async function click(page: CdpPage, selector: string): Promise<void> {
    const box = await page.evaluate<{ x: number; y: number } | null>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`
    )
    expect(box, selector).not.toBeNull()
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box!.x, y: box!.y })
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box!.x, y: box!.y, button: 'left', clickCount: 1 })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box!.x, y: box!.y, button: 'left', clickCount: 1 })
  }

  /** Routing lives in the header's More menu (Header.tsx): open it, then the row. */
  async function openRouting(page: CdpPage): Promise<void> {
    await click(page, '.cr-more-btn')
    await page.evaluate(`new Promise((resolve) => setTimeout(resolve, 120))`)
    await click(page, '.cr-more-menu .cr-routing-entry')
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
      await openRouting(page)
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

  /** The DEFAULT chip with this text: where it is, and whether it is checked. */
  async function chip(page: CdpPage, id: string): Promise<{ x: number; y: number; checked: string | null } | null> {
    return page.evaluate<{ x: number; y: number; checked: string | null } | null>(
      `(() => { const el = [...document.querySelectorAll('.cr-routing-default button.cr-routing-pick')].find((b) => (b.textContent || '').trim() === ${JSON.stringify(id)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, checked: el.getAttribute('aria-checked') } })()`
    )
  }

  async function escape(page: CdpPage): Promise<void> {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  }

  it('a picked DEFAULT survives a push of the same state, a close and a reopen, and a read that lands after a newer pick', async () => {
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
      await openRouting(page)
      await sleep(400)
      // The pick: the chip goes on, direct goes off.
      const before = await chip(page, 'deepseek/deepseek-v4')
      expect(before).not.toBeNull()
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before!.x, y: before!.y })
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before!.x, y: before!.y, button: 'left', clickCount: 1 })
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before!.x, y: before!.y, button: 'left', clickCount: 1 })
      await sleep(300)
      expect((await chip(page, 'deepseek/deepseek-v4'))?.checked).toBe('true')
      expect((await chip(page, 'direct'))?.checked).toBe('false')
      // Main pushes the same state again, as it does after any probe: nothing moves.
      await page.evaluate('window.__routePush()')
      await sleep(300)
      expect((await chip(page, 'deepseek/deepseek-v4'))?.checked).toBe('true')
      // Closed on Escape and reopened from the header: the reopened panel re-reads main and shows the pick.
      await escape(page)
      await sleep(300)
      expect(await page.evaluate<number>("document.querySelectorAll('.cr-routing-panel').length")).toBe(0)
      await openRouting(page)
      await sleep(500)
      expect((await chip(page, 'deepseek/deepseek-v4'))?.checked).toBe('true')
      expect((await chip(page, 'direct'))?.checked).toBe('false')
      // THE RACE. The next read answers late, with the state as it was when
      // asked. The panel is reopened (a read goes out, holding deepseek) and
      // the owner picks sonnet before it lands. The late read must not put
      // deepseek back.
      await page.evaluate('window.__routeReadLag(900)')
      await escape(page)
      await sleep(200)
      await openRouting(page)
      await sleep(150)
      const sonnet = await chip(page, 'claude/claude-sonnet-5')
      expect(sonnet).not.toBeNull()
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sonnet!.x, y: sonnet!.y })
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sonnet!.x, y: sonnet!.y, button: 'left', clickCount: 1 })
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sonnet!.x, y: sonnet!.y, button: 'left', clickCount: 1 })
      await sleep(200)
      expect((await chip(page, 'claude/claude-sonnet-5'))?.checked).toBe('true')
      await sleep(1200) // the late read has landed by now
      expect((await chip(page, 'claude/claude-sonnet-5'))?.checked, 'the late read did not revert the pick').toBe('true')
      expect((await chip(page, 'deepseek/deepseek-v4'))?.checked).toBe('false')
      expect(errors).toEqual([])
      page.close()
    } finally {
      await browser.kill()
    }
  }, 240_000)
})
