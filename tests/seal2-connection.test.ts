// The cookrew-seal/2 session engine (src/shared/seal2/connection.ts): two ends
// joined by an in-memory carrier that can hold, drop, repeat, reorder and
// tamper with records, the way a relay could.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRecordReader, encodeRecord } from '../src/shared/canvas-seal-wire'
import type { SealRecord } from '../src/shared/canvas-seal'
import { acceptCodeHandshake, startCodeHandshake } from '../src/shared/seal2/handshake'
import { createSeal2Connection, Seal2StreamError, type Seal2Connection, type Seal2ConnectionOptions, type Seal2Stream } from '../src/shared/seal2/connection'
import { decodeFrame2, encodeFrame2, type Frame2 } from '../src/shared/seal2/frames'
import { sealedFetch } from '../src/shared/seal2/http'
import type { Seal2Session } from '../src/shared/seal2/records'
import { ABORT, STREAM_WINDOW } from '../src/shared/seal2/spec'

const code = new Uint8Array(32).fill(7)

async function sessions(): Promise<{ initiator: Seal2Session; responder: Seal2Session }> {
  const started = await startCodeHandshake(code, { allowV1: false })
  const accepted = await acceptCodeHandshake(code, started.hello)
  const done = await started.finish(accepted?.accept)
  if (!accepted || done?.version !== 2) throw new Error('no session')
  return { initiator: done.session as Seal2Session, responder: accepted.session }
}

interface Carrier {
  /** Every record that went from this side, in the order sent. */
  readonly sent: SealRecord[]
  hold: boolean
  filter: (record: SealRecord) => SealRecord | null
  flush(): Promise<void>
}

/** One direction: whole records, delivered on the next turn unless held. */
function carrier(to: () => Seal2Connection): Carrier & { send(wire: Uint8Array): void } {
  const reader = createRecordReader()
  const waiting: SealRecord[] = []
  const self = {
    sent: [] as SealRecord[],
    hold: false,
    filter: (record: SealRecord): SealRecord | null => record,
    send(wire: Uint8Array) {
      for (const record of reader.push(wire)) {
        self.sent.push(record)
        waiting.push(record)
      }
      if (!self.hold) setTimeout(() => void self.flush(), 0)
    },
    async flush() {
      const batch = waiting.splice(0).map((record) => self.filter(record)).filter((record): record is SealRecord => record !== null)
      if (batch.length > 0) await to().receive(batch)
    }
  }
  return self
}

type Options = Partial<Omit<Seal2ConnectionOptions, 'session' | 'role' | 'send'>>

async function pair(initiatorOptions: Options = {}, responderOptions: Options = {}) {
  const { initiator, responder } = await sessions()
  let a: Seal2Connection | null = null
  let b: Seal2Connection | null = null
  const toB = carrier(() => b as Seal2Connection)
  const toA = carrier(() => a as Seal2Connection)
  a = createSeal2Connection({ session: initiator, role: 'initiator', send: (wire) => toB.send(wire), ...initiatorOptions })
  b = createSeal2Connection({ session: responder, role: 'responder', send: (wire) => toA.send(wire), ...responderOptions })
  opened.push(a, b)
  return { a, b, toA, toB }
}

const opened: Seal2Connection[] = []
afterEach(() => {
  for (const connection of opened.splice(0)) connection.close('test over')
})

const text = (value: string): Uint8Array => new TextEncoder().encode(value)
const readAll = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const parts: Uint8Array[] = []
  for (const reader = stream.getReader(); ; ) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0)
  return out
}
const write = async (stream: Seal2Stream, ...chunks: Uint8Array[]): Promise<void> => {
  const writer = stream.writable.getWriter()
  for (const chunk of chunks) await writer.write(chunk)
  await writer.close()
}
const echo = (stream: Seal2Stream): void => {
  stream.respond(200, { 'x-kind': stream.kind })
  void stream.readable.pipeTo(stream.writable).catch(() => undefined)
}

