// ONE STREAM, T2 — the three routes and the one write.
//
// The claims under test are the contract T3's renderer will be built on:
//   · /stream/index is the rail in ONE read — positions joined with marks,
//     with `missing` and `orphanMarks` said out loud rather than swallowed;
//   · /stream windows by IDENTITY in both directions and never returns the
//     whole chain;
//   · an unknown terminal is a 404, not a 200 with an empty list (the answer
//     that made deleted history and missing history indistinguishable);
//   · the PTY mirror at GET /api/terminal/:id/stream is NOT shadowed;
//   · PUT /stream/marks writes marks and REFUSES conversation text.

import http from 'node:http'
import type net from 'node:net'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { readMarks, writeMark, markFileFor } from '../src/main/marks'
import type { StreamService, StreamTailState } from '../src/main/stream-service'
import type { StreamBlock } from '../src/main/stream'
import type { StreamChain } from '../src/main/stream-chain'
import type { TurnRecord } from '../src/shared/turn'
import type { TranscriptSource } from '../src/main/transcript-source'

const PAIRING = 'pairing-token-abc'
const WALL = 'wall-token-def'
const T0 = Date.parse('2026-09-07T09:00:00.000Z')

function block(id: string, ordinal: number, prompt: string, reply = ''): StreamBlock {
  return {
    id,
    index: ordinal,
    ordinal,
    prompt,
    reply,
    activity: [],
    startedAt: T0 + ordinal * 1000,
    endedAt: T0 + ordinal * 1000 + 500,
    compacted: false,
    file: '/tmp/s1.jsonl',
    sessionId: 's1'
  }
}

const CHAIN: StreamChain = {
  files: [{ sessionId: 's1', file: '/tmp/s1.jsonl', kind: 'claude' }],
  missing: []
}

/**
 * A StreamService with no disk under the transcript half and the REAL marks
 * ledger under the other. The routes' job is shape and windowing; the marks
 * ledger's job is last-wins and refusal, and that half must be real or the
 * PUT tests prove nothing.
 */
function service(options: {
  blocks: StreamBlock[]
  source?: TranscriptSource | null
  marksDir: string
  missing?: StreamChain['missing']
  tailFinal?: boolean
}): StreamService {
  const all = options.blocks
  const markOptions = { dir: options.marksDir }
  return {
    sourceOf: () => (options.source === undefined ? 'file' : options.source),
    chain: async () => ({ ...CHAIN, missing: options.missing ?? [] }),
    async checkpoints(terminalId) {
      const marks = readMarks(terminalId, markOptions)
      const placed = new Set(all.map((b) => b.id))
      return {
        checkpoints: all.map((b) => ({
          identity: b.id,
          ordinal: b.ordinal,
          startedAt: b.startedAt,
          endedAt: b.endedAt,
          promptHead: b.prompt,
          compacted: b.compacted,
          file: b.file,
          ...(marks.get(b.id)?.title !== undefined ? { title: marks.get(b.id)?.title } : {})
        })),
        missing: options.missing ?? [],
        orphanMarks: [...marks.keys()].filter((identity) => !placed.has(identity))
      }
    },
    async blocks(_terminalId, request = {}) {
      const limit = request.limit ?? 20
      if (request.after !== undefined) {
        const at = all.findIndex((b) => b.id === request.after)
        if (at < 0) return { blocks: [], total: all.length, missing: [], unknownAfter: true }
        return { blocks: all.slice(at + 1, at + 1 + limit), total: all.length, missing: [] }
      }
      if (request.before !== undefined) {
        const at = all.findIndex((b) => b.id === request.before)
        if (at < 0) return { blocks: [], total: all.length, missing: [], unknownBefore: true }
        return { blocks: all.slice(Math.max(0, at - limit), at), total: all.length, missing: [] }
      }
      return { blocks: all.slice(0, limit), total: all.length, missing: [] }
    },
    async tailState(): Promise<StreamTailState> {
      const tail = all[all.length - 1] ?? null
      const final = options.tailFinal === true
      return {
        block: tail,
        open: !final,
        missing: [],
        final,
        kind: 'claude',
        total: all.length
      }
    },
    marks: (terminalId) => readMarks(terminalId, markOptions),
    writeMark: (terminalId, patch) => writeMark(terminalId, patch, markOptions),
    marksFile: (terminalId) => markFileFor(terminalId, markOptions),
    rewindPoints: () => []
  }
}

