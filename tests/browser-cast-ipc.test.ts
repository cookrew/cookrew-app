import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createBrowserCastIpc,
  IPC_FRAMES_IN_FLIGHT,
  IPC_RECEIPT_TIMEOUT_MS,
  type CastPort
} from '../src/main/browser-cast-ipc'
import { foldPinch, PINCH_STEP_TIMEOUT_MS } from '../src/main/cast-viewer'
import type { BrowserInstance } from '../src/main/browser-instance'
import type { FrameMeta } from '../src/main/headless-chrome'

/**
 * THE DESKTOP DRAWS ITS OWN CHROME DIRECTLY.
 *
 * The Electron renderer used to watch its card's headless Chrome through the
 * companion server: a WebSocket to 127.0.0.1:8639, base64 JPEG in JSON, a
 * token in the URL. Now main hands it a MessagePort and the frames go over it
 * as JPEG bytes, paced by the renderer's "painted" receipts. The same viewer
 * core as a phone's socket — viewport arbitration, the closed input vocabulary
 * — so these pin only what the port changes.
 */

/** Minimal JPEG header with a real SOF0 width/height for display-scale tests. */
function jpegFrame(width: number, height: number): string {
  const sof = Buffer.alloc(10)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(8, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof]).toString('base64')
}

interface FakePort extends CastPort {
  posted: Array<Record<string, unknown>>
  closed: boolean
  started: boolean
  deliver: (data: unknown) => void
  hangUp: () => void
}

function fakePort(): FakePort {
  const listeners = new Map<string, Array<(event?: { data: unknown }) => void>>()
  const port: FakePort = {
    posted: [],
    closed: false,
    started: false,
    postMessage: (message: unknown) => {
      port.posted.push(message as Record<string, unknown>)
    },
    on: ((event: string, listener: (event?: { data: unknown }) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return port
    }) as CastPort['on'],
    start: () => {
      port.started = true
    },
    close: () => {
      port.closed = true
    },
    deliver: (data) => {
      for (const listener of listeners.get('message') ?? []) listener({ data })
    },
    hangUp: () => {
      for (const listener of listeners.get('close') ?? []) listener()
    }
  }
  return port
}

function fakeInstance(): BrowserInstance & { emit: (data: string, meta: FrameMeta) => void } {
  const frameListeners = new Set<(data: string, meta: FrameMeta) => void>()
  const viewportState = {
    width: 400,
    height: 300,
    mobile: false,
    revision: 1,
    ownerId: null,
    viewerCount: 0,
    agentHeld: false,
    transitioning: false
  }
  const instance = {
    frameListeners,
    copyListeners: new Set(),
    dispatchInput: vi.fn(() => Promise.resolve()),
    viewportState,
    registerViewportViewer: vi.fn(),
    unregisterViewportViewer: vi.fn(),
    offerViewport: vi.fn(),
    claimViewport: vi.fn(() => true),
    releaseViewport: vi.fn(),
    onViewportState: vi.fn(() => vi.fn()),
    emit: (data: string, meta: FrameMeta) => {
      for (const listener of frameListeners) listener(data, meta)
    }
  }
  return instance as unknown as BrowserInstance & { emit: (data: string, meta: FrameMeta) => void }
}

const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const frames = (port: FakePort) => port.posted.filter((message) => message.t === 'frame')

async function opened() {
  const instance = fakeInstance()
  const port = fakePort()
  const ipc = createBrowserCastIpc({ enabled: () => true, getInstance: () => Promise.resolve(instance) })
  ipc.open('card-1', port)
  await settle()
  return { instance, port, ipc }
}

