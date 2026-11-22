import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import {
  HOOK_SCRIPT,
  connectPage,
  findChrome,
  launchChrome,
  recordFrames,
  serveBuild,
  type CdpPage,
  type FrameCensus,
  type Served
} from '../../scripts/perf-dom-probe.mjs'
import { CURRENT_STOP, ZOOM_POINT, framesFor, wheelScroll, zoomTo, type ScrollMoved, type ZoomLeg } from '../../scripts/perf-zoom-motion.mjs'
import { RENDER } from './budgets'
import { AGENTS } from './fixtures/render-census/seed'

/**
 * THE REACT RENDER-COUNT GATE, for the zoom view.
 *
 * The canvas this gate was written for (perf lane L6, 2026-09-06: a ReactFlow
 * pan must render no card) was retired on 2026-10-30 (29765969); what the app
 * draws now is the zoom view, and it moves differently. A stop-to-stop zoom
 * commits its TARGET once (zoom-store.ts · go) and the painter
 * (use-zoom-motion.ts) walks there by writing styles through refs; a scroll of
 * the crew writes a ref and wakes the painter. So the same two questions get
 * sharper answers here:
 *
 *   MOTION     a real wheel scroll, and a zoom from one stop to the next by
 *              the stop bar's own button, cost React O(1) commits, not one
 *              per frame, and render no agent at all. An agent's node is
 *              memo'd on stable props (ZoomView · stable()) and reads no
 *              zoom value; the moment one does, every agent renders on every
 *              motion, and this goes red (proven: a run with AgentNode
 *              un-memo'd failed the zoom and the rename tests).
 *   ONE EDIT   one agent renamed through the api renders that agent's node,
 *              by its React key, and no other. The model keeps the identity
 *              of what did not change (same-props.ts); the moment it rebuilds
 *              every agent, a rename renders the whole crew.
 *
 * And it proves its own eyes, as the retired legacy fixture did: every agent
 * renamed renders every agent's node; one note renamed renders an ItemNode;
 * one preset changed renders an InkAvatar. A component renamed in source, or
 * turned anonymous, fails one of those first instead of leaving a zero that
 * means nothing. Each motion also proves it MOVED: a scroll that scrolled
 * nothing, or a zoom that jumped in one frame, would render nothing too.
 *
 * The app is the real App in demo mode (tests/perf/fixtures/render-census),
 * built with Vite and counted through the React DevTools hook shim in
 * scripts/perf-dom-probe.mjs; the gestures are scripts/perf-zoom-motion.mjs,
 * which the nightly DOM probe drives too. Needs a Chrome (COOKREW_CHROME to
 * name one); without one the file says why and skips.
 */

const FIXTURE = path.join(__dirname, 'fixtures', 'render-census')
/** Wheel ticks of the crew scroll, down and back up. */
const SCROLL_TICKS = 30
/**
 * A phone's width: below 760 px the crew is one scrolling column (ZoomView ·
 * canPan), which is where a wheel or a finger moves it. On a wide screen the
 * crew fits and a scroll moves nothing — a zero there would prove nothing.
 */
const STAGE = { width: 500, height: 900 }

const chrome = findChrome()
if (!chrome) process.stdout.write('render-count: no Chrome found — gate skipped (set COOKREW_CHROME)\n')
const describeWithChrome = chrome ? describe : describe.skip

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Renders of a component by its source name. The fixture is built unminified,
 * but Rollup's scope hoisting still renames a function whose name is taken
 * elsewhere in the bundle (AgentNode → AgentNode2, Thumb → Thumb$1).
 */
const isNamed = (name: string, key: string): boolean => new RegExp(`^${name}(\\$?\\d+)?$`).test(key)
const rendersOf = (c: FrameCensus, name: string): number =>
  Object.entries(c.renders).reduce((sum, [key, n]) => (isNamed(name, key) ? sum + n : sum), 0)
const keysOf = (c: FrameCensus, name: string): string[] =>
  [...new Set(Object.entries(c.keyed).flatMap(([key, ids]) => (isNamed(name, key) ? ids : [])))].sort()
const totalRenders = (c: FrameCensus): number => Object.values(c.renders).reduce((sum, n) => sum + n, 0)

