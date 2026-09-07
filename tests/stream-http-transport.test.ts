// THE STREAM'S HTTP TRANSPORT, AND THE OPEN FALLBACK (one-stream T3).
//
// T2.5 is landing `/stream/open` in parallel with this phase, so the hook has
// to work against a server that has it AND against one that does not. The
// fallback is a single branch and it is tested as one, because the thing it
// prevents — a rail that renders nothing on a dev build and reads as "this
// agent has no history" — is precisely the confusion this whole design exists
// to remove.
//
// The fallback is also a SEPARATE COMMIT on this branch. When T2.5 lands, the
// branch's last commit deletes it and this describe block goes with it.

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

describe('open — the fallback for a server that predates T2.5', () => {
  beforeEach(() => {
    answer = (url) =>
      url.endsWith('/stream/open')
        ? { status: 404, body: { error: 'not found' } }
        : { status: 200, body: INDEX_ANSWER }
  })

  it('falls back to the full /stream/index rather than showing an empty rail', async () => {
    const { createHttpStreamTransport } = await load()
    const open = await createHttpStreamTransport().open('t1')
    expect(calls.map((c) => c.url)).toEqual([
      '/api/terminal/t1/stream/open',
      '/api/terminal/t1/stream/index'
    ])
    expect(open.index.map((r) => r.ordinal)).toEqual([1])
    expect(open.source).toBe('file')
  })

  it('has no tail of its own — the live subscription’s first frame supplies it', async () => {
    const { createHttpStreamTransport } = await load()
    expect((await createHttpStreamTransport().open('t1')).tail).toBeNull()
  })

  it('a full listing has nothing older, so there is no backwards cursor', async () => {
    const { createHttpStreamTransport } = await load()
    expect((await createHttpStreamTransport().open('t1')).backwardsCursor).toBeNull()
  })

  it('counts missing files and orphan marks as anomalies instead of dropping them', async () => {
    const { createHttpStreamTransport } = await load()
    const open = await createHttpStreamTransport().open('t1')
    expect(open.anomalies).toEqual({ missingFile: 1, orphanMark: 2 })
  })

  it('a 404 on the FALLBACK is a real failure and propagates', async () => {
    answer = () => ({ status: 404, body: { error: 'no such terminal' } })
    const { createHttpStreamTransport, StreamRouteAbsent } = await load()
    await expect(createHttpStreamTransport().open('t1')).rejects.toBeInstanceOf(StreamRouteAbsent)
  })

  it('a 500 on the open is NOT swallowed — only an absent route is', async () => {
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

  it('falls back to the deprecated /latest on a server with no open', async () => {
    answer = (url) =>
      url.endsWith('/stream/open')
        ? { status: 404, body: { error: 'not found' } }
        : { status: 200, body: { prompt: 'p', reply: 'r', title: 'from sous' } }
    const { createHttpStreamTransport } = await load()
    const tail = await createHttpStreamTransport().tail('t1')
    expect(calls.map((c) => c.url)).toEqual([
      '/api/terminal/t1/stream/open',
      '/api/terminal/t1/latest'
    ])
    expect(tail?.block?.prompt).toBe('p')
    expect(tail?.marks?.title).toBe('from sous')
  })

  it('a card with no turn yet is null, not an empty preview', async () => {
    answer = (url) =>
      url.endsWith('/stream/open')
        ? { status: 404, body: { error: 'not found' } }
        : { status: 200, body: null }
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
