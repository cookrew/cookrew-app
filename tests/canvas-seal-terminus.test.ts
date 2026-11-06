// THE MAC'S END OF THE SEALED SESSION: one long stream down, short POSTs up, and
// every request and answer inside. The phone here is a real client of the wire;
// only the companion behind the terminus is a fake, so what it received is plain to see.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BridgeCall, BridgeDialer, BridgeResponse } from '../src/main/canvas-bridge'
import {
  createSealTerminus,
  isSealPath,
  routeSeal,
  SEAL_BODY_MS,
  SEAL_DOWN_GRACE_MS,
  SEAL_HANDSHAKES_ALL_PER_MINUTE,
  SEAL_HANDSHAKES_PER_MINUTE,
  SEAL_MAX_SESSIONS,
  SEAL_MAX_STREAMS,
  SEAL_OUTBOX_HARD,
  SEAL_OUTBOX_HIGH,
  SEAL_PING_MS,
  SEAL_SILENT_MS,
  type SealTerminus,
  type SealTerminusDeps
} from '../src/main/canvas-seal-terminus'
import { connectCodeId, newConnectCode, startHandshake } from '../src/shared/canvas-seal'
import { createRecordReader, encodeRecord, type SealFrame } from '../src/shared/canvas-seal-wire'
import { SealPhone as Phone, until } from './support/seal-phone'

interface Inner {
  readonly input: { method: string; path: string; headers: Record<string, string> }
  readonly written: Buffer[]
  ended: boolean
  destroyed: boolean
  answer(status: number, headers?: Record<string, string>): void
  chunk(data: Buffer | string): void
  finish(): void
  fail(message: string): void
  paused: number
  resumed: number
}

/** The companion, as a list of the calls it received. */
function fakeCompanion(autoAnswer: boolean): { dial: BridgeDialer; calls: Inner[] } {
  const calls: Inner[] = []
  const dial: BridgeDialer = (input, onResponse, onError) => {
    let onData: (chunk: Buffer) => void = () => undefined
    let onEnd: () => void = () => undefined
    const inner: Inner = {
      input,
      written: [],
      ended: false,
      destroyed: false,
      paused: 0,
      resumed: 0,
      answer(status, headers = {}) {
        const response: BridgeResponse = {
          status,
          headers,
          onData: (listener) => void (onData = listener),
          onEnd: (listener) => void (onEnd = listener),
          pause: () => void (inner.paused += 1),
          resume: () => void (inner.resumed += 1)
        }
        onResponse(response)
      },
      chunk: (data) => onData(Buffer.from(data)),
      finish: () => onEnd(),
      fail: (message) => onError(new Error(message))
    }
    calls.push(inner)
    const call: BridgeCall = {
      write: (body) => void inner.written.push(body),
      end() {
        inner.ended = true
        if (autoAnswer) {
          inner.answer(200, { 'content-type': 'text/plain' })
          inner.chunk(`you asked ${input.path}`)
          inner.finish()
        }
      },
      destroy: () => void (inner.destroyed = true)
    }
    return call
  }
  return { dial, calls }
}

const open = (stream: number, path = '/api/x', headers: Record<string, string> = {}, method = 'GET'): SealFrame => ({ kind: 'open', stream, method, path, headers })
const end = (stream: number): SealFrame => ({ kind: 'end', stream })

interface Bed {
  readonly origin: string
  readonly code: Uint8Array
  readonly terminus: SealTerminus
  readonly calls: Inner[]
  readonly clock: { now: number }
  phone(): Promise<Phone>
}

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

