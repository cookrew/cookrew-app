import { describe, expect, it } from 'vitest'
import {
  CENSUS,
  FIBER_CENSUS,
  PANE_POINT,
  chromeCommand,
  measureCompanion,
  keyedRenders,
  recordFrames,
  renderReport,
  type CdpPage
} from '../scripts/perf-dom-probe.mjs'
import { CREW_AT, CURRENT_STOP, ZOOM_POINT } from '../scripts/perf-zoom-motion.mjs'

/**
 * The probe's measurement body, run end to end against a FAKE page.
 *
 * scripts/perf-dom-probe.mjs is plain JS: no typecheck reads its body, and the
 * hand-written .d.mts beside it describes the surface, not the code. A
 * ReferenceError inside measureCompanion (a variable passed in but never
 * destructured) once shipped unnoticed because the probe is opt-in and every
 * other test used the helpers around it. This test walks the body itself, so
 * that class of error fails here rather than on the owner's machine.
 */

/** A CDP page that answers every call the measurement makes, and nothing real. */
function fakePage({ panePoint = null }: { panePoint?: { x: number; y: number } | null } = {}): { page: CdpPage; calls: string[] } {
  const calls: string[] = []
  const census = {
    total: 1200,
    cards: 30,
    kinds: { terminal: { cards: 10, elements: 200 }, note: { cards: 10, elements: 100 }, browser: { cards: 10, elements: 100 } },
    edges: 20,
    edgeElements: 100,
    minimapNodes: 170,
    minimapElements: 174,
    offscreenBrowsers: 0,
    offscreenBrowserElements: 0,
    overlays: 0,
    overlayElements: 0,
    board: 0,
    xtermRows: 0,
    images: 0,
    canvases: 0,
    zoom: 'none'
  }
  const page: CdpPage = {
    async send(method) {
      calls.push(method)
      if (method === 'Performance.getMetrics') {
        return { metrics: [{ name: 'JSHeapUsedSize', value: 10 * 1048576 }, { name: 'JSHeapTotalSize', value: 20 * 1048576 }, { name: 'Nodes', value: 2000 }, { name: 'LayoutCount', value: 3 }, { name: 'RecalcStyleCount', value: 4 }] }
      }
      if (method === 'Memory.getDOMCounters') return { documents: 1, nodes: 2000, jsEventListeners: 500 }
      return {}
    },
    on: () => () => undefined,
    async evaluate<T = unknown>(expression: string): Promise<T> {
      calls.push(`evaluate:${expression.slice(0, 40)}`)
      if (expression === CENSUS) return census as T
      if (expression === FIBER_CENSUS) return { fibers: 100, components: { NodeWrapper: 30 } } as T
      if (expression === PANE_POINT) return panePoint as T
      if (expression.includes('.cr-viewseg button')) return true as T
      if (expression.includes(".react-flow__node').length")) return 30 as T
      if (expression.includes('__crRenderCensus.stop')) return { commits: 0, renders: {}, cards: [] } as T
      return 1 as T
    },
    frame: () => Promise.resolve(1),
    close: () => undefined
  }
  return { page, calls }
}

/**
 * The zoom view as the live probe meets it: no canvas pane, a crew of `faces`
 * that the wheel scrolls by exactly its delta, and a stop bar whose 'agents'
 * button starts a zoom that travels (the faces move on each read until it
 * rests). `agentsStop: false` is a bar without that stop.
 */
