// THE STREAM'S HTTP TRANSPORT, AND THE OPEN FALLBACK (one-stream T3).
//
// The five routes, and the one distinction that matters throughout: an ABSENT
// ROUTE IS NOT AN EMPTY HISTORY. A 404 comes back as its own type so a caller
// can tell "this build does not serve that" from "this agent has nothing" —
// the confusion that made 400 checkpoints look destroyed when they were
// merely unindexed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls: { url: string; init?: RequestInit }[] = []
let answer: (url: string) => { status: number; body: unknown }

vi.mock('../src/renderer/src/plane-fetch', () => ({
  planeFetch: (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const { status, body } = answer(url)
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body))
    } as unknown as Response)
  }
}))

const load = async (): Promise<typeof import('../src/renderer/src/stream/stream-http')> => {
  vi.resetModules()
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    COOKREW_MOBILE: 1,
    location: { origin: 'https://cookrew.dev', search: '', hash: '', href: 'https://cookrew.dev/' },
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined
    },
    sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    history: { replaceState: () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }
  return import('../src/renderer/src/stream/stream-http')
}

const INDEX_ANSWER = {
  checkpoints: [
    {
      identity: 'u1',
      ordinal: 1,
      startedAt: 1,
      endedAt: 2,
      promptHead: 'first',
      compacted: false,
      file: '/s1.jsonl'
    }
  ],
  missing: [{ sessionId: 's0', file: '/gone.jsonl', reason: 'no-transcript' }],
  orphanMarks: ['u-unknown', 'u-other'],
  source: 'file'
}

beforeEach(() => {
  calls.length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('open — one round trip when the server has the route', () => {
  it('asks /stream/open and returns it verbatim', async () => {
    answer = () => ({
      status: 200,
      body: {
        index: INDEX_ANSWER.checkpoints,
        tail: null,
        backwardsCursor: 'u0',
        source: 'file',
        anomalies: { Gap: 1 },
        rolledBack: [{ fromOrdinal: 4, at: 9 }]
      }
    })
    const { createHttpStreamTransport } = await load()
    const open = await createHttpStreamTransport().open('t1')
    expect(calls.map((c) => c.url)).toEqual(['/api/terminal/t1/stream/open'])
    expect(open.backwardsCursor).toBe('u0')
    expect(open.anomalies).toEqual({ Gap: 1 })
    expect(open.rolledBack).toEqual([{ fromOrdinal: 4, at: 9 }])
  })
})

describe('an absent route is not an empty history', () => {
  it('a 404 comes back as its own type, never as a card with no checkpoints', async () => {
    answer = () => ({ status: 404, body: { error: 'no such terminal' } })
    const { createHttpStreamTransport, StreamRouteAbsent } = await load()
    await expect(createHttpStreamTransport().open('t1')).rejects.toBeInstanceOf(StreamRouteAbsent)
  })

  it('a 500 is a failure and says what it was', async () => {
    answer = () => ({ status: 500, body: { error: 'the reader fell over' } })
    const { createHttpStreamTransport } = await load()
    await expect(createHttpStreamTransport().open('t1')).rejects.toThrow('the reader fell over')
  })
})

describe('the block window always carries a cursor', () => {
  beforeEach(() => {
    answer = () => ({ status: 200, body: { blocks: [], total: 0 } })
  })

  it('sends a limit even with no anchor — a bare GET /stream is the PTY mirror', async () => {
    const { createHttpStreamTransport } = await load()
    await createHttpStreamTransport().blocks('t1', {})
    expect(calls[0].url).toBe('/api/terminal/t1/stream?limit=20')
  })

  it('names the window by an identity at one end, never by an offset', async () => {
    const { createHttpStreamTransport } = await load()
    await createHttpStreamTransport().blocks('t1', { after: 'u7', limit: 5 })
    expect(calls[0].url).toBe('/api/terminal/t1/stream?after=u7&limit=5')
  })
})

describe('the tail alone, for a card preview or a board row', () => {
  it('takes the tail out of /stream/open, with its own mark', async () => {
    answer = () => ({
      status: 200,
      body: {
        index: [{ ...INDEX_ANSWER.checkpoints[0], marks: { title: 'fixed the seam' } }],
        tail: {
          block: { id: 'u1', index: 1, ordinal: 1, prompt: 'p', reply: 'r', activity: [] },
          final: true,
          ordinal: 1,
          total: 1
        },
        backwardsCursor: null,
        source: 'file',
        anomalies: {},
        rolledBack: []
      }
    })
    const { createHttpStreamTransport } = await load()
    const tail = await createHttpStreamTransport().tail('t1')
    expect(tail?.block?.reply).toBe('r')
    expect(tail?.marks?.title).toBe('fixed the seam')
  })

  it('a card with no turn yet is null, not an empty preview', async () => {
    answer = () => ({
      status: 200,
      body: {
        index: [],
        tail: null,
        backwardsCursor: null,
        source: 'file',
        anomalies: {},
        rolledBack: []
      }
    })
    const { createHttpStreamTransport } = await load()
    expect(await createHttpStreamTransport().tail('t1')).toBeNull()
  })
})

describe('a mark is the only write', () => {
  it('PUTs the patch to /stream/marks', async () => {
    answer = () => ({ status: 200, body: { ok: true } })
    const { createHttpStreamTransport } = await load()
    await createHttpStreamTransport().mark('t1', { identity: 'u3', title: 'fixed the seam' })
    expect(calls[0].url).toBe('/api/terminal/t1/stream/marks')
    expect(calls[0].init?.method).toBe('PUT')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      identity: 'u3',
      title: 'fixed the seam'
    })
  })
})