describe('streams', () => {
  it('carries a request and its answer, both ways, and ends cleanly', async () => {
    const { a } = await pair({}, { onStream: echo })
    const stream = a.openStream('echo', { ':path': '/x' })
    void write(stream, text('hello '), text('there'))
    expect(await stream.head).toEqual({ status: 200, fields: { 'x-kind': 'echo' } })
    expect(new TextDecoder().decode(await readAll(stream.readable))).toBe('hello there')
    await expect(stream.closed).resolves.toBeUndefined()
  })

  it('moves more than a window through credit, byte for byte', async () => {
    const { a } = await pair({}, { onStream: echo })
    const big = Uint8Array.from({ length: 3 * STREAM_WINDOW + 12345 }, (_, i) => (i * 31) & 0xff)
    const stream = a.openStream('echo', {})
    void write(stream, big)
    const back = await readAll(stream.readable)
    expect(back.length).toBe(big.length)
    expect(Buffer.from(back).equals(Buffer.from(big))).toBe(true)
  })

  it('holds back only the stream whose reader is slow', async () => {
    const received: Record<string, number> = {}
    const { a } = await pair(
      {},
      {
        onStream: (stream) => {
          stream.respond(200, {})
          if (stream.fields.name === 'slow') return // never reads
          void readAll(stream.readable).then((all) => {
            received[stream.fields.name] = all.length
            return stream.writable.close()
          })
        }
      }
    )
    const slow = a.openStream('sink', { name: 'slow' })
    const fast = a.openStream('sink', { name: 'fast' })
    let slowSent = 0
    const slowWriter = slow.writable.getWriter()
    void (async () => {
      for (;;) {
        await slowWriter.write(new Uint8Array(64 * 1024))
        slowSent += 64 * 1024
      }
    })().catch(() => undefined)
    await write(fast, new Uint8Array(2 * STREAM_WINDOW))
    await vi.waitFor(() => expect(received.fast).toBe(2 * STREAM_WINDOW))
    // The slow stream is stopped at its window: its credit was never given back.
    expect(slowSent).toBeLessThanOrEqual(STREAM_WINDOW)
    expect(slowSent).toBeGreaterThan(0)
  })

  it('carries many streams at once on one session', async () => {
    const { a } = await pair({}, { onStream: echo })
    const answers = await Promise.all(
      Array.from({ length: 20 }, async (_, n) => {
        const stream = a.openStream('echo', {})
        void write(stream, text(`stream ${n}`))
        return new TextDecoder().decode(await readAll(stream.readable))
      })
    )
    expect(answers).toEqual(Array.from({ length: 20 }, (_, n) => `stream ${n}`))
  })
})

describe('abort semantics', () => {
  it('a cancel from the opener reaches the other end as an error, not an end', async () => {
    let far: Seal2Stream | null = null
    const { a } = await pair({}, { onStream: (stream) => ((far = stream), stream.respond(200, {})) })
    const stream = a.openStream('echo', {})
    await vi.waitFor(() => expect(far).not.toBeNull())
    stream.abort(ABORT.cancel, 'changed my mind')
    const farStream = far as unknown as Seal2Stream
    await expect(readAll(farStream.readable)).rejects.toMatchObject({ code: ABORT.cancel, remote: true })
    await expect(farStream.closed).rejects.toBeInstanceOf(Seal2StreamError)
  })

  it('an unknown kind is refused with its own code', async () => {
    const { a } = await pair({}, { onStream: (stream) => stream.abort(ABORT.unknownKind, 'no such kind') })
    const stream = a.openStream('nothing', {})
    await expect(stream.head).rejects.toMatchObject({ code: ABORT.unknownKind })
  })

  it('a peer past its credit loses the stream (fail closed)', async () => {
    const { initiator, responder } = await sessions()
    let far: Seal2Stream | null = null
    const toA: Uint8Array[] = []
    const b = createSeal2Connection({ session: responder, role: 'responder', send: (wire) => toA.push(wire), onStream: (stream) => ((far = stream), stream.respond(200, {})) })
    opened.push(b)
    const frames: Frame2[] = [{ kind: 'open', stream: 1, type: 'sink', fields: {} }]
    for (let sent = 0; sent <= STREAM_WINDOW; sent += 200 * 1024) frames.push({ kind: 'data', stream: 1, data: new Uint8Array(200 * 1024) })
    const records = []
    for (const frame of frames) records.push(await initiator.seal(encodeFrame2(frame)))
    await b.receive(records)
    const farStream = far as unknown as Seal2Stream
    await expect(farStream.closed).rejects.toMatchObject({ code: ABORT.flow })
  })
})