describe('the three stream routes', () => {
  const cleanup: Array<() => void> = []
  let marksDir = ''

  beforeEach(() => {
    marksDir = mkdtempSync(path.join(tmpdir(), 'stream-marks-'))
  })
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const start = async (over: Partial<MobileApiDeps>): Promise<number> => {
    const deps = { pairingToken: PAIRING, wallToken: WALL, ...over } as unknown as MobileApiDeps
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (!handled) response.writeHead(418, { 'content-type': 'application/json' }).end('{}')
      })
    })
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return (server.address() as net.AddressInfo).port
  }

  const call = async (
    port: number,
    route: string,
    init: { token?: string | null; method?: string; body?: unknown } = {}
  ) => {
    const token = init.token === undefined ? PAIRING : init.token
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }

  const three = () => [
    block('u1', 1, 'first ask', 'one'),
    block('u2', 2, 'second ask', 'two'),
    block('u3', 3, 'third ask', 'three')
  ]

  it('403/401s a read with no credential, exactly like every other /api GET', async () => {
    const port = await start({ stream: service({ blocks: three(), marksDir }) })
    expect((await call(port, '/api/terminal/t1/stream/index', { token: null })).status).toBe(401)
    expect((await call(port, '/api/terminal/t1/stream/index', { token: WALL })).status).toBe(200)
  })

  it('refuses a mark write from the read-only wall token', async () => {
    const port = await start({ stream: service({ blocks: three(), marksDir }) })
    const answer = await call(port, '/api/terminal/t1/stream/marks', {
      token: WALL,
      method: 'PUT',
      body: { identity: 'u1', title: 'nope' }
    })
    expect(answer.status).toBe(401)
    expect(readMarks('t1', { dir: marksDir }).size).toBe(0)
  })

  it('404s an unknown terminal instead of an empty list that means nothing', async () => {
    const port = await start({ stream: service({ blocks: [], marksDir, source: null }) })
    for (const route of ['/stream/index', '/stream/blocks', '/stream/live']) {
      expect((await call(port, `/api/terminal/ghost${route}`)).status).toBe(404)
    }
  })

  it('503s when the reader is not wired — loud, not an invented empty history', async () => {
    const port = await start({})
    const answer = await call(port, '/api/terminal/t1/stream/index')
    expect(answer.status).toBe(503)
    expect(answer.body).toEqual({ error: 'the stream reader is not wired' })
  })

  it('/stream/index is the rail in one read: positions, grouped marks, source', async () => {
    const port = await start({ stream: service({ blocks: three(), marksDir }) })
    writeMark('t1', { identity: 'u2', title: 'ran the suite' }, { dir: marksDir })
    const answer = await call(port, '/api/terminal/t1/stream/index')
    expect(answer.status).toBe(200)
    expect(answer.body.source).toBe('file')
    expect(answer.body.checkpoints).toHaveLength(3)
    expect(answer.body.checkpoints[0]).toEqual({
      identity: 'u1',
      ordinal: 1,
      startedAt: T0 + 1000,
      endedAt: T0 + 1500,
      promptHead: 'first ask',
      compacted: false,
      file: '/tmp/s1.jsonl'
    })
    // Marks are GROUPED, so nothing attached can shadow `ordinal` or `file`.
    expect(answer.body.checkpoints[1].marks).toEqual({ title: 'ran the suite' })
    expect(answer.body.checkpoints[0].marks).toBeUndefined()
  })

  it('reports a missing predecessor and an orphan mark — never drops either', async () => {
    const missing = [{ sessionId: 's0', file: '/tmp/s0.jsonl', reason: 'no-transcript' as const }]
    const port = await start({ stream: service({ blocks: three(), marksDir, missing }) })
    writeMark('t1', { identity: 'gone-with-s0', title: 'older' }, { dir: marksDir })
    const answer = await call(port, '/api/terminal/t1/stream/index')
    expect(answer.body.missing).toEqual(missing)
    expect(answer.body.orphanMarks).toEqual(['gone-with-s0'])
  })

  it('/stream windows forward and backward by identity, short at the ends', async () => {
    const port = await start({ stream: service({ blocks: three(), marksDir }) })
    const forward = await call(port, '/api/terminal/t1/stream?after=u1&limit=1')
    expect(forward.body.blocks.map((b: StreamBlock) => b.id)).toEqual(['u2'])
    expect(forward.body.total).toBe(3)

    const back = await call(port, '/api/terminal/t1/stream?before=u3&limit=5')
    expect(back.body.blocks.map((b: StreamBlock) => b.id)).toEqual(['u1', 'u2'])

    const first = await call(port, '/api/terminal/t1/stream/blocks')
    expect(first.body.blocks.map((b: StreamBlock) => b.id)).toEqual(['u1', 'u2', 'u3'])
  })

  it('says so when a cursor names an identity the stream does not hold', async () => {
    const port = await start({ stream: service({ blocks: three(), marksDir }) })
    const ahead = await call(port, '/api/terminal/t1/stream?after=nope')
    expect(ahead.body).toMatchObject({ blocks: [], unknownAfter: true })
    const behind = await call(port, '/api/terminal/t1/stream?before=nope')
    expect(behind.body).toMatchObject({ blocks: [], unknownBefore: true })
  })

  it('carries only the WINDOW’s marks, keyed by identity — never the ledger', async () => {
    const port = await start({ stream: service({ blocks: three(), marksDir }) })
    writeMark('t1', { identity: 'u1', title: 'one' }, { dir: marksDir })
    writeMark('t1', { identity: 'u3', seenAt: 42 }, { dir: marksDir })
    const answer = await call(port, '/api/terminal/t1/stream?after=u1&limit=1')
    expect(answer.body.blocks.map((b: StreamBlock) => b.id)).toEqual(['u2'])
    expect(answer.body.marks).toEqual({})
    const wide = await call(port, '/api/terminal/t1/stream?limit=10')
    expect(wide.body.marks).toEqual({ u1: { title: 'one' }, u3: { seenAt: 42 } })
  })

  it('clamps ?limit — an unbounded window would ship a whole history', async () => {
    const port = await start({ stream: service({ blocks: three(), marksDir }) })
    const zero = await call(port, '/api/terminal/t1/stream?limit=0')
    expect(zero.body.blocks).toHaveLength(1)
    const junk = await call(port, '/api/terminal/t1/stream?limit=abc')
    expect(junk.body.blocks).toHaveLength(3)
  })

  it('does NOT shadow the PTY mirror at the same path', async () => {
    // A bare GET /api/terminal/:id/stream has meant "open the PTY mirror"
    // since long before this reader existed. Unclaimed here, it falls through
    // to that handler — which, with no pty in these deps, is a 404 from the
    // route below, never a JSON block window.
    const port = await start({
      stream: service({ blocks: three(), marksDir }),
      ptys: { get: () => null } as unknown as MobileApiDeps['ptys']
    })
    const mirror = await call(port, '/api/terminal/t1/stream')
    expect(mirror.status).toBe(404)
    expect(mirror.body).toEqual({ error: 'Terminal not running' })
  })

  it('a door or scrape card answers from the SAME provider the old routes use', async () => {
    const history: TurnRecord[] = [
      { index: 1, prompt: 'remote ask', reply: 'remote reply', startedAt: T0, endedAt: T0 + 1 },
      { index: 2, prompt: 'again', reply: 'again reply', uuid: 'd2', startedAt: T0, endedAt: T0 + 2 }
    ]
    const port = await start({
      stream: service({ blocks: [], marksDir, source: 'door' }),
      turnHistory: async () => history
    })
    const answer = await call(port, '/api/terminal/t1/stream/index')
    expect(answer.body.source).toBe('door')
    expect(answer.body.checkpoints.map((c: { ordinal: number }) => c.ordinal)).toEqual([1, 2])
    // A record with no uuid gets the SAME derived digest the renderer uses.
    expect(answer.body.checkpoints[0].identity).toMatch(/^claude-1-[0-9a-f]{8}$/)
    expect(answer.body.checkpoints[1].identity).toBe('d2')
    const window = await call(port, '/api/terminal/t1/stream?after=d2')
    expect(window.body.blocks).toEqual([])
    expect(window.body.total).toBe(2)
  })
})

