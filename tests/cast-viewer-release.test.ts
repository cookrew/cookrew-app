import { describe, expect, it } from 'vitest'
import { CastViewer, type ViewerSink } from '../src/main/cast-viewer'
import type { BrowserInstance } from '../src/main/browser-instance'

function viewer() {
  const commands: { method: string; params: Record<string, unknown> }[] = []
  const frameListeners = new Set<(data: string, meta: Record<string, unknown>) => void>()
  const viewportState = { width: 390, height: 700, mobile: true, revision: 1, transitioning: false, agentHeld: false, owner: 'none' }
  const instance = {
    viewportState,
    frameListeners,
    registerViewportViewer: () => undefined,
    unregisterViewportViewer: () => undefined,
    onViewportState: () => () => undefined,
    dispatchInput: async (method: string, params: Record<string, unknown>) => void commands.push({ method, params })
  } as unknown as BrowserInstance
  const sink: ViewerSink = { sendControl: () => undefined, frameReady: () => true, sendFrame: () => undefined, onceReady: () => undefined, close: () => undefined }
  const cast = new CastViewer(sink, () => undefined, 'b1')
  cast.attach(instance)
  const frame = (): void => {
    for (const listener of frameListeners) listener('QUJD', { deviceWidth: 390, deviceHeight: 700, revision: viewportState.revision, pageScaleFactor: 1 })
  }
  return { cast, commands, frame, viewportState }
}

const kinds = (commands: { method: string; params: Record<string, unknown> }[]): unknown[] => commands.map((c) => c.params.type)

describe('a viewer that leaves lets go', () => {
  it('lifts a finger Chrome still holds', () => {
    const { cast, commands, frame } = viewer()
    frame()
    cast.handleMessage({ t: 'touchstart', x: 10, y: 10, revision: 1, frameSeq: 1 })
    commands.length = 0
    cast.close()
    expect(kinds(commands)).toContain('touchCancel')
  })

  it('releases a mouse held down', () => {
    const { cast, commands, frame } = viewer()
    frame()
    cast.handleMessage({ t: 'down', x: 10, y: 10, revision: 1, frameSeq: 1 })
    commands.length = 0
    cast.close()
    expect(kinds(commands)).toContain('mouseReleased')
  })

  it('has nothing to do after a clean lift', () => {
    const { cast, commands, frame } = viewer()
    frame()
    cast.handleMessage({ t: 'touchstart', x: 10, y: 10, revision: 1, frameSeq: 1 })
    cast.handleMessage({ t: 'touchend', x: 10, y: 10, revision: 1, frameSeq: 1 })
    commands.length = 0
    cast.close()
    expect(commands).toEqual([])
  })
})

describe('a release is cleanup, whatever happened to the page since', () => {
  it('lands with no remembered frame', () => {
    const { cast, commands, frame } = viewer()
    frame()
    cast.handleMessage({ t: 'down', x: 10, y: 10, revision: 1, frameSeq: 1 })
    commands.length = 0
    cast.handleMessage({ t: 'up', x: 10, y: 10, revision: 1, frameSeq: 9999 })
    expect(kinds(commands)).toContain('mouseReleased')
  })

  it('lands on an older revision', () => {
    const { cast, commands, frame, viewportState } = viewer()
    frame()
    cast.handleMessage({ t: 'touchstart', x: 10, y: 10, revision: 1, frameSeq: 1 })
    viewportState.revision = 2
    commands.length = 0
    cast.handleMessage({ t: 'touchend', revision: 1 })
    expect(kinds(commands)).toContain('touchEnd')
  })

  it('a press on an old frame still does not', () => {
    const { cast, commands, frame } = viewer()
    frame()
    commands.length = 0
    cast.handleMessage({ t: 'down', x: 10, y: 10, revision: 1, frameSeq: 9999 })
    expect(commands).toEqual([])
  })
})