describe('what a carrier can do', () => {
  it('a tampered record is never delivered, and says so', async () => {
    const { a, b, toB } = await pair({}, { onStream: echo })
    toB.hold = true
    const stream = a.openStream('echo', {})
    void write(stream, text('secret'))
    await vi.waitFor(() => expect(toB.sent.length).toBeGreaterThanOrEqual(3))
    const [first] = toB.sent
    const box = first.box.slice()
    box[box.length - 1] ^= 1
    expect(await b.receive([{ seq: first.seq, box }])).toContain('forged')
    expect(b.stats().streams).toBe(0)
  })

  it('a record played twice or out of order is delivered once, in order', async () => {
    const { a, b, toB } = await pair({}, { onStream: echo })
    toB.hold = true
    const stream = a.openStream('echo', {})
    void write(stream, text('one'), text('two'))
    await vi.waitFor(() => expect(toB.sent.length).toBeGreaterThanOrEqual(4))
    const records = toB.sent.slice()
    await b.receive([...records].reverse())
    await b.receive(records)
    toB.hold = false
    expect(new TextDecoder().decode(await readAll(stream.readable))).toBe('onetwo')
  })

  it('a dropped record stops everything behind it until the same bytes come again', async () => {
    const { a, b, toB } = await pair({}, { onStream: echo })
    toB.hold = true
    const stream = a.openStream('echo', {})
    void write(stream, text('abc'))
    await vi.waitFor(() => expect(toB.sent.length).toBeGreaterThanOrEqual(3))
    const [first, ...rest] = toB.sent.slice()
    await b.receive(rest)
    expect(b.stats().streams).toBe(0)
    // A resend is what replay() hands back: the very bytes.
    const again = a.replay(first.seq).map((wire) => createRecordReader().push(wire)[0])
    expect(again[0].box).toEqual(first.box)
    toB.hold = false
    await b.receive([again[0]])
    expect(new TextDecoder().decode(await readAll(stream.readable))).toBe('abc')
  })

  it('a session cut short fails its open streams: a truncation is never a clean end', async () => {
    const { a, b, toA } = await pair({}, {
      onStream: (stream) => {
        stream.respond(200, {})
        void stream.writable.getWriter().write(text('partial')).catch(() => undefined)
      }
    })
    const stream = a.openStream('echo', {})
    await expect(stream.head).resolves.toMatchObject({ status: 200 })
    toA.hold = true
    b.close('gone')
    a.close('the line died')
    await expect(readAll(stream.readable)).rejects.toMatchObject({ code: ABORT.ended })
  })

  it('acks let the sender forget what arrived', async () => {
    const { a } = await pair({}, { onStream: echo })
    const stream = a.openStream('echo', {})
    void write(stream, new Uint8Array(100_000))
    await readAll(stream.readable)
    // All that stays is this end's own last ACK: acks ask for no ack, and are kept so a resend has no gap. Both
    // waited for together: on a slow runner the last data was forgotten before that ACK went out.
    await vi.waitFor(() => {
      expect(a.stats().retained).toBeLessThan(64)
      expect(a.replay(0)).toHaveLength(1)
    })
  })
})