function zoomViewPage({ agentsStop = true }: { agentsStop?: boolean } = {}): { page: CdpPage; calls: string[] } {
  const { page: base, calls } = fakePage({ panePoint: null })
  const faces = 41
  let offset = 0
  let zooming = 0
  const page: CdpPage = {
    ...base,
    async send(method, params) {
      const p = params as { type?: string; deltaY?: number } | undefined
      if (method === 'Input.dispatchMouseEvent' && p?.type === 'mouseWheel') offset += p.deltaY ?? 0
      return base.send(method, params)
    },
    async evaluate<T = unknown>(expression: string): Promise<T> {
      if (expression === ZOOM_POINT) return { x: 195, y: 422 } as T
      if (expression === CURRENT_STOP) return (agentsStop ? 'agents' : 'workspaces') as T
      if (expression === CREW_AT) {
        if (zooming > 0) zooming -= 1
        return { sum: faces * (1000 - offset) + zooming * faces * 7, faces } as T
      }
      if (expression.includes('.zv-stops button')) {
        calls.push(`press-stop:${/=== "([^"]+)"/.exec(expression)?.[1] ?? '?'}`)
        if (!agentsStop) return false as T
        zooming = 3
        return true as T
      }
      if (expression.includes('__crRenderCensus.stop')) return { commits: 1, renders: {}, cards: [], keyed: { AgentNode: ['a1'] }, keyedCount: 3 } as T
      return base.evaluate<T>(expression)
    }
  }
  return { page, calls }
}

const zoomViewRun = (page: CdpPage) =>
  measureCompanion(
    { port: 0 },
    {
      viewport: 'phone',
      size: { width: 390, height: 844, mobile: true },
      url: 'http://127.0.0.1:1/#pair=nothing',
      apiPort: 1,
      token: 'nothing',
      frames: 2,
      gestures: true,
      serve: null,
      served: null,
      settleMs: 0
    },
    () => Promise.resolve(page)
  ) as Promise<{
    motion: string | null
    pan: { frames: number; commits: number; keyedCount: number } | null
    zoom: { commits: number; keyedCount: number } | null
    zoomTravel: boolean
    scrolledPerFacePx: number
    scrollRequestedPx: number
  }>

describe('perf-dom-probe: the zoom view branch (no canvas pane), as the live probe drives it', () => {
  it('zooms in to the crew by the bar, scrolls it with the wheel, and says how far each face moved', async () => {
    const { page, calls } = zoomViewPage()
    const result = await zoomViewRun(page)
    expect(result.motion).toBe('zoom view scroll')
    // 2 ticks of 40 px down and back: the scroll asked for 80 px, and each face moved 80.
    expect(result.pan?.frames).toBe(4)
    expect(result.scrollRequestedPx).toBe(80)
    expect(result.scrolledPerFacePx).toBe(80)
    expect(result.pan?.keyedCount).toBe(3)
    // The zoom was pressed on the bar's agents stop and was seen travelling.
    expect(calls).toContain('press-stop:agents')
    expect(result.zoomTravel).toBe(true)
    expect(result.zoom?.keyedCount).toBe(3)
    expect(calls.filter((c) => c === 'Input.dispatchMouseEvent').length).toBeGreaterThanOrEqual(4)
    // The report speaks of a scroll, never a pan or a pane.
    const report = renderReport(result as never)
    expect(report).toContain('zoom in to the crew:')
    expect(report).toContain('scroll:')
    expect(report).toContain('moved 80 px a face of 80 asked')
    expect(report).not.toMatch(/\bpan\b|pane point/)
  }, 30_000)

  it('a bar without an agents stop is reported as that, not as a missing pane', async () => {
    const result = await zoomViewRun(zoomViewPage({ agentsStop: false }).page)
    expect(result.zoom).toBeNull()
    expect(result.zoomTravel).toBe(false)
    const report = renderReport(result as never)
    expect(report).toContain('zoom in to the crew: no agents stop on the bar')
    expect(report).not.toContain('pane point')
  }, 30_000)
})

