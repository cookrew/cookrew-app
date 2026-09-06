import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import {
  HOOK_SCRIPT,
  PANE_POINT,
  connectPage,
  findChrome,
  launchChrome,
  pan,
  recordFrames,
  serveBuild,
  waitForCanvas,
  type CdpPage,
  type FrameCensus,
  type Served
} from '../../scripts/perf-dom-probe.mjs'
import { RENDER } from './budgets'

/**
 * THE REACT RENDER-COUNT GATE (perf lane L6, 2026-09-06).
 *
 * What a pan of the canvas makes React render. The app — the real App in
 * demo mode, the real ReactFlow, the real cards — is built with Vite from
 * tests/perf/fixtures/render-census, served to a headless Chrome behind the
 * React DevTools hook shim, and panned with real mouse events; the shim
 * counts every commit and every component React rebuilt in it.
 *
 * Structure, not speed: the gate is that a pan which moves no card off the
 * stage renders NO card wrapper and never the app shell. Before the lane a
 * pan re-rendered every visible card on every one of ~2.5 commits a frame,
 * because App itself subscribed to the viewport and handed ReactFlow inline
 * handlers. That wiring is reproduced in legacy.tsx and asserted to do
 * exactly that, so a green result here is known to come from a counter that
 * can see the regression it guards against.
 *
 * Needs a Chrome (scripts/perf-dom-probe.mjs findChrome; COOKREW_CHROME to
 * name one). Without it the file reports why and skips — a machine with no
 * browser has no renderer to measure.
 */

const FIXTURE = path.join(__dirname, 'fixtures', 'render-census')
/** Frames of the pan, out and back; step 2 px so no card leaves the stage. */
const FRAMES = 30
const STAGE = { width: 1600, height: 1000 }

const chrome = findChrome()
if (!chrome) process.stdout.write('render-count: no Chrome found — gate skipped (set COOKREW_CHROME)\n')
const describeWithChrome = chrome ? describe : describe.skip

interface Census {
  cards: number
  pan: FrameCensus
  /** One card renamed while recording — the app page only. */
  rename: FrameCensus | null
  errors: string[]
}

describeWithChrome('React render count across viewport changes', () => {
  let out = ''
  let served: Served | null = null

  beforeAll(async () => {
    out = mkdtempSync(path.join(tmpdir(), 'cookrew-render-census-'))
    await build({
      root: FIXTURE,
      configFile: false,
      logLevel: 'silent',
      base: './',
      plugins: [react()],
      build: {
        outDir: out,
        emptyOutDir: true,
        // The census names components by their function name.
        minify: false,
        rollupOptions: {
          input: { index: path.join(FIXTURE, 'index.html'), legacy: path.join(FIXTURE, 'legacy.html') }
        }
      }
    })
    served = await serveBuild(out, null, { remote: false })
  }, 240_000)

  afterAll(() => {
    served?.close()
    if (out) rmSync(out, { recursive: true, force: true })
  })

  async function census(pageName: string): Promise<Census> {
    const browser = await launchChrome({ ...STAGE, chrome })
    try {
      const page: CdpPage = await connectPage(browser.port)
      await page.send('Page.enable')
      await page.send('Runtime.enable')
      const errors: string[] = []
      page.on('Runtime.exceptionThrown', (params) => {
        const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
        errors.push(details?.exception?.description ?? details?.text ?? 'exception')
      })
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK_SCRIPT })
      await page.send('Page.navigate', { url: `http://127.0.0.1:${served!.port}/${pageName}` })
      const cards = await waitForCanvas(page, 90_000)
      const point = await page.evaluate<{ x: number; y: number } | null>(PANE_POINT)
      expect(point, 'a pane point to pan from').not.toBeNull()
      const result = await recordFrames(page, () => pan(page, point!, FRAMES, 2))
      const rename =
        pageName === 'index.html'
          ? await recordFrames(page, async () => {
              await page.evaluate("window.__renameCard('Agent 0, renamed')")
              await page.frame()
              await page.frame()
              return 2
            })
          : null
      page.close()
      return { cards, pan: result, rename, errors }
    } finally {
      await browser.kill()
    }
  }

  const line = (label: string, c: Census): void => {
    const top = Object.entries(c.pan.renders)
      .slice(0, 6)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')
    const rename = c.rename
      ? ` | rename: ${c.rename.commits} commits; ${Object.entries(c.rename.renders)
          .slice(0, 8)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')}`
      : ''
    process.stdout.write(
      `render-count ${label}: ${c.cards} cards, ${c.pan.frames} frames, ${c.pan.commits} commits (${c.pan.commitsPerFrame.toFixed(2)}/frame); ${top}${rename}\n`
    )
  }

  it('the app: a pan that moves no card off the stage renders no card and never the app shell', async () => {
    const c = await census('index.html')
    line('app', c)
    expect(c.errors, 'no uncaught exception in the page').toEqual([])
    expect(c.cards).toBeGreaterThanOrEqual(24)
    // Structural. Every card wrapper is memo'd on stable props and reads no
    // viewport; the arbiter that does is a leaf. Zero, not "few".
    expect(c.pan.renders.NodeWrapper ?? 0).toBe(0)
    expect(c.pan.cards).toEqual([])
    expect(c.pan.renders.Canvas ?? 0).toBe(0)
    expect(c.pan.renders.Header ?? 0).toBe(0)
    expect(c.pan.renders.Dock ?? 0).toBe(0)
    // The arbiter DOES render per frame — that is its job — and nothing else
    // of ours should be close.
    expect(c.pan.renders.LodArbiter ?? 0).toBeGreaterThan(0)
    expect(c.pan.commitsPerFrame).toBeLessThanOrEqual(RENDER.commitsPerPanFrameMax)
    // The other side of zero: a frozen canvas would also render nothing on a
    // pan. One card renamed through the api must reach exactly that card and
    // no other. Counted by node id, not by render: ReactFlow re-measures a
    // changed card, so the one card renders a few times across the
    // broadcast's commits — what must not happen is a second card.
    expect(c.rename?.cards).toEqual(['card-0'])
    expect(c.rename?.renders.TerminalNode ?? 0).toBeGreaterThanOrEqual(1)
  }, 240_000)

  // This one is also the canary for the name the gate keys on: `NodeWrapper`
  // is xyflow's internal component. If a library upgrade renames it, this
  // test — which must see thousands of them — is what goes red first, and
  // the app test's zero stops meaning anything until the name is updated.
  it('the wiring this gate exists for: the LOD in the parent re-renders every card every frame', async () => {
    const c = await census('legacy.html')
    line('legacy', c)
    expect(c.cards).toBeGreaterThanOrEqual(24)
    // At least one commit per frame re-renders every visible card.
    expect(c.pan.renders.NodeWrapper ?? 0).toBeGreaterThanOrEqual(c.cards * c.pan.frames)
  }, 240_000)
})
