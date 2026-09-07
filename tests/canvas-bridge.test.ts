import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  BRIDGE_CHUNK,
  RELAY_MARKER,
  createCanvasBridge,
  flattenHeaders,
  loopbackDialer,
  type BridgeDialer
} from '../src/main/canvas-bridge'
import { decodeFrame, encodeFrame, type RelayFrame } from '../src/shared/relay-frame'

/**
 * IDENTITY v2, PHASE 3 — FRAMES BACK INTO REQUESTS.
 *
 * The companion here is a REAL server on loopback, because what is under test
 * is that a relayed request is INDISTINGUISHABLE from a LAN one by the time it
 * reaches the handler — same method, same path, same query, same body. A
 * mocked handler could not tell that apart from a bridge that quietly rewrote
 * something.
 */

/** What a canvas looks like from outside: an echo, a stream, and raw bytes. */
const companion = (): Server =>
  createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://companion.local')
    if (url.pathname === '/api/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: one\n\n')
      const beat = setInterval(() => {
        if (!response.writableEnded) response.write('data: more\n\n')
      }, 10)
      response.on('close', () => {
        clearInterval(beat)
        closedStreams += 1
      })
      return
    }
    if (url.pathname === '/bytes') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]))
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => void chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      response.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': ['canvas=yes; Path=/; HttpOnly', 'second=1; Path=/']
      })
      response.end(
        JSON.stringify({
          method: request.method,
          path: request.url,
          headers: request.headers,
          body: body.toString('utf8')
        })
      )
    })
  })

let closedStreams = 0
let server: Server
let port = 0