interface Census {
  agentsDrawn: number
  zoomIn: ZoomLeg
  scroll: FrameCensus
  /** How far each face moved at the bottom of the scroll, and how far the wheel asked. */
  moved: ScrollMoved
  zoomOut: ZoomLeg
  renameOne: FrameCensus
  renameAll: FrameCensus
  renameItem: FrameCensus
  setPreset: FrameCensus
  errors: string[]
}

async function waitForCrew(page: CdpPage, timeoutMs = 90_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const drawn = await page.evaluate<number>("document.querySelectorAll('.zv-card').length").catch(() => 0)
    if (drawn >= AGENTS) {
      await sleep(2500) // fonts, the first measure, the painter's first rest
      return drawn
    }
    await sleep(250)
  }
  throw new Error(`the zoom view never drew ${AGENTS} agents`)
}

/** Record a change made through the api, and a second and a half for every commit it causes. */
const EDIT_SETTLE_MS = 1500
const edit = (page: CdpPage, expression: string): Promise<FrameCensus> =>
  recordFrames(page, async () => {
    await page.evaluate(expression)
    return framesFor(page, EDIT_SETTLE_MS)
  })

describeWithChrome('React render count of the zoom view', () => {
  let out = ''
  let served: Served | null = null
  let census: Census

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
        rollupOptions: { input: { index: path.join(FIXTURE, 'index.html') } }
      }
    })
    served = await serveBuild(out, null, { remote: false })
    const browser = await launchChrome({ ...STAGE, chrome })
    try {
      const page = await connectPage(browser.port)
      await page.send('Page.enable')
      await page.send('Runtime.enable')
      // The painter jumps under reduced motion (use-zoom-motion.ts); a runner
      // that reports it would hide per-frame work in a one-frame zoom.
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
      const errors: string[] = []
      page.on('Runtime.exceptionThrown', (params) => {
        const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
        errors.push(details?.exception?.description ?? details?.text ?? 'exception')
      })
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK_SCRIPT })
      await page.send('Page.navigate', { url: `http://127.0.0.1:${served.port}/index.html` })
      const agentsDrawn = await waitForCrew(page)
      const from = (await page.evaluate<string | null>(CURRENT_STOP)) ?? 'workspaces'
      const record = (run: () => Promise<number>): Promise<FrameCensus> => recordFrames(page, run)
      // In to the crew by the bar's own button, scroll it, and back out.
      const zoomIn = await zoomTo(page, 'agents', record)
      const point = await page.evaluate<{ x: number; y: number } | null>(ZOOM_POINT)
      if (!point) throw new Error('no zoom view to scroll')
      let moved: ScrollMoved = { perFacePx: 0, requestedPx: 0 }
      const scroll = await record(() => wheelScroll(page, point, SCROLL_TICKS, (m) => (moved = m)))
      const zoomOut = await zoomTo(page, from, record)
      const renameOne = await edit(page, "window.__renameAgent('agent-3', 'Agent 3, renamed')")
      const renameAll = await edit(page, "window.__renameAll('again')")
      const renameItem = await edit(page, "window.__editNote('note-2', 'Note two, rewritten')")
      const setPreset = await edit(page, "window.__setPreset('agent-5', 'Codex')")
      page.close()
      census = { agentsDrawn, zoomIn, scroll, moved, zoomOut, renameOne, renameAll, renameItem, setPreset, errors }
    } finally {
      await browser.kill()
    }
    const top = (c: FrameCensus): string =>
      `${c.frames} frames, ${c.commits} commits, ${totalRenders(c)} renders; ${Object.entries(c.renders).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ')}`
    process.stdout.write(
      [
        `render-count: ${census.agentsDrawn} agents drawn`,
        `  zoom in → ${census.zoomIn.landed} (travelled ${census.zoomIn.travel}): ${top(census.zoomIn.census)}`,
        `  scroll (each face moved ${Math.round(census.moved.perFacePx)} of ${census.moved.requestedPx} px asked): ${top(census.scroll)}`,
        `  zoom out → ${census.zoomOut.landed} (travelled ${census.zoomOut.travel}): ${top(census.zoomOut.census)}`,
        `  rename one: ${top(census.renameOne)}; AgentNode keys ${JSON.stringify(keysOf(census.renameOne, 'AgentNode'))}`,
        `  rename all: ${top(census.renameAll)}; AgentNode keys ${keysOf(census.renameAll, 'AgentNode').length}`,
        `  rewrite a note: ${top(census.renameItem)}`,
        `  change a preset: ${top(census.setPreset)}`
      ].join('\n') + '\n'
    )
  }, 300_000)

  afterAll(() => {
    served?.close()
    if (out) rmSync(out, { recursive: true, force: true })
  })

  it('draws the crew with no uncaught exception', () => {
    expect(census.errors, 'no uncaught exception in the page').toEqual([])
    // The seeded agents and the demo api's own conductor.
    expect(census.agentsDrawn).toBeGreaterThanOrEqual(AGENTS)
  })

  it('a zoom in to the crew and back out renders no agent, and commits O(1), not per frame', () => {
    expect(census.zoomIn.landed).toBe('agents')
    expect(census.zoomOut.landed).not.toBe('agents')
    for (const leg of [census.zoomIn, census.zoomOut]) {
      // The other side of zero: the faces were seen between press and rest.
      expect(leg.travel, 'the zoom travelled over frames, not jumped').toBe(true)
      // Enough frames that a commit per frame could not hide under the commit
      // budget: more frames than the budget, with one to spare. A fixed 20
      // failed a slow macOS runner (10 frames over the zoom, PR #126), and
      // twice the budget failed one on 2026-11-22 (7 and 8 frames, main and
      // dev alike) with every render and commit gate passed. A commit per
      // frame over 6 frames is 6 commits, still over the budget of 4.
      expect(leg.census.frames).toBeGreaterThan(RENDER.commitsPerStopZoom + 1)
      expect(rendersOf(leg.census, 'AgentNode')).toBe(0)
      expect(rendersOf(leg.census, 'ItemNode')).toBe(0)
      expect(leg.census.commits).toBeLessThanOrEqual(RENDER.commitsPerStopZoom)
      expect(totalRenders(leg.census)).toBeLessThanOrEqual(RENDER.rendersPerStopZoom)
    }
  })

  it('a wheel scroll of the crew moves it and renders nothing at all', () => {
    // The other side of zero: a scroll that moved nothing would also render nothing.
    // Each face, not a sum over forty: at least half the scroll the wheel asked for.
    expect(census.moved.requestedPx).toBe(SCROLL_TICKS * 40)
    expect(census.moved.perFacePx).toBeGreaterThanOrEqual(census.moved.requestedPx * 0.5)
    expect(census.scroll.commits).toBeLessThanOrEqual(RENDER.commitsPerScroll)
    expect(totalRenders(census.scroll)).toBeLessThanOrEqual(RENDER.rendersPerScroll)
  })

  it('one agent renamed through the api renders that agent alone, and no face', () => {
    // The change reached the view: the zoom view itself rendered for it.
    expect(rendersOf(census.renameOne, 'ZoomView')).toBeGreaterThanOrEqual(1)
    expect(keysOf(census.renameOne, 'AgentNode')).toEqual(['agent-3'])
    // Keyed or not, the agent's node renders a bounded few times (once a commit), never per agent.
    expect(rendersOf(census.renameOne, 'AgentNode')).toBeLessThanOrEqual(census.renameOne.commits)
    expect(rendersOf(census.renameOne, 'ItemNode')).toBe(0)
    // A name is no part of a face (InkAvatar is memo'd on id, preset, status): no avatar redraws.
    expect(rendersOf(census.renameOne, 'InkAvatar')).toBe(0)
  })

  // The canaries: the counter, each component's name and its key are live.
  it('every agent renamed renders every agent: the gate can see a crew-wide render', () => {
    const renamed = Array.from({ length: AGENTS }, (_, i) => `agent-${i}`)
    expect(keysOf(census.renameAll, 'AgentNode')).toEqual(expect.arrayContaining(renamed))
  })

  it('a note rewritten renders an ItemNode, and a preset changed renders an InkAvatar: their zeros mean something', () => {
    expect(rendersOf(census.renameItem, 'ItemNode')).toBeGreaterThan(0)
    expect(rendersOf(census.setPreset, 'InkAvatar')).toBeGreaterThan(0)
  })
})
