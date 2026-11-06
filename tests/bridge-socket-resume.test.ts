import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_RESUME_BUDGET_MS,
  BRIDGE_SILENT_MS,
  BRIDGE_UP_IN_FLIGHT,
  BridgeWebSocket,
  type BridgeBody,
  type BridgeResume,
  type BridgeStream
} from '../src/renderer/src/path/bridge-socket'

class FakeStream implements BridgeStream {
  readyState = 1
  closed = false
  private readonly listeners = new Map<string, ((e: Event) => void)[]>()
  addEventListener(type: string, listener: (e: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  close(): void {
    this.closed = true
  }
  emit(type: string, data?: unknown): void {
    const event = new MessageEvent(type, { data: data === undefined ? undefined : JSON.stringify(data) })
    for (const l of this.listeners.get(type) ?? []) l(event)
  }
}

function setup(post?: (id: string, body: BridgeBody) => Promise<'ok' | 'gone'>) {
  const streams: FakeStream[] = []
  const asked: (BridgeResume | undefined)[] = []
  const posts: BridgeBody[] = []
  let nudge: () => void = () => undefined
  const ws = new BridgeWebSocket({
    stream: (resume) => {
      asked.push(resume)
      const s = new FakeStream()
      streams.push(s)
      return s
    },
    post: (id, body) => {
      posts.push(body)
      return post ? post(id, body) : Promise.resolve('ok')
    },
    watch: (fn) => {
      nudge = fn
      return () => undefined
    }
  })
  const seen: string[] = []
  ws.onopen = () => void seen.push('open')
  ws.onmessage = (e) => void seen.push(String(e.data))
  ws.onclose = () => void seen.push('close')
  const resuming: boolean[] = []
  ws.onresuming = (on) => void resuming.push(on)
  streams[0].emit('id', { id: 'S', v: 2 })
  return { ws, streams, asked, posts, seen, resuming, nudge: () => nudge() }
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

describe('a dropped stream is a pause, not an ending', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('comes back to the same session, from the last message it saw', async () => {
    const { ws, streams, asked, seen, resuming } = setup()
    streams[0].emit('c', [1, '{"t":"control"}'])
    streams[0].emit('c', [2, '{"t":"status"}'])
    streams[0].emit('error')
    await flush()
    expect(ws.readyState).toBe(BridgeWebSocket.OPEN)
    expect(streams[0].closed).toBe(true)
    expect(asked[1]).toEqual({ id: 'S', after: 2 })
    expect(resuming).toEqual([true])
    streams[1].emit('id', { id: 'S', v: 2 })
    expect(resuming).toEqual([true, false])
    expect(seen.filter((s) => s === 'close')).toEqual([])
    expect(seen.filter((s) => s === 'open')).toEqual(['open'])
  })

  it('drops a control message it already has', () => {
    const { streams, seen } = setup()
    streams[0].emit('c', [1, 'one'])
    streams[0].emit('c', [1, 'one'])
    streams[0].emit('c', [2, 'two'])
    expect(seen).toEqual(['open', 'one', 'two'])
  })

  it('keeps what was typed through the drop and sends it after', async () => {
    const { ws, streams, posts } = setup(undefined)
    streams[0].emit('error')
    ws.send('{"t":"key","key":"a"}')
    await flush()
    expect(posts.flatMap((p) => p.m ?? [])).toContain('{"t":"key","key":"a"}')
  })

  it('retries a POST the network ate, with the same numbers', async () => {
    let fails = 1
    const { ws, posts } = setup(async () => {
      if (fails-- > 0) throw new Error('offline')
      return 'ok'
    })
    ws.send('{"t":"key","key":"a"}')
    await flush()
    await vi.advanceTimersByTimeAsync(2000)
    const tries = posts.filter((p) => p.m?.length)
    expect(tries.length).toBeGreaterThanOrEqual(2)
    expect(tries[0].s).toBe(tries[1].s)
    expect(tries[1].m).toEqual(tries[0].m)
  })

  it('a POST that fails is proof the path died: the stream is not left to find out', async () => {
    const { ws, streams, asked } = setup(async (_id, body) => {
      if (body.m?.length) throw new Error('offline')
      return 'ok'
    })
    ws.send('{"t":"key","key":"a"}')
    await flush()
    await vi.advanceTimersByTimeAsync(10)
    expect(streams[0].closed).toBe(true)
    expect(asked.length).toBe(2)
  })

  it('a POST that failed on the old line does not knock the new one down', async () => {
    let fail: (reason: Error) => void = () => undefined
    const { ws, streams, asked } = setup((_id, body) => (body.m?.length ? new Promise((_, reject) => (fail = reject)) : Promise.resolve('ok')))
    ws.send('{"t":"key","key":"a"}')
    streams[0].emit('error')
    await flush()
    await vi.advanceTimersByTimeAsync(5)
    streams[1].emit('id', { id: 'S', v: 2 })
    await vi.advanceTimersByTimeAsync(5)
    fail(new Error('the old connection'))
    await flush()
    expect(streams[1].closed).toBe(false)
    expect(asked).toHaveLength(2)
  })

  it('ends at once when the Mac has forgotten the session, so the card redials', async () => {
    const { streams, seen } = setup(async () => 'gone')
    streams[0].emit('error')
    await flush()
    await vi.advanceTimersByTimeAsync(50)
    expect(seen).toContain('close')
  })

  it('gives up after its budget and hands back to the card', async () => {
    const { streams, seen } = setup()
    streams[0].emit('error')
    await vi.advanceTimersByTimeAsync(BRIDGE_RESUME_BUDGET_MS + 3000)
    expect(seen).toContain('close')
    expect(streams.length).toBeGreaterThan(2)
  })

  it('notices a silent line by itself, and a network change at once', async () => {
    const quiet = setup()
    await vi.advanceTimersByTimeAsync(BRIDGE_SILENT_MS + 1500)
    expect(quiet.streams[0].closed).toBe(true)

    const moved = setup()
    await vi.advanceTimersByTimeAsync(1700)
    moved.nudge()
    expect(moved.streams[0].closed).toBe(true)
  })

  it('leaves a healthy line alone when told the network changed', () => {
    const { streams, nudge } = setup()
    streams[0].emit('hb')
    nudge()
    expect(streams[0].closed).toBe(false)
  })
})

describe('input on a slow line', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('keeps two POSTs in flight, numbered, and folds what waits behind them', async () => {
    const releases: (() => void)[] = []
    const { ws, posts } = setup(() => new Promise((r) => releases.push(() => r('ok'))))
    const move = (x: number): string => JSON.stringify({ t: 'touchmove', x, y: 0 })
    ws.send(move(1))
    ws.send(move(2))
    ws.send(move(3))
    ws.send(move(4))
    await flush()
    expect(posts).toHaveLength(BRIDGE_UP_IN_FLIGHT)
    expect(posts.map((p) => p.s)).toEqual([1, 2])
    releases.shift()?.()
    await flush()
    expect(posts).toHaveLength(3)
    expect(posts[2].s).toBe(3)
    expect(posts[2].m).toEqual([move(4)])
  })

  it('carries the paint receipt on the next POST, or alone', async () => {
    const { ws, posts } = setup()
    ws.painted(7)
    ws.painted(9)
    ws.painted(8)
    await flush()
    expect(posts.at(-1)?.a).toBe(9)
  })

  it('says goodbye on close, with what was left', async () => {
    const { ws, posts } = setup(() => new Promise(() => undefined))
    ws.send('{"t":"release"}')
    ws.close()
    await flush()
    expect(posts.at(-1)?.end).toBe(true)
  })
})

describe('a Mac from before this', () => {
  it('stays on the old terms: one POST, the stream ends the socket', async () => {
    const streams: FakeStream[] = []
    const posts: BridgeBody[] = []
    const ws = new BridgeWebSocket({
      stream: () => {
        const s = new FakeStream()
        streams.push(s)
        return s
      },
      post: async (_id, body) => {
        posts.push(body)
        return 'ok'
      }
    })
    const seen: string[] = []
    ws.onclose = () => void seen.push('close')
    ws.onmessage = (e) => void seen.push(String(e.data))
    streams[0].emit('id', { id: 'S' })
    streams[0].emit('m', 'old')
    ws.send('{"t":"key","key":"a"}')
    await Promise.resolve()
    expect(posts[0]).toEqual({ m: ['{"t":"key","key":"a"}'] })
    streams[0].emit('error')
    expect(seen).toEqual(['old', 'close'])
    expect(streams).toHaveLength(1)
  })
})