describe('the desktop’s port to a card’s Chrome', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('refuses (closes the port, starts nothing) when the interactive browser is off', () => {
    const port = fakePort()
    const getInstance = vi.fn()
    createBrowserCastIpc({ enabled: () => false, getInstance }).open('card-1', port)
    expect(port.closed).toBe(true)
    expect(getInstance).not.toHaveBeenCalled()
  })

  it('attaches as a viewer and says ready + viewport state, like a socket would', async () => {
    const { instance, port } = await opened()
    expect(port.started).toBe(true)
    expect(instance.registerViewportViewer).toHaveBeenCalledTimes(1)
    expect(port.posted[0]).toMatchObject({ t: 'ready', w: 400, h: 300, revision: 1 })
    expect(port.posted[1]).toMatchObject({ t: 'viewport-state', owner: 'none' })
  })

  it('a frame goes as JPEG BYTES, never base64, with the same mapping meta', async () => {
    const { instance, port } = await opened()
    const jpeg = jpegFrame(800, 600)
    instance.emit(jpeg, { deviceWidth: 400, deviceHeight: 300, pageScaleFactor: 1, revision: 1 })
    const [frame] = frames(port)
    expect(frame.jpeg).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(frame.jpeg as Uint8Array).toString('base64')).toBe(jpeg)
    expect(frame).not.toHaveProperty('data')
    // An 800 px JPEG of a 400 px viewport: 2 frame px per CSS px (a 2x desktop).
    expect(frame.meta).toMatchObject({ displayScale: 2, revision: 1, deviceWidth: 400 })
  })

  it(`keeps ${IPC_FRAMES_IN_FLIGHT} frames in flight, then only the newest waits — a busy renderer skips, never queues`, async () => {
    const { instance, port } = await opened()
    const meta = { deviceWidth: 400, deviceHeight: 300, pageScaleFactor: 1, revision: 1 }
    for (let i = 0; i < 5; i += 1) instance.emit(jpegFrame(400 + i, 300), meta)
    expect(frames(port).map((frame) => frame.seq)).toEqual([1, 2])
    port.deliver({ t: 'painted', seq: 1 })
    // Frames 3 and 4 were superseded while waiting; 5 is what goes.
    expect(frames(port).map((frame) => frame.seq)).toEqual([1, 2, 5])
  })

  it('a receipt that never comes does not stall the card forever', async () => {
    const { instance, port } = await opened()
    const meta = { deviceWidth: 400, deviceHeight: 300, pageScaleFactor: 1, revision: 1 }
    for (let i = 0; i < 3; i += 1) instance.emit(jpegFrame(400 + i, 300), meta)
    expect(frames(port)).toHaveLength(2)
    vi.advanceTimersByTime(IPC_RECEIPT_TIMEOUT_MS + 1)
    expect(frames(port)).toHaveLength(3)
  })

  it('a late or stray receipt never loosens the cap (only a seq on the wire counts)', async () => {
    const { instance, port } = await opened()
    const meta = { deviceWidth: 400, deviceHeight: 300, pageScaleFactor: 1, revision: 1 }
    instance.emit(jpegFrame(400, 300), meta)
    instance.emit(jpegFrame(401, 300), meta)
    // The renderer stalls past the timeout: 1 and 2 are written off, 3 and 4 go.
    instance.emit(jpegFrame(402, 300), meta)
    vi.advanceTimersByTime(IPC_RECEIPT_TIMEOUT_MS + 1)
    instance.emit(jpegFrame(403, 300), meta)
    expect(frames(port).map((frame) => frame.seq)).toEqual([1, 2, 3, 4])
    // The old receipts arrive late, plus junk: none of them frees a slot.
    port.deliver({ t: 'painted', seq: 1 })
    port.deliver({ t: 'painted', seq: 2 })
    port.deliver({ t: 'painted', seq: 99 })
    port.deliver({ t: 'painted' })
    instance.emit(jpegFrame(404, 300), meta)
    expect(frames(port).map((frame) => frame.seq)).toEqual([1, 2, 3, 4])
    port.deliver({ t: 'painted', seq: 3 })
    expect(frames(port).map((frame) => frame.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('a pinch step that never answers does not wedge the next ones', async () => {
    const { instance, port } = await opened()
    vi.mocked(instance.dispatchInput).mockImplementation(() => new Promise<void>(() => undefined))
    instance.emit(jpegFrame(400, 300), { deviceWidth: 400, deviceHeight: 300, pageScaleFactor: 1, revision: 1 })
    port.deliver({ t: 'pinch', x: 10, y: 10, scale: 1.2, revision: 1, frameSeq: 1 })
    port.deliver({ t: 'pinch', x: 10, y: 10, scale: 1.2, revision: 1, frameSeq: 1 })
    expect(instance.dispatchInput).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(PINCH_STEP_TIMEOUT_MS + 1)
    expect(instance.dispatchInput).toHaveBeenCalledTimes(2)
  })

  it('a folded pinch step is dropped if the viewport started changing meanwhile', async () => {
    const { instance, port } = await opened()
    let finish: () => void = () => undefined
    vi.mocked(instance.dispatchInput).mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)))
    instance.emit(jpegFrame(400, 300), { deviceWidth: 400, deviceHeight: 300, pageScaleFactor: 1, revision: 1 })
    port.deliver({ t: 'pinch', x: 10, y: 10, scale: 1.2, revision: 1, frameSeq: 1 })
    port.deliver({ t: 'pinch', x: 10, y: 10, scale: 1.2, revision: 1, frameSeq: 1 })
    ;(instance.viewportState as { transitioning: boolean }).transitioning = true
    finish()
    await settle()
    await settle()
    expect(instance.dispatchInput).toHaveBeenCalledTimes(1)
  })

  it('input over the port goes through the same closed vocabulary, mapped against the painted frame', async () => {
    const { instance, port } = await opened()
    instance.emit(jpegFrame(800, 600), { deviceWidth: 400, deviceHeight: 300, pageScaleFactor: 1, revision: 1 })
    port.deliver({ t: 'move', x: 200, y: 100, buttons: 1, revision: 1, frameSeq: 1 })
    expect(instance.dispatchInput).toHaveBeenLastCalledWith('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: 100, y: 50, button: 'left', buttons: 1
    })
    port.deliver({ t: 'text', text: '你好', revision: 1 })
    expect(instance.dispatchInput).toHaveBeenLastCalledWith('Input.insertText', { text: '你好' })
    // No raw CDP, over the port either.
    const before = vi.mocked(instance.dispatchInput).mock.calls.length
    port.deliver({ method: 'Runtime.evaluate', params: { expression: '1' }, revision: 1 })
    port.deliver({ t: 'evaluate', expression: '1', revision: 1 })
    expect(vi.mocked(instance.dispatchInput).mock.calls.length).toBe(before)
  })

  it('pinch steps run one at a time; those that arrive meanwhile fold into the next', async () => {
    const { instance, port } = await opened()
    let finish: () => void = () => undefined
    vi.mocked(instance.dispatchInput).mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)))
    instance.emit(jpegFrame(400, 300), { deviceWidth: 400, deviceHeight: 300, pageScaleFactor: 1, revision: 1 })
    const step = (scale: number): void => port.deliver({ t: 'pinch', x: 100, y: 100, scale, revision: 1, frameSeq: 1 })
    step(1.1)
    step(1.1)
    step(1.1)
    expect(instance.dispatchInput).toHaveBeenCalledTimes(1)
    finish()
    await settle()
    await settle()
    expect(instance.dispatchInput).toHaveBeenCalledTimes(2)
    const folded = vi.mocked(instance.dispatchInput).mock.calls[1] as unknown as [string, { scaleFactor: number }]
    expect(folded[0]).toBe('Input.synthesizePinchGesture')
    expect(folded[1].scaleFactor).toBeCloseTo(1.21)
  })

  it('a dropped card says goodbye before closing, so the view redials onto the new instance', async () => {
    const { instance, port, ipc } = await opened()
    ipc.drop('card-1')
    expect(port.posted.at(-1)).toEqual({ t: 'bye' })
    expect(port.closed).toBe(true)
    expect(instance.unregisterViewportViewer).toHaveBeenCalledTimes(1)
    expect(ipc.activeCount()).toBe(0)
  })

  it('the renderer hanging up detaches the viewer', async () => {
    const { instance, port, ipc } = await opened()
    port.hangUp()
    expect(instance.unregisterViewportViewer).toHaveBeenCalledTimes(1)
    expect(instance.frameListeners.size).toBe(0)
    expect(ipc.activeCount()).toBe(0)
  })

  it('no instance: an error, then the port closes', async () => {
    const port = fakePort()
    createBrowserCastIpc({ enabled: () => true, getInstance: () => Promise.resolve(null) }).open('gone', port)
    await settle()
    expect(port.posted[0]).toEqual({ t: 'error', msg: 'no headless instance' })
    expect(port.closed).toBe(true)
  })
})

describe('foldPinch', () => {
  const step = (scaleFactor: number, x = 1) => ({
    method: 'Input.synthesizePinchGesture' as const,
    params: { x, y: 1, scaleFactor, gestureSourceType: 'mouse' }
  })
  it('multiplies scales and keeps the newest anchor', () => {
    expect(foldPinch(step(2, 1), step(1.5, 9)).params).toMatchObject({ x: 9, scaleFactor: 3 })
  })
  it('stays inside one step’s bounds', () => {
    expect(foldPinch(step(4), step(4)).params.scaleFactor).toBe(4)
    expect(foldPinch(step(0.25), step(0.25)).params.scaleFactor).toBe(0.25)
  })
})
