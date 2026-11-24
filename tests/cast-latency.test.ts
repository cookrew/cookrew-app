import http from 'node:http'
import { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_ACK_MIN_MS, BRIDGE_UP_IN_FLIGHT, BridgeWebSocket, videoAckOf, type BridgeBody, type BridgeStream } from '../src/renderer/src/path/bridge-socket'
import { createSocketBridge } from '../src/main/socket-bridge'
import type { LoopbackSocket, LoopbackSocketDeps } from '../src/main/ws-client'
import { CastStatsMeter } from '../src/renderer/src/cast-stats-meter'
import { sanitizeCastStats } from '../src/shared/cast-stats'
import { PRESS_MARK_MS, pressMark, pressMoved } from '../src/renderer/src/press-mark'

/**
 * 0.6.36: what was between a finger and the picture on the relay (phone stats,
 * 11-24: the Mac sent 1.2 frames a second on a line with room for ten).
 */

class FakeStream implements BridgeStream {
  readyState = 1
  private readonly listeners = new Map<string, ((e: Event) => void)[]>()
  addEventListener(type: string, listener: (e: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  close(): void {}
  emit(type: string, data?: unknown): void {
    const event = new MessageEvent(type, { data: data === undefined ? undefined : JSON.stringify(data) })
    for (const l of this.listeners.get(type) ?? []) l(event)
  }
}

/** A bridged socket whose POSTs answer only when the test says; `acks`: the Mac's hello says it reads `v`. */
function bridgeSocket(acks = true) {
  const posts: { body: BridgeBody; answer: (a: 'ok') => void }[] = []
  const stream = new FakeStream()
  const ws = new BridgeWebSocket({
    stream: () => stream,
    post: (_id, body) => new Promise((resolve) => void posts.push({ body, answer: resolve }))
  })
  stream.emit('id', acks ? { id: 'S', v: 2, acks: true } : { id: 'S', v: 2 })
  return { ws, posts }
}

describe('an H.264 acknowledgement does not wait behind input on the relay', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('rides apart, as `v`, and never as a queued message', async () => {
    const { ws, posts } = bridgeSocket()
    ws.send(JSON.stringify({ t: 'vack', n: 3 }))
    ws.send(JSON.stringify({ t: 'vack', n: 5 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual({ v: 5 })
  })

  it('goes even when every POST is busy with input', async () => {
    const { ws, posts } = bridgeSocket()
    for (let i = 0; i < BRIDGE_UP_IN_FLIGHT; i++) {
      ws.send(JSON.stringify({ t: 'down', x: i, y: i, revision: 1, frameSeq: 1 }))
      ws.send(JSON.stringify({ t: 'up', x: i, y: i, revision: 1, frameSeq: 1 }))
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(posts).toHaveLength(BRIDGE_UP_IN_FLIGHT)
    ws.send(JSON.stringify({ t: 'vack', n: 9 }))
    await vi.advanceTimersByTimeAsync(0)
    // One more POST, carrying only the acknowledgement.
    expect(posts).toHaveLength(BRIDGE_UP_IN_FLIGHT + 1)
    expect(posts.at(-1)?.body).toEqual({ v: 9 })
    // And only one such at a time.
    ws.send(JSON.stringify({ t: 'vack', n: 10 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(posts).toHaveLength(BRIDGE_UP_IN_FLIGHT + 1)
    posts.at(-1)?.answer('ok')
    // The newest one stands for it, but no sooner than the acknowledgement gap.
    await vi.advanceTimersByTimeAsync(BRIDGE_ACK_MIN_MS)
    expect(posts.at(-1)?.body).toEqual({ v: 10 })
  })

  it('says the newest once per gap, however many chunks arrive', async () => {
    const { ws, posts } = bridgeSocket()
    for (const n of [1, 2, 3, 4, 5, 6]) ws.send(JSON.stringify({ t: 'vack', n }))
    await vi.advanceTimersByTimeAsync(0)
    // At most one POST leaves, and it carries the newest number, not each one.
    expect(posts.length).toBeLessThanOrEqual(1)
    for (const post of posts) post.answer('ok')
    const before = posts.length
    for (const n of [7, 8, 9]) ws.send(JSON.stringify({ t: 'vack', n }))
    await vi.advanceTimersByTimeAsync(0)
    // Within the gap: nothing more goes up.
    expect(posts).toHaveLength(before)
    await vi.advanceTimersByTimeAsync(BRIDGE_ACK_MIN_MS)
    expect(posts.at(-1)?.body).toEqual({ v: 9 })
    expect(posts.length).toBeLessThanOrEqual(before + 1)
  })

  it('to a Mac that never said it reads `v`, goes as the message it always was', async () => {
    const { ws, posts } = bridgeSocket(false)
    ws.send(JSON.stringify({ t: 'vack', n: 3 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual({ s: 1, m: ['{"t":"vack","n":3}'] })
  })

  it('this Mac says it reads `v`, in every hello', () => {
    let deps!: LoopbackSocketDeps
    const upstream = { send: () => undefined, close: () => undefined, pause: () => undefined, resume: () => undefined } as unknown as LoopbackSocket
    const bridge = createSocketBridge({ dial: (d) => ((deps = d), upstream) })
    const line = fakeResponse()
    bridge.open('/api/browser/b1/stream', line.response, 'tok', { v: 2 })
    deps.onOpen()
    expect(JSON.parse(line.events().find((e) => e.event === 'id')?.data ?? '{}')).toMatchObject({ v: 2, acks: true })
  })

  it('reads only acknowledgements', () => {
    expect(videoAckOf('{"t":"vack","n":4}')).toBe(4)
    expect(videoAckOf('{"t":"vack","n":-1}')).toBeNull()
    expect(videoAckOf('{"t":"vkey"}')).toBeNull()
    expect(videoAckOf('{"t":"move","x":1}')).toBeNull()
  })
})

/** A response whose writes are read back as server-sent events. */
function fakeResponse(): { response: http.ServerResponse; events: () => { event: string; data: string }[] } {
  const request = new http.IncomingMessage(new Socket())
  request.headers['accept-encoding'] = 'identity'
  const response = new http.ServerResponse(request)
  let text = ''
  response.write = ((piece: string) => {
    text += String(piece)
    return true
  }) as typeof response.write
  response.writeHead = (() => response) as unknown as typeof response.writeHead
  response.end = (() => response) as unknown as typeof response.end
  return { response, events: () => [...text.matchAll(/event: (\S+)\ndata: (.*)\n\n/g)].map((m) => ({ event: m[1], data: m[2] })) }
}

describe('the Mac hands the acknowledgement to the viewer first', () => {
  it('as a `vack` on the socket, ahead of the messages in the same POST', () => {
    let deps!: LoopbackSocketDeps
    const sent: string[] = []
    const upstream = { send: (t: string) => void sent.push(t), close: () => undefined, pause: () => undefined, resume: () => undefined } as unknown as LoopbackSocket
    const bridge = createSocketBridge({ dial: (d) => ((deps = d), upstream) })
    const line = fakeResponse()
    bridge.open('/api/browser/b1/stream', line.response, 'tok', { v: 2 })
    deps.onOpen()
    const id = (JSON.parse(line.events().find((e) => e.event === 'id')?.data ?? '{}') as { id: string }).id
    expect(bridge.post(id, { s: 1, m: ['{"t":"move","x":1,"y":1}'], v: 7 }, 'tok')).toBe(true)
    expect(sent).toEqual(['{"t":"vack","n":7}', '{"t":"move","x":1,"y":1}'])
    // Someone else's token moves nothing.
    expect(bridge.post(id, { v: 8 }, 'other')).toBe(false)
    expect(sent).toHaveLength(2)
  })
})

describe('the phone splits an H.264 picture’s wait in two', () => {
  it('arrival to decoded, then decoded to painted', () => {
    const meter = new CastStatsMeter(0)
    meter.frame(1, 1000, 100)
    meter.decoded(1, 400)
    meter.paint(1, 420)
    const report = meter.report(5000, 'relay', 3, 2, 'h264')
    expect(report).toMatchObject({ decodeP50: 300, paintP50: 20 })
    // A JPEG frame has no decode step: its paint is the whole wait.
    meter.frame(2, 1000, 5100)
    meter.paint(2, 5150)
    expect(meter.report(10_000, 'ws', 3, 2)).toMatchObject({ decodeP50: 0, paintP50: 50 })
  })

  it('the Mac keeps the split, and takes a report from an older phone without it', () => {
    const base = { t: 'stats', line: 'relay', windowMs: 5000, frames: 1, painted: 1, kbps: 1, frameKB: 1, paintP50: 1, paintP95: 1, inputP50: 0, inputP95: 0, inputs: 0, dpr: 3, scale: 2 }
    expect(sanitizeCastStats({ ...base, decodeP50: 300, decodeP95: 900 })).toMatchObject({ decodeP50: 300, decodeP95: 900 })
    expect(sanitizeCastStats(base)).toMatchObject({ decodeP50: 0, decodeP95: 0 })
    expect(sanitizeCastStats({ ...base, decodeP50: -5 })).toMatchObject({ decodeP50: 0 })
  })
})

describe('a POST carrying only an H.264 acknowledgement', () => {
  it('is taken, where an empty one is refused', async () => {
    const http = await import('node:http')
    const { handleMobileApi } = await import('../src/main/mobile-api')
    const posts: unknown[] = []
    const deps = {
      pairingToken: 'PAIR',
      store: { focusedState: { nodes: [], connections: [] } },
      ptys: { get: () => undefined },
      turns: { list: () => [], seen: () => undefined },
      agents: { list: () => [] },
      ops: {},
      presets: [],
      socketBridge: { post: (_id: string, up: unknown) => (posts.push(up), true) }
    } as never
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (handled) return
        response.writeHead(404)
        response.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const post = (body: unknown): Promise<number> =>
      new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port, path: `/api/socket-bridge/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`, method: 'POST', headers: { authorization: 'Bearer PAIR', 'content-type': 'application/json' } }, (response) => {
          response.resume()
          response.on('end', () => resolve(response.statusCode ?? 0))
        })
        request.on('error', reject)
        request.end(JSON.stringify(body))
      })
    try {
      expect(await post({ v: 7 })).toBe(204)
      expect(posts).toEqual([{ m: [], s: undefined, a: undefined, v: 7, end: false }])
      expect(await post({})).toBe(400)
      expect(await post({ v: -1 })).toBe(400)
      expect(posts).toHaveLength(1)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('a press is shown under the finger at once', () => {
  afterEach(() => void vi.useRealTimers())

  it('draws a ring where the finger landed, and takes it away when done', () => {
    vi.useFakeTimers()
    const children: { className: string; style: Record<string, string>; removed: boolean; attrs: Record<string, string> }[] = []
    const box = {
      getBoundingClientRect: () => ({ left: 10, top: 20 }),
      ownerDocument: {
        createElement: () => {
          const el = {
            className: '',
            style: {} as Record<string, string>,
            removed: false,
            attrs: {} as Record<string, string>,
            setAttribute(name: string, value: string) {
              this.attrs[name] = value
            },
            remove() {
              this.removed = true
            }
          }
          return el
        }
      },
      appendChild: (el: (typeof children)[number]) => void children.push(el)
    } as unknown as HTMLElement
    pressMark(box, 110, 220)
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({ className: 'cr-press', style: { left: '100px', top: '200px' }, attrs: { 'aria-hidden': 'true' } })
    vi.advanceTimersByTime(PRESS_MARK_MS + 60)
    expect(children[0].removed).toBe(true)
  })

  it('is taken away at once when the finger goes on to scroll', () => {
    vi.useFakeTimers()
    const children: { removed: boolean; remove(): void }[] = []
    const box = {
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      ownerDocument: {
        createElement: () => {
          const el = { className: '', style: {}, attrs: {}, removed: false, setAttribute() {}, remove() { this.removed = true } }
          return el
        }
      },
      appendChild: (el: (typeof children)[number]) => void children.push(el)
    } as unknown as HTMLElement
    const mark = pressMark(box, 50, 50)
    expect(pressMoved(mark, 54, 53, 12)).toBe(false)
    expect(pressMoved(mark, 70, 50, 12)).toBe(true)
    mark.cancel()
    expect(children[0].removed).toBe(true)
    // Its own timer finds nothing more to do.
    vi.advanceTimersByTime(PRESS_MARK_MS + 60)
    expect(children).toHaveLength(1)
  })
})