describe('PUT /stream/marks — the only write in the design', () => {
  const cleanup: Array<() => void> = []
  let marksDir = ''

  beforeEach(() => {
    marksDir = mkdtempSync(path.join(tmpdir(), 'stream-marks-put-'))
  })
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const start = async (): Promise<number> => {
    const deps = {
      pairingToken: PAIRING,
      stream: service({ blocks: [block('u1', 1, 'ask')], marksDir })
    } as unknown as MobileApiDeps
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (!handled) response.writeHead(418).end('{}')
      })
    })
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return (server.address() as net.AddressInfo).port
  }

  const put = async (port: number, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/terminal/t1/stream/marks`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${PAIRING}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    return { status: response.status, body: JSON.parse(await response.text()) }
  }

  it('accepts a title and answers with the folded mark', async () => {
    const port = await start()
    const answer = await put(port, { identity: 'u1', title: 'ran the suite' })
    expect(answer.status).toBe(200)
    expect(answer.body.ok).toBe(true)
    expect(answer.body.mark).toMatchObject({ identity: 'u1', title: 'ran the suite' })
  })

  it('is last-wins per identity, field by field, over an APPEND-ONLY ledger', async () => {
    const port = await start()
    await put(port, { identity: 'u1', title: 'first' })
    await put(port, { identity: 'u1', seenAt: 111 })
    const last = await put(port, { identity: 'u1', title: 'second' })
    expect(last.body.mark).toMatchObject({ title: 'second', seenAt: 111 })
    // Three writes, three lines: nothing was rewritten in place.
    const file = markFileFor('t1', { dir: marksDir }) as string
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(3)
  })

  it('clears a field with null — "no title any more" is a fact, not an absence', async () => {
    const port = await start()
    await put(port, { identity: 'u1', title: 'temporary', pin: 3 })
    const cleared = await put(port, { identity: 'u1', title: null })
    expect(cleared.body.mark.title).toBeUndefined()
    expect(cleared.body.mark.pin).toBe(3)
  })

  it('REFUSES conversation text with a 400 — the invariant the design rests on', async () => {
    const port = await start()
    for (const key of ['prompt', 'reply', 'text', 'content', 'activity', 'promptHead']) {
      const answer = await put(port, { identity: 'u1', [key]: 'the whole exchange' })
      expect(answer.status).toBe(400)
      expect(answer.body.ok).toBe(false)
      expect(answer.body.error).toContain(key)
      expect(readMarks('t1', { dir: marksDir }).get('u1')).toBeUndefined()
    }
  })

  it('refuses an unknown field, and a patch with no identity', async () => {
    const port = await start()
    expect((await put(port, { identity: 'u1', colour: 'red' })).status).toBe(400)
    expect((await put(port, { title: 'orphan' })).status).toBe(400)
    expect((await put(port, { identity: 'u1' })).status).toBe(400)
  })

  it('refuses a title that is a document rather than a line', async () => {
    const port = await start()
    const answer = await put(port, { identity: 'u1', title: 'x'.repeat(513) })
    expect(answer.status).toBe(400)
    expect(answer.body.error).toContain('a line, not a document')
  })
})