describe('the session', () => {
  it('GOAWAY lets open streams finish, refuses new ones, then ends cleanly', async () => {
    const ended: Array<{ why: string; clean: boolean }> = []
    let far: Seal2Stream | null = null
    const { a, b } = await pair({ onClose: (why, clean) => ended.push({ why, clean }) }, { onStream: (stream) => ((far = stream), stream.respond(200, {})) })
    const stream = a.openStream('echo', {})
    await stream.head
    b.goaway('restarting')
    await vi.waitFor(() => expect(() => a.openStream('echo', {})).toThrow())
    const farStream = far as unknown as Seal2Stream
    void write(farStream, text('last words'))
    void write(stream)
    expect(new TextDecoder().decode(await readAll(stream.readable))).toBe('last words')
    await vi.waitFor(() => expect(ended).toEqual([{ why: 'restarting', clean: true }]))
  })

  it('a stream id used twice ends the session', async () => {
    const { initiator, responder } = await sessions()
    const ended: string[] = []
    const b = createSeal2Connection({ session: responder, role: 'responder', send: () => undefined, onStream: (stream) => stream.respond(200, {}), onClose: (why) => ended.push(why) })
    opened.push(b)
    const open: Frame2 = { kind: 'open', stream: 3, type: 'sink', fields: {} }
    await b.receive([await initiator.seal(encodeFrame2(open)), await initiator.seal(encodeFrame2({ ...open, stream: 1 }))])
    expect(b.closed).toBe(true)
    expect(ended[0]).toMatch(/protocol/)
  })

  it('a peer that goes silent is let go', async () => {
    let now = 1_000
    const ended: string[] = []
    const { a } = await pair({ now: () => now, onClose: (why) => ended.push(why) })
    now += 120_000
    a.tick(now)
    expect(ended[0]).toMatch(/silent/)
  })

  it('refuses streams past the limit', async () => {
    const { a } = await pair({ limits: { maxStreams: 3 } }, { onStream: (stream) => stream.respond(200, {}), limits: { maxStreams: 2 } })
    const streams = [a.openStream('x', {}), a.openStream('x', {}), a.openStream('x', {})]
    await expect(streams[2].head).rejects.toMatchObject({ code: ABORT.busy })
    await expect(streams[0].head).resolves.toMatchObject({ status: 200 })
  })

  it('past its own limit, an opener waits its turn instead of being refused', async () => {
    const { a, toB } = await pair({ limits: { maxStreams: 2 } }, { onStream: echo, limits: { maxStreams: 2 } })
    const answers = Array.from({ length: 7 }, (_, n) => {
      const stream = a.openStream('echo', {})
      void write(stream, text(`n${n}`))
      return readAll(stream.readable).then((bytes) => new TextDecoder().decode(bytes))
    })
    expect(await Promise.all(answers)).toEqual(Array.from({ length: 7 }, (_, n) => `n${n}`))
    // Ids still rose on the wire.
    const opens = toB.sent.length
    expect(opens).toBeGreaterThan(7)
  })

  it('the wire never shows a path, a field or a body', async () => {
    const { a, toB } = await pair({}, { onStream: echo })
    const stream = a.openStream('echo', { ':path': '/api/use/sources/unlock', authorization: 'Bearer canary-token-1234' })
    void write(stream, text('canary-body-5678'))
    await readAll(stream.readable)
    const wire = Buffer.concat(toB.sent.map((record) => encodeRecord(record)))
    for (const canary of ['unlock', 'canary-token', 'canary-body', 'authorization', 'echo']) expect(wire.includes(Buffer.from(canary))).toBe(false)
  })

  it('the far end\'s open streams are what its limit counts, not this end\'s own', async () => {
    const { a, b } = await pair({ onStream: (stream) => stream.respond(200, {}), limits: { maxStreams: 2 } }, { onStream: (stream) => stream.respond(200, {}), limits: { maxStreams: 2 } })
    const mine = [a.openStream('x', {}), a.openStream('x', {})]
    await Promise.all(mine.map((stream) => stream.head))
    // b's own two opens are not refused because a already holds two of a's own on the same session.
    const theirs = [b.openStream('x', {}), b.openStream('x', {})]
    await expect(Promise.all(theirs.map((stream) => stream.head))).resolves.toHaveLength(2)
  })

  it('an answer nobody reads, past its window, is aborted once its reader has been quiet too long', async () => {
    let now = 1_000
    const { a } = await pair(
      { now: () => now, limits: { stallMs: 50_000 } },
      {
        onStream: (stream) => {
          stream.respond(200, {})
          // Its write waits on credit that never comes: the abort (or the teardown) ends it, and that is expected.
          void stream.writable.getWriter().write(new Uint8Array(STREAM_WINDOW + 10)).catch(() => undefined)
        }
      }
    )
    const stream = a.openStream('x', {})
    await stream.head
    await vi.waitFor(() => expect(a.stats().streams).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 100))
    now += 60_000
    a.tick(now)
    await expect(stream.closed).rejects.toMatchObject({ code: ABORT.timeout })
  })

  it('an empty DATA frame is not a frame: it would cost no credit', () => {
    expect(() => encodeFrame2({ kind: 'data', stream: 1, data: new Uint8Array(0) })).toThrow()
    expect(decodeFrame2(Uint8Array.of(3, 0, 0, 0, 1))).toBeNull()
  })
})

describe('sealedFetch and a caller\'s abort', () => {
  it('rejects the way fetch does, with the caller\'s own reason', async () => {
    const { a } = await pair({}, { onStream: () => undefined })
    const stop = new AbortController()
    stop.abort(new DOMException('gave up', 'TimeoutError'))
    await expect(sealedFetch(a, { method: 'GET', path: '/x', signal: stop.signal })).rejects.toMatchObject({ name: 'TimeoutError' })
    const late = new AbortController()
    const asked = sealedFetch(a, { method: 'GET', path: '/y', signal: late.signal })
    late.abort()
    await expect(asked).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('stream kinds', () => {
  it('a kind named for what every object answers to is no kind, either way on the wire', () => {
    for (const kind of ['constructor', 'prototype', '__proto__', 'tostring']) {
      expect(() => encodeFrame2({ kind: 'open', stream: 1, type: kind, fields: {} })).toThrow()
    }
    const raw = Uint8Array.of(1, 0, 0, 0, 1, 11, ...new TextEncoder().encode('constructor'), 0, 0)
    expect(decodeFrame2(raw)).toBeNull()
  })
})

