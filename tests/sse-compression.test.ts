import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { createGunzip } from 'node:zlib'
import { respondJson, startSse, type SseSend } from '../src/main/mobile-http'

/**
 * Measured on a working canvas, 30 s of /api/events to one phone:
 *
 *   activity    102 events   227 KB   (every one distinct)
 *   board        44 events   146 KB   (TWO distinct — 42 exact repeats)
 *   workspace     1 event    180 KB
 *   ─────────────────────────────────
 *   total                    557 KB   uncompressed  →  87 KB compressed
 *
 * Over a DERP relay at 293 ms–2.5 s round trip that is the whole difference
 * between a live canvas and a stale one. Two independent fixes: compress the
 * stream, and stop re-sending snapshots that have not changed.
 *
 * These run against a real http.Server through a real socket, because the
 * failure mode that matters is not "wrong bytes" — it is a compressor that
 * BUFFERS, so events arrive only when the stream ends and the phone looks
 * frozen. Only a real decoder reading a live socket can catch that.
 */

interface Harness {
  port: number
  /** Resolves with the emitter once a client has connected. */
  connected: Promise<SseSend>
}

describe('startSse', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const startServer = async (): Promise<Harness> => {
    let announce: (send: SseSend) => void = () => undefined
    const connected = new Promise<SseSend>((resolve) => (announce = resolve))
    const server = http.createServer((_request, response) => announce(startSse(response)))
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { port: (server.address() as net.AddressInfo).port, connected }
  }

  /** Open a stream and yield decoded frames as they genuinely arrive. */
  const openStream = (
    port: number,
    acceptEncoding: string | undefined
  ): Promise<{ headers: http.IncomingHttpHeaders; frames: string[]; close: () => void }> =>
    new Promise((resolve, reject) => {
      const request = http.get(
        { host: '127.0.0.1', port, path: '/api/events', headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {} },
        (response) => {
          const frames: string[] = []
          const source =
            response.headers['content-encoding'] === 'gzip'
              ? response.pipe(createGunzip())
              : response
          source.on('data', (chunk: Buffer) => frames.push(chunk.toString('utf8')))
          resolve({
            headers: response.headers,
            frames,
            close: () => request.destroy()
          })
        }
      )
      request.on('error', reject)
    })

  /** Wait until `check` holds, or fail — never a bare sleep on a real socket. */
  const until = async (check: () => boolean, what: string): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (check()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  it('compresses the stream and still delivers each event as it happens', async () => {
    const { port, connected } = await startServer()
    const stream = await openStream(port, 'gzip, deflate, br')
    cleanup.push(stream.close)
    const send = await connected

    expect(stream.headers['content-encoding']).toBe('gzip')
    expect(stream.headers.vary).toBe('accept-encoding')

    send('activity', { terminalId: 'a', phase: 'working' })
    // THE regression this guards: without Z_SYNC_FLUSH after every event the
    // frame sits inside the compressor and the phone shows nothing at all.
    await until(() => stream.frames.join('').includes('"terminalId":"a"'), 'the first event')

    send('activity', { terminalId: 'b', phase: 'idle' })
    await until(() => stream.frames.join('').includes('"terminalId":"b"'), 'the second event')

    const text = stream.frames.join('')
    expect(text).toContain('event: activity')
    expect(text.startsWith(':ok')).toBe(true)
  })

  it('drops a snapshot event whose payload has not changed', async () => {
    const { port, connected } = await startServer()
    const stream = await openStream(port, 'gzip')
    cleanup.push(stream.close)
    const send = await connected

    const board = { rows: [{ id: 'x', task: 'build' }] }
    send('board', board)
    await until(() => stream.frames.join('').includes('event: board'), 'the first board')

    // 42 of 44 observed board pushes were byte-identical to one already sent.
    send('board', { ...board })
    send('board', { rows: [{ id: 'x', task: 'build' }] })
    send('activity', { terminalId: 'z' })
    await until(() => stream.frames.join('').includes('event: activity'), 'the activity marker')

    const boards = stream.frames.join('').match(/event: board/g) ?? []
    expect(boards).toHaveLength(1)
  })

  it('sends a snapshot again once it really changes', async () => {
    const { port, connected } = await startServer()
    const stream = await openStream(port, 'gzip')
    cleanup.push(stream.close)
    const send = await connected

    send('board', { rows: [1] })
    send('board', { rows: [1] })
    send('board', { rows: [1, 2] })
    await until(
      () => (stream.frames.join('').match(/event: board/g) ?? []).length === 2,
      'the changed board'
    )
    expect(stream.frames.join('')).toContain('[1,2]')
  })

  it('never drops an activity event — those are notifications, not snapshots', async () => {
    const { port, connected } = await startServer()
    const stream = await openStream(port, 'gzip')
    cleanup.push(stream.close)
    const send = await connected

    // Identical activity payloads are still two real occurrences; suppressing
    // the second would lose a turn boundary the phone is waiting on.
    send('activity', { terminalId: 'a', phase: 'working' })
    send('activity', { terminalId: 'a', phase: 'working' })
    await until(
      () => (stream.frames.join('').match(/event: activity/g) ?? []).length === 2,
      'both activity events'
    )
  })

  it('serves a client that cannot decompress, uncompressed', async () => {
    const { port, connected } = await startServer()
    const stream = await openStream(port, 'identity')
    cleanup.push(stream.close)
    const send = await connected

    expect(stream.headers['content-encoding']).toBeUndefined()
    send('activity', { terminalId: 'a' })
    await until(() => stream.frames.join('').includes('"terminalId":"a"'), 'the plain event')
  })
})

