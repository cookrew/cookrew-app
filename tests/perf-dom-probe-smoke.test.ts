import { describe, expect, it } from 'vitest'
import {
  CENSUS,
  FIBER_CENSUS,
  PANE_POINT,
  measureCompanion,
  recordFrames,
  renderReport,
  type CdpPage
} from '../scripts/perf-dom-probe.mjs'

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

  it('recordFrames reads the census the shim returns, cards included', async () => {
    const { page } = fakePage()
    const frames = await recordFrames(page, () => Promise.resolve(4))
    expect(frames).toEqual({ frames: 4, commits: 0, commitsPerFrame: 0, renders: {}, cards: [] })
  })
})
