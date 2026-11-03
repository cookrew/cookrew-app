import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FramePainter, frameBlob, type PaintedFrame } from '../src/renderer/src/frame-painter'

/**
 * THE LIVE VIEW IS DRAWN, NOT RE-RENDERED: decoded off the main thread,
 * drawn to a canvas, newest frame wins, every frame accounted for (painted or
 * skipped) so the desktop's port can send the next.
 */

describe('frameBlob', () => {
  it('bytes become a JPEG blob as they are', async () => {
    const blob = frameBlob({ bytes: new Uint8Array([0xff, 0xd8, 1]) })
    expect(blob?.type).toBe('image/jpeg')
    expect(new Uint8Array(await (blob as Blob).arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 1]))
  })
  it('a data: URL is decoded once into a blob of its own type', async () => {
    const blob = frameBlob({ src: `data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString('base64')}` })
    expect(blob?.type).toBe('image/jpeg')
    expect(blob?.size).toBe(3)
  })
  it('neither, or junk, is null', () => {
    expect(frameBlob({})).toBeNull()
    expect(frameBlob({ src: 'blob:x' })).toBeNull()
    expect(frameBlob({ bytes: new Uint8Array(0) })).toBeNull()
  })
})

interface Deferred {
  resolve: (bitmap: { width: number; height: number; close: () => void }) => void
  reject: (error: Error) => void
}

describe('FramePainter', () => {
  let decodes: Deferred[]
  let drawn: number[]
  let closed: number
  let canvas: { width: number; height: number; getContext: () => unknown }

  beforeEach(() => {
    decodes = []
    drawn = []
    closed = 0
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(
        () =>
          new Promise((resolve, reject) => {
            decodes.push({ resolve, reject } as Deferred)
          })
      )
    )
    canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (picture: { width: number }) => drawn.push(picture.width)
      })
    }
  })
  afterEach(() => vi.unstubAllGlobals())

  const bitmap = (width: number) => ({ width, height: 10, close: () => void (closed += 1) })
  const frame = (seq: number) => ({ seq, revision: 1, bytes: new Uint8Array([0xff, seq]) })
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  }

  function painter() {
    const painted: PaintedFrame[] = []
    const skipped: number[] = []
    const instance = new FramePainter(canvas as unknown as HTMLCanvasElement, {
      onPainted: (painted_) => painted.push(painted_),
      onSkipped: (seq) => skipped.push(seq)
    })
    return { instance, painted, skipped }
  }

  it('decodes, sizes the canvas to the frame, draws it, frees the bitmap, and reports it', async () => {
    const { instance, painted } = painter()
    instance.push(frame(1))
    decodes[0].resolve(bitmap(640))
    await flush()
    expect(canvas.width).toBe(640)
    expect(drawn).toEqual([640])
    expect(closed).toBe(1)
    expect(painted).toMatchObject([{ seq: 1, width: 640, height: 10 }])
    expect(painted[0].blob).toBeInstanceOf(Blob)
  })

  it('one decode at a time: frames that arrive meanwhile are skipped to the newest', async () => {
    const { instance, painted, skipped } = painter()
    instance.push(frame(1))
    instance.push(frame(2))
    instance.push(frame(3))
    instance.push(frame(4))
    expect(decodes).toHaveLength(1)
    expect(skipped).toEqual([2, 3])
    decodes[0].resolve(bitmap(100))
    await flush()
    expect(decodes).toHaveLength(2)
    decodes[1].resolve(bitmap(100))
    await flush()
    expect(painted.map((p) => p.seq)).toEqual([1, 4])
  })

  it('an undecodable frame is skipped (accounted for), and the next still paints', async () => {
    const { instance, painted, skipped } = painter()
    instance.push(frame(1))
    instance.push(frame(2))
    decodes[0].reject(new Error('bad jpeg'))
    await flush()
    expect(skipped).toEqual([1])
    decodes[1].resolve(bitmap(50))
    await flush()
    expect(painted.map((p) => p.seq)).toEqual([2])
  })

  it('after dispose nothing is drawn, and what was waiting is accounted for', async () => {
    const { instance, painted, skipped } = painter()
    instance.push(frame(1))
    instance.push(frame(2))
    instance.dispose()
    expect(skipped).toEqual([2])
    decodes[0].resolve(bitmap(100))
    await flush()
    expect(drawn).toEqual([])
    expect(closed).toBe(1)
    expect(painted).toEqual([])
    expect(skipped).toEqual([2, 1])
    instance.push(frame(3))
    expect(skipped).toEqual([2, 1, 3])
  })

  it('the canvas is resized (which clears it) only when the frame size changes', async () => {
    const { instance } = painter()
    let resizes = 0
    let width = 0
    Object.defineProperty(canvas, 'width', {
      get: () => width,
      set: (value: number) => {
        resizes += 1
        width = value
      }
    })
    for (const seq of [1, 2, 3]) {
      instance.push(frame(seq))
      decodes.at(-1)?.resolve(bitmap(seq === 3 ? 200 : 100))
      await flush()
    }
    expect(resizes).toBe(2)
  })
})