async function bed(options: { auto?: boolean; deps?: Partial<SealTerminusDeps> } = {}): Promise<Bed> {
  const code = newConnectCode()
  const id = await connectCodeId(code)
  const { dial, calls } = fakeCompanion(options.auto ?? true)
  const clock = { now: 1_800_000_000_000 }
  const terminus = createSealTerminus({ codeFor: (asked) => (asked === id ? code : null), dial, now: () => clock.now, ...options.deps })
  const server = createServer((request, response) => {
    const device = typeof request.headers['x-test-device'] === 'string' ? request.headers['x-test-device'] : 'device-1'
    void terminus.handle(request, response, { base: '/relay/@me/desktop/d', device, deviceName: 'My phone' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    origin,
    code,
    terminus,
    calls,
    clock,
    phone: async () => {
      const phone = new Phone(origin, code)
      await phone.connect()
      return phone
    }
  }
}

describe('the handshake', () => {
  it('refuses a code it does not hold, and says nothing more', async () => {
    const { origin } = await bed()
    const { hello } = await startHandshake(newConnectCode())
    const answer = await fetch(`${origin}/~seal/hello`, { method: 'POST', body: JSON.stringify(hello) })
    expect(answer.status).toBe(403)
  })

  it('refuses what is not a hello', async () => {
    const { origin } = await bed()
    expect((await fetch(`${origin}/~seal/hello`, { method: 'POST', body: 'nope' })).status).toBe(400)
    expect((await fetch(`${origin}/~seal/hello`)).status).toBe(405)
  })

  it('slows a burst of handshakes', async () => {
    const { origin, code } = await bed()
    const { hello } = await startHandshake(code)
    const body = JSON.stringify(hello)
    const statuses: number[] = []
    for (let i = 0; i <= SEAL_HANDSHAKES_PER_MINUTE; i += 1) statuses.push((await fetch(`${origin}/~seal/hello`, { method: 'POST', body })).status)
    expect(statuses.at(-1)).toBe(429)
  })

  it('opens nothing until the phone proves the code', async () => {
    const { origin, code } = await bed()
    const started = await startHandshake(code)
    const hello = (await (await fetch(`${origin}/~seal/hello`, { method: 'POST', body: JSON.stringify(started.hello) })).json()) as { session: string; accept: { e: string; proof: string } }
    expect((await fetch(`${origin}/~seal/down?s=${hello.session}`)).status).toBe(404)
    expect((await fetch(`${origin}/~seal/up?s=${hello.session}`, { method: 'POST', body: '' })).status).toBe(404)
    const forged = await fetch(`${origin}/~seal/finish`, { method: 'POST', body: JSON.stringify({ session: hello.session, proof: Buffer.alloc(32).toString('base64url') }) })
    expect(forged.status).toBe(403)
    const done = await started.finish(hello.accept)
    const real = await fetch(`${origin}/~seal/finish`, { method: 'POST', body: JSON.stringify({ session: hello.session, ...done!.finish }) })
    expect(real.status).toBe(200)
    const again = await fetch(`${origin}/~seal/finish`, { method: 'POST', body: JSON.stringify({ session: hello.session, ...done!.finish }) })
    expect(again.status).toBe(200)
  })

  it('forgets a handshake nobody finished', async () => {
    const { origin, code, terminus, clock } = await bed()
    const started = await startHandshake(code)
    const hello = (await (await fetch(`${origin}/~seal/hello`, { method: 'POST', body: JSON.stringify(started.hello) })).json()) as { session: string; accept: { e: string; proof: string } }
    clock.now += 31_000
    terminus.tick()
    const done = await started.finish(hello.accept)
    expect((await fetch(`${origin}/~seal/finish`, { method: 'POST', body: JSON.stringify({ session: hello.session, ...done!.finish }) })).status).toBe(404)
  })
})

describe('an exchange', () => {
  it('reaches the companion and comes back', async () => {
    const { phone: start, calls } = await bed()
    const phone = await start()
    expect((await phone.send(open(1, '/api/workspace?x=1', { authorization: 'Bearer canary' }), end(1))).status).toBe(204)
    await until(() => phone.of(1).some((frame) => frame.kind === 'end'), 'the answer')
    expect(calls[0].input).toMatchObject({ method: 'GET', path: '/api/workspace?x=1' })
    expect(calls[0].input.headers.authorization).toBe('Bearer canary')
    expect(phone.of(1)[0]).toMatchObject({ kind: 'head', status: 200 })
    expect(phone.text(1)).toBe('you asked /api/workspace?x=1')
  })

  it('names the phone as the relay did: nothing inside can claim a device, a base or a host', async () => {
    const { phone: start, calls } = await bed()
    const phone = await start()
    const forged = { 'x-cookrew-device': 'other', 'x-cookrew-device-name': 'Other', 'x-cookrew-base': '/evil', 'x-cookrew-relay': '0', 'x-forwarded-for': '1.2.3.4', host: 'evil', connection: 'close', 'content-length': '9' }
    await phone.send(open(1, '/api/x', forged), end(1))
    await until(() => calls.length === 1, 'the call')
    const { headers } = calls[0].input
    expect(headers['x-cookrew-device']).toBe('device-1')
    expect(headers['x-cookrew-device-name']).toBe('My phone')
    expect(headers['x-cookrew-base']).toBe('/relay/@me/desktop/d')
    for (const name of ['x-cookrew-relay', 'x-forwarded-for', 'host', 'connection', 'content-length']) expect(headers[name], name).toBeUndefined()
  })

  it('carries a body in pieces', async () => {
    const { phone: start, calls } = await bed()
    const phone = await start()
    await phone.send(open(1, '/api/x', {}, 'POST'), { kind: 'data', stream: 1, data: Buffer.from('one') }, { kind: 'data', stream: 1, data: Buffer.from('two') }, end(1))
    await until(() => calls[0]?.ended === true, 'the body')
    expect(Buffer.concat(calls[0].written).toString()).toBe('onetwo')
  })

  it('streams an answer as it arrives: an event stream is never held to its end', async () => {
    const { phone: start, calls } = await bed({ auto: false })
    const phone = await start()
    await phone.send(open(1, '/api/events'), end(1))
    await until(() => calls.length === 1, 'the call')
    calls[0].answer(200, { 'content-type': 'text/event-stream' })
    calls[0].chunk('data: 1\n\n')
    await until(() => phone.text(1) === 'data: 1\n\n', 'the first event')
    calls[0].chunk('data: 2\n\n')
    await until(() => phone.text(1).endsWith('2\n\n'), 'the second event')
    expect(phone.of(1).some((frame) => frame.kind === 'end')).toBe(false)
  })

  it('carries binary whole, across records', async () => {
    const { phone: start, calls } = await bed({ auto: false })
    const phone = await start()
    await phone.send(open(1), end(1))
    await until(() => calls.length === 1, 'the call')
    const image = Buffer.from(Array.from({ length: 700_000 }, (_, i) => i % 251))
    calls[0].answer(200)
    calls[0].chunk(image)
    calls[0].finish()
    await until(() => phone.of(1).some((frame) => frame.kind === 'end'), 'the image')
    const got = Buffer.concat(phone.of(1).flatMap((frame) => (frame.kind === 'data' ? [Buffer.from(frame.data)] : [])))
    expect(got.equals(image)).toBe(true)
    expect(phone.of(1).filter((frame) => frame.kind === 'data').length).toBeGreaterThan(2)
  })

  it('a bodiless answer ends at its head, and lets its call go', async () => {
    const { phone: start, calls } = await bed({ auto: false })
    const phone = await start()
    await phone.send(open(1), end(1))
    await until(() => calls.length === 1, 'the call')
    calls[0].answer(204)
    await until(() => phone.of(1).some((frame) => frame.kind === 'end'), 'the end')
    expect(calls[0].destroyed).toBe(true)
  })

  it('the phone hanging up stops the companion working', async () => {
    const { phone: start, calls } = await bed({ auto: false })
    const phone = await start()
    await phone.send(open(1, '/api/events'), end(1))
    await until(() => calls.length === 1, 'the call')
    await phone.send({ kind: 'abort', stream: 1, reason: 'gone' })
    await until(() => calls[0].destroyed, 'the call to stop')
  })

  it('a companion failure ends one stream, not the session', async () => {
    const { phone: start, calls } = await bed({ auto: false })
    const phone = await start()
    await phone.send(open(1), end(1), open(2), end(2))
    await until(() => calls.length === 2, 'both calls')
    calls[0].fail('refused')
    await until(() => phone.of(1).some((frame) => frame.kind === 'abort'), 'the abort')
    calls[1].answer(200)
    await until(() => phone.of(2).length === 1, 'the other answer')
  })

  it('a request Node will not build is one refused stream, not a stuck one', async () => {
    const dial: BridgeDialer = () => {
      throw new Error('unescaped characters')
    }
    const { phone: start, terminus } = await bed({ deps: { dial } })
    const phone = await start()
    await phone.send(open(1, '/api/\u4e2d'))
    await until(() => phone.of(1).some((frame) => frame.kind === 'abort'), 'the refusal')
    expect(terminus.stats().sessions).toBe(1)
    await phone.send(open(1))
    await until(() => phone.of(1).filter((frame) => frame.kind === 'abort').length === 2, 'the slot to be free again')
  })

  it.each(['CONNECT', 'TRACE'])('%s is not a thing a page asks of this Mac', async (method) => {
    const { phone: start, calls } = await bed()
    const phone = await start()
    await phone.send(open(1, '/api/x', {}, method))
    await until(() => phone.of(1).some((frame) => frame.kind === 'abort'), 'the refusal')
    expect(calls).toHaveLength(0)
  })

  it('a stream already open cannot be opened again, and there is a limit', async () => {
    const { phone: start, calls } = await bed({ auto: false })
    const phone = await start()
    await phone.send(open(1), open(1))
    await until(() => phone.of(1).some((frame) => frame.kind === 'abort'), 'the refusal')
    expect(calls).toHaveLength(1)
    const many = Array.from({ length: SEAL_MAX_STREAMS }, (_, i) => open(i + 2))
    await phone.send(...many)
    await until(() => phone.frames.filter((frame) => frame.kind === 'abort').length >= 2, 'the limit')
    expect(calls.length).toBeLessThanOrEqual(SEAL_MAX_STREAMS)
  })
})

describe('getting there exactly once', () => {
  it('a resent POST is typed once', async () => {
    const { phone: start, calls } = await bed()
    const phone = await start()
    const records = [await phone.sealed(open(1, '/api/terminal/t/raw', {}, 'POST')), await phone.sealed(end(1))]
    await phone.post(...records)
    expect((await phone.post(...records)).status).toBe(204)
    await until(() => phone.of(1).some((frame) => frame.kind === 'end'), 'the answer')
    expect(calls).toHaveLength(1)
  })

  it('POSTs that land out of order run in the order they were sealed', async () => {
    const { phone: start, calls } = await bed({ auto: false })
    const phone = await start()
    const first = await phone.sealed(open(1, '/first'))
    const second = await phone.sealed(open(2, '/second'))
    await phone.post(second)
    expect(calls).toHaveLength(0)
    await phone.post(first)
    await until(() => calls.length === 2, 'both')
    expect(calls.map((call) => call.input.path)).toEqual(['/first', '/second'])
  })

  it('says so, sealed, as records arrive', async () => {
    const { phone: start } = await bed()
    const phone = await start()
    await phone.send(open(1), end(1))
    await until(() => phone.frames.some((frame) => frame.kind === 'ack' && frame.next === 2), 'the ack')
  })

  it('a record that does not open is refused, and one too far ahead is a slow down', async () => {
    const { origin, phone: start } = await bed()
    const phone = await start()
    const url = `${origin}/~seal/up?s=${phone.session?.id}`
    expect((await fetch(url, { method: 'POST', body: Buffer.from(encodeRecord({ seq: 0, box: new Uint8Array(32) })) })).status).toBe(400)
    const record = await phone.sealed(open(1))
    expect((await fetch(url, { method: 'POST', body: Buffer.from(encodeRecord({ seq: 100_000, box: record.box })) })).status).toBe(409)
    expect((await fetch(url, { method: 'POST', body: 'garbage!' })).status).toBe(400)
  })

  it('stops at the first forged record: a POST of junk costs one failed open', async () => {
    const { origin, phone: start } = await bed()
    const phone = await start()
    const junk = Array.from({ length: 2000 }, (_, i) => Buffer.from(encodeRecord({ seq: i, box: new Uint8Array(16) })))
    const started = performance.now()
    expect((await fetch(`${origin}/~seal/up?s=${phone.session?.id}`, { method: 'POST', body: Buffer.concat(junk) })).status).toBe(400)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('a body too large gets an answer, not a hang-up', async () => {
    const { origin, phone: start } = await bed()
    const phone = await start()
    const answer = await fetch(`${origin}/~seal/up?s=${phone.session?.id}`, { method: 'POST', body: Buffer.alloc(5 * 1024 * 1024) })
    expect(answer.status).toBe(413)
    expect((await fetch(`${origin}/~seal/hello`, { method: 'POST', body: Buffer.alloc(9000) })).status).toBe(400)
  })

  it('a dropped down stream picks up where it left off, with the same bytes', async () => {
    const { phone: start, calls } = await bed({ auto: false })
    const phone = await start()
    await phone.send(open(1), end(1))
    await until(() => calls.length === 1, 'the call')
    calls[0].answer(200)
    calls[0].chunk('before ')
    await until(() => phone.text(1) === 'before ', 'the first words')
    phone.hangUp()
    calls[0].chunk('during ')
    await new Promise((resolve) => setTimeout(resolve, 30))
    await phone.listen()
    calls[0].chunk('after')
    await until(() => phone.text(1) === 'before during after', 'the rest, in order')
  })

  it('what the phone acknowledged is gone, and nothing else', async () => {
    const { phone: start, terminus } = await bed()
    const phone = await start()
    await phone.send(open(1), end(1))
    await until(() => phone.of(1).some((frame) => frame.kind === 'end'), 'the answer')
    expect(terminus.stats().retained).toBeGreaterThan(0)
    await phone.send({ kind: 'ack', stream: 0, next: phone.inbox?.next() ?? 0 })
    await until(() => terminus.stats().retained < 100, 'the outbox to empty')
  })

  it('an ack past what was sent is a lie, and drops nothing', async () => {
    const { phone: start, terminus } = await bed()
    const phone = await start()
    await phone.send(open(1), end(1))
    await until(() => phone.of(1).some((frame) => frame.kind === 'end'), 'the answer')
    const before = terminus.stats().retained
    await phone.send({ kind: 'ack', stream: 0, next: 1_000_000 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(terminus.stats().retained).toBeGreaterThanOrEqual(before)
  })

  it('a newer down stream replaces the old one', async () => {
    const { origin, phone: start } = await bed()
    const phone = await start()
    const second = await fetch(`${origin}/~seal/down?s=${phone.session?.id}`)
    expect(second.status).toBe(200)
    await phone.send(open(1), end(1))
    const reader = createRecordReader()
    const iterator = (second.body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
    const { value } = await iterator.next()
    expect(reader.push(value as Uint8Array).length).toBeGreaterThan(0)
    await iterator.return?.()
  })
})

describe('keeping it bounded', () => {
  it('pings on the clock, so a dead line is noticed and the relay keeps it open', async () => {
    const { phone: start, terminus, clock } = await bed()
    const phone = await start()
    const pings = (): number => phone.frames.filter((frame) => frame.kind === 'ping').length
    await until(() => pings() === 1, 'the ping that opens the stream')
    terminus.tick()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(pings()).toBe(1)
    clock.now += SEAL_PING_MS
    terminus.tick()
    await until(() => pings() === 2, 'the next ping')
  })

  it('a session nobody listens to ends, and takes its calls with it', async () => {
    const { phone: start, terminus, clock, calls } = await bed({ auto: false })
    const phone = await start()
    await phone.send(open(1, '/api/events'), end(1))
    await until(() => calls.length === 1, 'the call')
    phone.hangUp()
    await until(() => terminus.stats().listening === 0, 'the hang-up')
    clock.now += SEAL_DOWN_GRACE_MS + 1
    terminus.tick()
    expect(calls[0].destroyed).toBe(true)
    expect(terminus.stats().sessions).toBe(0)
    expect((await phone.send(open(2))).status).toBe(404)
  })

  it('only something sealed keeps a session alive: junk POSTs and a held stream do not', async () => {
    const { origin, phone: start, terminus, clock } = await bed()
    const phone = await start()
    const url = `${origin}/~seal/up?s=${phone.session?.id}`
    clock.now += SEAL_SILENT_MS / 2
    await fetch(url, { method: 'POST', body: Buffer.from(encodeRecord({ seq: 0, box: new Uint8Array(32) })) })
    clock.now += SEAL_SILENT_MS / 2 + 1
    terminus.tick()
    expect(terminus.stats().sessions).toBe(0)
  })

  it('a request whose body never ends gives its slot back', async () => {
    const { phone: start, terminus, clock, calls } = await bed({ auto: false })
    const phone = await start()
    await phone.send(open(1, '/api/x', {}, 'POST'))
    await until(() => calls.length === 1, 'the call')
    await phone.send({ kind: 'ping', stream: 0 })
    clock.now += SEAL_BODY_MS + 1
    terminus.tick()
    expect(calls[0].destroyed).toBe(true)
    await until(() => phone.of(1).some((frame) => frame.kind === 'abort'), 'the abort')
  })

  it('an event stream with its request ended runs as long as it likes', async () => {
    const { phone: start, terminus, clock, calls } = await bed({ auto: false })
    const phone = await start()
    await phone.send(open(1, '/api/events'), end(1))
    await until(() => calls.length === 1, 'the call')
    clock.now += SEAL_BODY_MS + 1
    terminus.tick()
    expect(calls[0].destroyed).toBe(false)
  })

  it('what the phone acknowledged is let go of, not just uncounted', async () => {
    const { phone: start, calls, terminus } = await bed({ auto: false })
    const phone = await start()
    await phone.send(open(1), end(1))
    await until(() => calls.length === 1, 'the call')
    calls[0].answer(200)
    calls[0].chunk(Buffer.alloc(2 * 1024 * 1024))
    calls[0].finish()
    await until(() => phone.of(1).some((frame) => frame.kind === 'end'), 'the answer')
    expect(terminus.stats().held).toBeGreaterThan(2 * 1024 * 1024)
    await phone.send({ kind: 'ack', stream: 0, next: phone.inbox?.next() ?? 0 })
    await until(() => terminus.stats().held < 1024, 'the bytes to go')
  })

  it('a relay naming a new device each time still meets a ceiling', async () => {
    const { origin, code } = await bed({ deps: { handshakesPerMinute: 2 } })
    const { hello } = await startHandshake(code)
    const statuses: number[] = []
    for (let i = 0; i < SEAL_HANDSHAKES_ALL_PER_MINUTE + 1; i += 1) {
      statuses.push((await fetch(`${origin}/~seal/hello`, { method: 'POST', headers: { 'x-test-device': `d${i}` }, body: JSON.stringify(hello) })).status)
    }
    expect(statuses.at(-1)).toBe(429)
  })

  it('a sealed ping does', async () => {
    const { phone: start, terminus, clock } = await bed()
    const phone = await start()
    clock.now += SEAL_SILENT_MS / 2
    await phone.send({ kind: 'ping', stream: 0 })
    clock.now += SEAL_SILENT_MS / 2 + 1
    terminus.tick()
    expect(terminus.stats().sessions).toBe(1)
  })

  it('an ack without reading does not defeat the wait: bytes stuck on the socket count', async () => {
    const stuck = { writableLength: SEAL_OUTBOX_HIGH + 1 }
    const { phone: start, calls, terminus } = await bed({ auto: false, deps: { socketBacklog: () => stuck.writableLength } })
    const phone = await start()
    await phone.send(open(1), end(1))
    await until(() => calls.length === 1, 'the call')
    calls[0].answer(200)
    calls[0].chunk('x')
    await until(() => calls[0].paused > 0, 'the answer to pause')
    await until(() => phone.text(1) === 'x', 'the record')
    await phone.send({ kind: 'ack', stream: 0, next: phone.inbox?.next() ?? 0 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls[0].resumed).toBe(0)
    stuck.writableLength = 0
    terminus.tick()
    await until(() => calls[0].resumed > 0, 'the answer to resume')
  })

  it('a device that keeps shaking hands slows itself, not the others', async () => {
    const { origin, code } = await bed()
    const { hello } = await startHandshake(code)
    const asDevice = (device: string): Promise<Response> => fetch(`${origin}/~seal/hello`, { method: 'POST', headers: { 'x-test-device': device }, body: JSON.stringify(hello) })
    for (let i = 0; i <= SEAL_HANDSHAKES_PER_MINUTE; i += 1) await asDevice('one')
    expect((await asDevice('one')).status).toBe(429)
    expect((await asDevice('two')).status).toBe(200)
  })

  it('dropping a session spares one that is listening', async () => {
    const { phone: start, clock } = await bed({ deps: { handshakesPerMinute: 1000 } })
    const listening = await start()
    clock.now += 1000
    const quiet: Phone[] = []
    for (let i = 0; i < SEAL_MAX_SESSIONS; i += 1) {
      const phone = await start()
      phone.hangUp()
      quiet.push(phone)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect((await listening.send(open(1))).status).toBe(204)
  })

  it('a fast answer to a slow phone waits, rather than filling this process', async () => {
    const { phone: start, terminus, calls } = await bed({ auto: false })
    const phone = await start()
    await phone.send(open(1), end(1))
    await until(() => calls.length === 1, 'the call')
    calls[0].answer(200)
    calls[0].chunk(Buffer.alloc(SEAL_OUTBOX_HIGH + 1024))
    await until(() => calls[0].paused > 0, 'the answer to pause')
    await until(() => phone.of(1).filter((frame) => frame.kind === 'data').length > 4, 'the records')
    await until(() => (phone.inbox?.next() ?? 0) > 30, 'the phone to read them')
    await phone.send({ kind: 'ack', stream: 0, next: phone.inbox?.next() ?? 0 })
    await until(() => calls[0].resumed > 0, 'the answer to resume')
    expect(terminus.stats().sessions).toBe(1)
  })

  it('past the hard limit the session ends: a source that ignores pause cannot fill memory', async () => {
    const { phone: start, terminus, calls } = await bed({ auto: false })
    const phone = await start()
    await phone.send(open(1), end(1))
    await until(() => calls.length === 1, 'the call')
    phone.hangUp()
    calls[0].answer(200)
    calls[0].chunk(Buffer.alloc(SEAL_OUTBOX_HARD + 1024))
    await until(() => terminus.stats().sessions === 0, 'the session to end')
    expect(calls[0].destroyed).toBe(true)
  })

  it('holds a limited number of sessions, dropping the one quiet longest', async () => {
    const { phone: start, terminus, clock } = await bed({ deps: { handshakesPerMinute: 1000 } })
    const first = await start()
    first.hangUp()
    clock.now += 1000
    for (let i = 0; i < SEAL_MAX_SESSIONS; i += 1) {
      const phone = await start()
      phone.hangUp()
    }
    expect(terminus.stats().sessions).toBe(SEAL_MAX_SESSIONS)
    expect((await first.send(open(1))).status).toBe(404)
  })

  it('close ends everything', async () => {
    const { phone: start, terminus, calls } = await bed({ auto: false })
    const phone = await start()
    await phone.send(open(1), end(1))
    await until(() => calls.length === 1, 'the call')
    terminus.close()
    expect(calls[0].destroyed).toBe(true)
    expect(terminus.stats().sessions).toBe(0)
  })
})

describe('the route', () => {
  it('knows its paths', () => {
    expect(isSealPath('/~seal/up')).toBe(true)
    expect(isSealPath('/~sealed')).toBe(false)
    expect(isSealPath('/api/x')).toBe(false)
  })

  it('only answers what the bridge carried: a LAN peer finds nothing here', async () => {
    const terminus = { handle: vi.fn(async () => undefined) } as unknown as SealTerminus
    const answers: number[] = []
    const response = { writeHead: (status: number) => answers.push(status), end: () => undefined } as never
    await routeSeal({ headers: { 'x-cookrew-relay': '1' }, socket: { remoteAddress: '192.168.1.9' } } as never, response, terminus)
    await routeSeal({ headers: {}, socket: { remoteAddress: '127.0.0.1' } } as never, response, terminus)
    expect(answers).toEqual([404, 404])
    expect(terminus.handle).not.toHaveBeenCalled()
    await routeSeal({ headers: { 'x-cookrew-relay': '1', 'x-cookrew-base': '/b', 'x-cookrew-device': 'd' }, socket: { remoteAddress: '127.0.0.1' } } as never, response, terminus)
    expect(terminus.handle).toHaveBeenCalledWith(expect.anything(), response, { base: '/b', device: 'd', deviceName: undefined })
  })

  it('with no terminus there is no route', async () => {
    const answers: number[] = []
    await routeSeal({ headers: { 'x-cookrew-relay': '1' }, socket: { remoteAddress: '127.0.0.1' } } as never, { writeHead: (status: number) => answers.push(status), end: () => undefined } as never, undefined)
    expect(answers).toEqual([404])
  })
})