describe('perf-dom-probe: the measurement body runs against a fake page', () => {
  it('measures a canvas at rest with no gestures, naming the viewport it was given', async () => {
    const { page, calls } = fakePage()
    const result = (await measureCompanion(
      { port: 0 },
      {
        viewport: 'phone',
        size: { width: 390, height: 844, mobile: true },
        url: 'http://127.0.0.1:1/#pair=nothing',
        apiPort: 1, // nobody listens: the workspace shape reads as null
        token: 'nothing',
        frames: 2,
        gestures: false,
        serve: null,
        served: null,
        settleMs: 0
      },
      () => Promise.resolve(page)
    )) as { viewport: string; rest: { dom: { total: number }; fiber: { fibers: number }; metrics: { jsHeapUsedMb: number } }; workspace: unknown }
    expect(result.viewport).toBe('phone')
    expect(result.rest.dom.total).toBe(1200)
    expect(result.rest.fiber.fibers).toBe(100)
    expect(result.rest.metrics.jsHeapUsedMb).toBe(10)
    expect(result.workspace).toBeNull()
    // The hook shim went in before navigation — the only order in which React can find it.
    expect(calls.indexOf('Page.addScriptToEvaluateOnNewDocument')).toBeLessThan(calls.indexOf('Page.navigate'))
    // And the report renders it without throwing.
    expect(renderReport(result as never)).toContain('phone 390x844 at rest')
  }, 20_000)

  it('walks the gesture branch too: a pan, a zoom, an idle window and the board opened and closed', async () => {
    const { page, calls } = fakePage({ panePoint: { x: 100, y: 200 } })
    const result = (await measureCompanion(
      { port: 0 },
      {
        viewport: 'desktop',
        size: { width: 1440, height: 900, mobile: false },
        url: 'http://127.0.0.1:1/#pair=nothing',
        apiPort: 1,
        token: 'nothing',
        frames: 2,
        gestures: true,
        serve: null,
        served: null,
        settleMs: 0
      },
      () => Promise.resolve(page)
    )) as {
      idle: { frames: number }
      pan: { frames: number; commits: number }
      zoom: { frames: number }
      board: { open: { dom: { total: number } }; closed: { dom: { total: number } } } | undefined
    }
    // Out and back: 2 frames each way.
    expect(result.pan.frames).toBe(4)
    expect(result.zoom.frames).toBe(4)
    expect(result.idle.frames).toBeGreaterThan(0)
    expect(result.board?.open.dom.total).toBe(1200)
    expect(result.board?.closed.dom.total).toBe(1200)
    // Real input went through CDP, and the board was collected before it was measured closed.
    expect(calls.filter((c) => c === 'Input.dispatchMouseEvent').length).toBeGreaterThanOrEqual(10)
    expect(calls).toContain('HeapProfiler.collectGarbage')
    expect(renderReport(result as never)).toContain('board closed (after GC)')
  }, 30_000)

  it('recordFrames reads the census the shim returns, cards and keyed renders included', async () => {
    const { page } = fakePage()
    const frames = await recordFrames(page, () => Promise.resolve(4))
    expect(frames).toEqual({ frames: 4, commits: 0, commitsPerFrame: 0, renders: {}, cards: [], keyed: {}, keyedCount: 0 })
  })

  // A count, not a set: forty agents on each of sixty frames is 2,400 renders,
  // and the distinct-key count (40) is what once let that regression pass.
  it('keyedRenders counts every render of a keyed instance, whatever its name', () => {
    expect(keyedRenders({ keyedCount: 2400 })).toBe(2400)
    expect(keyedRenders({ keyedCount: 0 })).toBe(0)
    expect(keyedRenders(null)).toBe(0)
  })
})

// A test's Chrome started from an agent pane is charged to Cookrew, and macOS
// pops "Cookrew was prevented from modifying apps" (2026-11-16).
describe('the probe Chrome answers to macOS for itself', () => {
  it('goes through the launcher, Chrome first', () => {
    expect(chromeCommand('/c/Chrome', ['--headless=new'], '/r/cr-disclaim')).toEqual({
      command: '/r/cr-disclaim',
      args: ['/c/Chrome', '--headless=new']
    })
  })

  it('spawns Chrome itself without one', () => {
    expect(chromeCommand('/c/Chrome', ['about:blank'], null)).toEqual({ command: '/c/Chrome', args: ['about:blank'] })
  })
})