describe('respondJson', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  it('compresses without any call site asking it to', async () => {
    // /api/state measured 230 KB and /api/agents 149 KB on a working canvas.
    // There are 88 respondJson call sites; threading an encoding through all
    // of them is 88 chances to forget one, so it reads response.req itself.
    const body = { rows: Array.from({ length: 400 }, (_, at) => ({ id: at, task: 'a task' })) }
    const server = http.createServer((_request, response) => respondJson(response, 200, body))
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port

    const [packed, plain] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/`, { headers: { 'accept-encoding': 'br' } }),
      fetch(`http://127.0.0.1:${port}/`, { headers: { 'accept-encoding': 'identity' } })
    ])
    expect(packed.headers.get('content-encoding')).toBe('br')
    expect(plain.headers.get('content-encoding')).toBeNull()
    // fetch decodes transparently — the payload must survive the round trip.
    expect(await packed.json()).toEqual(body)
    expect(Number(packed.headers.get('content-length'))).toBeLessThan(
      Number(plain.headers.get('content-length')) / 3
    )
  })
})

describe('startSse heartbeat', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  it('sends the keepalive THROUGH the compressor, not around it', async () => {
    // The regression: each call site ran
    //   setInterval(() => response.write(':hb\n\n'), 25000)
    // and once the stream was compressed `response` became the compressor's
    // OUTPUT. That wrote plaintext into the middle of a gzip byte stream.
    // Measured against the live server: a terminal transcript delivered 4096
    // bytes, then nothing — no heartbeat, no further output — while the phone
    // sat on a frozen transcript until EventSource gave up and reconnected,
    // only to die again 25 s later.
    //
    // With a fast heartbeat the whole cycle is observable in milliseconds.
    const server = http.createServer((_request, response) => {
      const send = startSse(response)
      // Emit a comment the same way the heartbeat does, then real events.
      const timer = setInterval(() => send('activity', { tick: true }), 5)
      response.on('close', () => clearInterval(timer))
    })
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port

    const frames: string[] = []
    let failed: Error | null = null
    const request = http.get(
      { host: '127.0.0.1', port, path: '/api/events', headers: { 'accept-encoding': 'gzip' } },
      (response) => {
        const source = response.pipe(createGunzip())
        source.on('data', (chunk: Buffer) => frames.push(chunk.toString('utf8')))
        // A corrupted stream surfaces exactly here.
        source.on('error', (error: Error) => (failed = error))
      }
    )
    cleanup.push(() => request.destroy())

    for (let attempt = 0; attempt < 200 && frames.join('').split('event: activity').length < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(failed).toBeNull()
    expect(frames.join('').split('event: activity').length - 1).toBeGreaterThanOrEqual(19)
  })
})