beforeAll(async () => {
  server = companion()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
)

/** A bridge, its outgoing frames, and the two helpers every test wants. */
const standUp = (
  options: { maxOpen?: number; dial?: BridgeDialer } = {}
): {
  frame: (frame: RelayFrame) => void
  sent: () => RelayFrame[]
  of: (id: string) => RelayFrame[]
  open: () => number
  reset: () => void
} => {
  const sent: RelayFrame[] = []
  const bridge = createCanvasBridge({
    send: (line) => {
      const frame = decodeFrame(line)
      if (frame) sent.push(frame)
    },
    dial: options.dial ?? loopbackDialer(port),
    ...(options.maxOpen === undefined ? {} : { maxOpen: options.maxOpen })
  })
  return {
    frame: (frame) => bridge.frame(encodeFrame(frame)),
    sent: () => sent,
    of: (id) => sent.filter((frame) => 'id' in frame && frame.id === id),
    open: () => bridge.open(),
    reset: () => bridge.reset()
  }
}

const until = async (what: () => boolean, why: string, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!what()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${why}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const bodyOf = (frames: readonly RelayFrame[]): Buffer =>
  Buffer.concat(
    frames.filter((frame) => frame.t === 'chunk').map((frame) => Buffer.from(frame.data, 'base64'))
  )

const ended = (frames: readonly RelayFrame[]): boolean => frames.some((frame) => frame.t === 'end')

describe('one relayed exchange', () => {
  it('reaches the companion as the request the phone made', async () => {
    const bridge = standUp()
    bridge.frame({
      t: 'open',
      id: 's1',
      method: 'POST',
      path: '/api/input?terminal=abc',
      headers: { 'content-type': 'application/json', accept: 'application/json' }
    })
    bridge.frame({ t: 'body', id: 's1', data: Buffer.from('{"text":"hi"}').toString('base64'), done: true })
    await until(() => ended(bridge.of('s1')), 'the exchange to finish')

    const head = bridge.of('s1').find((frame) => frame.t === 'head')
    expect(head).toMatchObject({ t: 'head', status: 200 })
    const echo = JSON.parse(bodyOf(bridge.of('s1')).toString('utf8')) as {
      method: string
      path: string
      headers: Record<string, string>
      body: string
    }
    expect(echo.method).toBe('POST')
    // The query rides through untouched — the admission `?open=&key=&device=`
    // is exactly this, and it must reach the handler as it does over the LAN.
    expect(echo.path).toBe('/api/input?terminal=abc')
    expect(echo.body).toBe('{"text":"hi"}')
    expect(echo.headers['content-type']).toBe('application/json')
  })

  it('speaks for itself in the host header and marks the request as relayed', async () => {
    const bridge = standUp()
    bridge.frame({
      t: 'open',
      id: 's2',
      method: 'GET',
      // A caller cannot choose the host: the companion builds its URL from it.
      path: '/',
      headers: {}
    })
    bridge.frame({ t: 'body', id: 's2', data: '', done: true })
    await until(() => ended(bridge.of('s2')), 'the exchange')
    const echo = JSON.parse(bodyOf(bridge.of('s2')).toString('utf8')) as {
      headers: Record<string, string>
    }
    expect(echo.headers.host).toBe(`127.0.0.1:${port}`)
    // Without the marker a relayed phone is served Vite's live module graph —
    // 159 requests over a link that cannot carry them.
    expect(echo.headers[RELAY_MARKER]).toBe('1')
  })

  it('passes the relay base through to the companion unchanged', async () => {
    // The registry says where the page is; the bridge must not have an
    // opinion about it. It is read once, at the shell, under the loopback and
    // marker rules in relay-base.ts.
    const base = '/relay/@owner/desktop/11111111-2222-3333-4444-555555555555'
    const bridge = standUp()
    bridge.frame({
      t: 'open',
      id: 'base',
      method: 'GET',
      path: '/',
      headers: { 'x-cookrew-base': base }
    })
    bridge.frame({ t: 'body', id: 'base', data: '', done: true })
    await until(() => ended(bridge.of('base')), 'the shell')
    const echo = JSON.parse(bodyOf(bridge.of('base')).toString('utf8')) as {
      headers: Record<string, string>
    }
    expect(echo.headers['x-cookrew-base']).toBe(base)
    // And the marker is still the bridge's own word, written over whatever
    // the caller sent — that pair is the whole trust rule.
    expect(echo.headers[RELAY_MARKER]).toBe('1')
  })

  it('speaks the marker over a caller that tried to claim it', async () => {
    const bridge = standUp()
    bridge.frame({
      t: 'open',
      id: 'forge',
      method: 'GET',
      path: '/',
      headers: { [RELAY_MARKER]: 'not-mine' }
    })
    bridge.frame({ t: 'body', id: 'forge', data: '', done: true })
    await until(() => ended(bridge.of('forge')), 'the answer')
    const echo = JSON.parse(bodyOf(bridge.of('forge')).toString('utf8')) as {
      headers: Record<string, string>
    }
    expect(echo.headers[RELAY_MARKER]).toBe('1')
  })

  it('carries bytes that are not text, because a canvas serves images', async () => {
    const bridge = standUp()
    bridge.frame({ t: 'open', id: 's3', method: 'GET', path: '/bytes', headers: {} })
    bridge.frame({ t: 'body', id: 's3', data: '', done: true })
    await until(() => ended(bridge.of('s3')), 'the bytes')
    expect([...bodyOf(bridge.of('s3'))]).toEqual([0, 1, 2, 250, 251, 252, 253, 254, 255])
  })

  it('sends several Set-Cookie as one value with newlines between them', async () => {
    const bridge = standUp()
    bridge.frame({ t: 'open', id: 's4', method: 'GET', path: '/cookies', headers: {} })
    bridge.frame({ t: 'body', id: 's4', data: '', done: true })
    await until(() => ended(bridge.of('s4')), 'the answer')
    const head = bridge.of('s4').find((frame) => frame.t === 'head')
    expect(head?.t === 'head' && head.headers['set-cookie']).toBe(
      'canvas=yes; Path=/; HttpOnly\nsecond=1; Path=/'
    )
  })

  it('answers a body-less exchange the moment its terminal frame lands', async () => {
    const bridge = standUp()
    bridge.frame({ t: 'open', id: 's5', method: 'GET', path: '/', headers: {} })
    expect(bridge.of('s5')).toEqual([])
    // The registry sends exactly one terminal body frame even for an empty
    // body, so waiting for `done` is never waiting forever.
    bridge.frame({ t: 'body', id: 's5', data: '', done: true })
    await until(() => ended(bridge.of('s5')), 'the answer')
  })
})

describe('a stream', () => {
  it('stays open until the caller goes away', async () => {
    const before = closedStreams
    const bridge = standUp()
    bridge.frame({ t: 'open', id: 'e1', method: 'GET', path: '/api/events', headers: {} })
    bridge.frame({ t: 'body', id: 'e1', data: '', done: true })
    await until(() => bridge.of('e1').filter((frame) => frame.t === 'chunk').length >= 2, 'two bursts')
    expect(ended(bridge.of('e1'))).toBe(false)
    // The phone closed the tab. Stopping the local request is what ends the
    // stream rather than leaking it for the life of the app.
    bridge.frame({ t: 'abort', id: 'e1', reason: 'caller-gone' })
    await until(() => closedStreams > before, 'the companion to see the stream close')
    expect(bridge.open()).toBe(0)
  })

  it('is dropped along with everything else when the line dies', async () => {
    const before = closedStreams
    const bridge = standUp()
    bridge.frame({ t: 'open', id: 'e2', method: 'GET', path: '/api/events', headers: {} })
    bridge.frame({ t: 'body', id: 'e2', data: '', done: true })
    await until(() => bridge.of('e2').some((frame) => frame.t === 'chunk'), 'the first burst')
    bridge.reset()
    await until(() => closedStreams > before, 'the companion to see it close')
    expect(bridge.open()).toBe(0)
  })
})

describe('what the bridge refuses', () => {
  it('aborts beyond its concurrency bound rather than queueing forever', async () => {
    const bridge = standUp({ maxOpen: 2 })
    bridge.frame({ t: 'open', id: 'a', method: 'GET', path: '/api/events', headers: {} })
    bridge.frame({ t: 'body', id: 'a', data: '', done: true })
    bridge.frame({ t: 'open', id: 'b', method: 'GET', path: '/api/events', headers: {} })
    bridge.frame({ t: 'body', id: 'b', data: '', done: true })
    bridge.frame({ t: 'open', id: 'c', method: 'GET', path: '/', headers: {} })
    expect(bridge.of('c')).toEqual([{ t: 'abort', id: 'c', reason: 'busy' }])
    bridge.reset()
  })

  it('aborts a body larger than the registry itself would carry', () => {
    const bridge = standUp()
    bridge.frame({ t: 'open', id: 'big', method: 'POST', path: '/', headers: {} })
    // 384 KB raw a frame, which is what the registry itself sends: bigger
    // than that and the frame is over the wire's own megabyte ceiling.
    const slab = Buffer.alloc(BRIDGE_CHUNK, 7).toString('base64')
    for (let sent = 0; sent < 12; sent += 1) bridge.frame({ t: 'body', id: 'big', data: slab })
    expect(bridge.of('big')).toEqual([{ t: 'abort', id: 'big', reason: 'body-too-large' }])
    expect(bridge.open()).toBe(0)
  })

  it('says nothing to a line that is not a frame', () => {
    const sent: string[] = []
    const bridge = createCanvasBridge({ send: (line) => void sent.push(line), dial: loopbackDialer(port) })
    bridge.frame('not json')
    bridge.frame('{"t":"nonsense"}')
    expect(sent).toEqual([])
  })

  it('aborts when the companion itself fails, without taking the line down', async () => {
    // Nothing is listening on this port, so the dial errors.
    const bridge = standUp({ dial: loopbackDialer(1) })
    bridge.frame({ t: 'open', id: 'x', method: 'GET', path: '/', headers: {} })
    bridge.frame({ t: 'body', id: 'x', data: '', done: true })
    await until(() => bridge.of('x').length > 0, 'the abort')
    expect(bridge.of('x')).toEqual([{ t: 'abort', id: 'x', reason: 'companion-failed' }])
  })
})

describe('the frame ceiling', () => {
  it('never puts more than 384 KB of raw bytes in one chunk', async () => {
    const payload = Buffer.alloc(1024 * 1024, 3)
    // A fake dialer, because a real socket delivers in 64 KB reads and would
    // never exercise the split this test is about.
    const oneBigRead: BridgeDialer = (_input, onResponse) => {
      let done: (() => void) | null = null
      onResponse({
        status: 200,
        headers: {},
        onData: (listener) => setTimeout(() => listener(payload), 0),
        onEnd: (listener) => void (done = listener)
      })
      setTimeout(() => done?.(), 5)
      return { write: () => undefined, end: () => undefined, destroy: () => undefined }
    }
    const bridge = standUp({ dial: oneBigRead })
    bridge.frame({ t: 'open', id: 'g', method: 'GET', path: '/big', headers: {} })
    bridge.frame({ t: 'body', id: 'g', data: '', done: true })
    await until(() => ended(bridge.of('g')), 'the whole payload')
    const chunks = bridge.of('g').filter((frame) => frame.t === 'chunk')
    expect(chunks.length).toBe(3)
    for (const chunk of chunks) {
      expect(Buffer.from(chunk.t === 'chunk' ? chunk.data : '', 'base64').byteLength).toBeLessThanOrEqual(
        BRIDGE_CHUNK
      )
    }
    expect(bodyOf(bridge.of('g')).equals(payload)).toBe(true)
  })
})

describe('an answer with no body', () => {
  /**
   * MEASURED on the relay, 2026-09-08. The companion answered every phone
   * beacon 204 with `content-length: 2`, and Electron's Node 20 http client
   * then never emitted `end` — it was waiting for two bytes that a 204 does
   * not carry. Each beacon held a relay exchange until the 120 s idle deadline;
   * sixteen of them hit the per-desktop cap and the shell died with
   * `too_many_exchanges`. The dialer here reproduces exactly that: a 204 head
   * and no `end`, ever. The bridge must close the exchange on the head alone.
   */
  it('ends the exchange on the head of a 204, without waiting for a body', async () => {
    const late: { end: (() => void) | null } = { end: null }
    const neverEnds: BridgeDialer = (_input, onResponse) => {
      onResponse({
        status: 204,
        headers: { 'content-length': '2', 'content-type': 'application/json' },
        onData: () => undefined,
        onEnd: (listener) => void (late.end = listener)
      })
      return { write: () => undefined, end: () => undefined, destroy: () => undefined }
    }
    const bridge = standUp({ dial: neverEnds })
    bridge.frame({
      t: 'open',
      id: 'b',
      method: 'POST',
      path: '/api/beacon',
      headers: { 'content-type': 'application/json' }
    })
    bridge.frame({ t: 'body', id: 'b', data: Buffer.from('{"t":1}').toString('base64'), done: true })
    await until(() => ended(bridge.of('b')), 'the bodiless answer to end', 500)
    expect(bridge.of('b').map((frame) => frame.t)).toEqual(['head', 'end'])
    expect(bridge.open()).toBe(0)
    // A late `end` from the socket, should the parser ever deliver one, is
    // not a second end frame.
    late.end?.()
    expect(bridge.of('b').filter((frame) => frame.t === 'end').length).toBe(1)
  })

  it('treats 304 and 1xx the same way', async () => {
    for (const status of [304, 101]) {
      const stuck: BridgeDialer = (_input, onResponse) => {
        onResponse({ status, headers: {}, onData: () => undefined, onEnd: () => undefined })
        return { write: () => undefined, end: () => undefined, destroy: () => undefined }
      }
      const bridge = standUp({ dial: stuck })
      bridge.frame({ t: 'open', id: 'n', method: 'GET', path: '/x', headers: {} })
      bridge.frame({ t: 'body', id: 'n', data: '', done: true })
      await until(() => ended(bridge.of('n')), `a ${status} to end`, 500)
    }
  })
})

describe('the reserved seal', () => {
  it('is carried onto the answer, unread', async () => {
    const bridge = standUp()
    bridge.frame({
      t: 'open',
      id: 'seal',
      method: 'GET',
      path: '/bytes',
      headers: {},
      sealed: 'ciphertext-nobody-here-reads'
    })
    bridge.frame({ t: 'body', id: 'seal', data: '', done: true })
    await until(() => ended(bridge.of('seal')), 'the answer')
    for (const frame of bridge.of('seal')) {
      if (frame.t === 'head' || frame.t === 'chunk') {
        expect(frame.sealed).toBe('ciphertext-nobody-here-reads')
      }
    }
    // And an unsealed exchange grows no seal of its own.
    bridge.frame({ t: 'open', id: 'bare', method: 'GET', path: '/bytes', headers: {} })
    bridge.frame({ t: 'body', id: 'bare', data: '', done: true })
    await until(() => ended(bridge.of('bare')), 'the bare answer')
    const head = bridge.of('bare').find((frame) => frame.t === 'head')
    expect(head && 'sealed' in head).toBe(false)
  })
})

describe('flattening the companion answer', () => {
  it('joins set-cookie with newlines and everything else with commas', () => {
    expect(
      flattenHeaders({
        'set-cookie': ['a=1', 'b=2'],
        // Node types `vary` as a single string, but a server may write it
        // twice and the parser hands back an array whatever the type says.
        vary: ['origin', 'accept'] as unknown as string,
        'content-type': 'application/json',
        'content-length': undefined
      })
    ).toEqual({
      'set-cookie': 'a=1\nb=2',
      vary: 'origin, accept',
      'content-type': 'application/json'
    })
  })
})
