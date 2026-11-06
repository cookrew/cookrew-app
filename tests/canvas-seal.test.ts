// THE CANVAS SEAL: phone and Mac share a session the relay can carry and cannot
// read. The vectors come from node:crypto alone (scripts/canvas-seal-vectors.mjs),
// so these tests compare two implementations, and a native client can use them too.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { acceptHandshake, connectCodeId, newConnectCode, SEAL_RECORD_MAX, startHandshake, type SealHello, type SealSession } from '../src/shared/canvas-seal'
import { createInbox, createRecordReader, decodeFrame, encodeFrame, encodeRecord, SEAL_DATA_MAX, SEAL_INBOX_BYTES, SEAL_WINDOW, type SealFrame } from '../src/shared/canvas-seal-wire'

const vectors = JSON.parse(readFileSync('tests/fixtures/canvas-seal-vectors.json', 'utf8')) as Record<string, string> & { records: Array<{ seq: number; plain: string; toResponder: string; toInitiator: string }> }
const bytes = (hex: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(hex, 'hex'))
const hex = (data: Uint8Array): string => Buffer.from(data).toString('hex')
const b64 = (hexText: string): string => Buffer.from(hexText, 'hex').toString('base64url')
const text = (data: Uint8Array): string => new TextDecoder().decode(data)
const utf8 = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value)

async function pair(code = newConnectCode()): Promise<{ phone: SealSession; mac: SealSession }> {
  const started = await startHandshake(code)
  const accepted = await acceptHandshake(code, started.hello)
  if (accepted === null) throw new Error('refused')
  const done = await started.finish(accepted.accept)
  if (done === null) throw new Error('no proof')
  expect(await accepted.confirm(done.finish)).toBe(true)
  return { phone: done.session, mac: accepted.session }
}

describe('the vectors', () => {
  const fixed = { initiator: bytes(vectors.initiatorPrivate), responder: bytes(vectors.responderPrivate) }

  it('derives the same id, messages and proofs as the second implementation', async () => {
    const code = bytes(vectors.code)
    expect(await connectCodeId(code)).toBe(b64(vectors.id))
    const started = await startHandshake(code, { ephemeral: fixed.initiator })
    expect(started.hello).toEqual({ v: 1, id: b64(vectors.id), e: b64(vectors.initiatorPublic) })
    const accepted = await acceptHandshake(code, started.hello, { ephemeral: fixed.responder })
    expect(accepted?.accept).toEqual({ e: b64(vectors.responderPublic), proof: b64(vectors.proofResponder) })
    const done = await started.finish(accepted!.accept)
    expect(done?.finish).toEqual({ proof: b64(vectors.proofInitiator) })
  })

  it('opens the second implementation’s records, both ways', async () => {
    const code = bytes(vectors.code)
    const started = await startHandshake(code, { ephemeral: fixed.initiator })
    const accepted = await acceptHandshake(code, started.hello, { ephemeral: fixed.responder })
    const done = await started.finish(accepted!.accept)
    for (const record of vectors.records) {
      expect(hex((await accepted!.session.open({ seq: record.seq, box: bytes(record.toResponder) }))!)).toBe(record.plain)
      expect(hex((await done!.session.open({ seq: record.seq, box: bytes(record.toInitiator) }))!)).toBe(record.plain)
    }
  })

  it('seals what the second implementation sealed: the first record goes out as sequence 0', async () => {
    const code = bytes(vectors.code)
    const started = await startHandshake(code, { ephemeral: fixed.initiator })
    const accepted = await acceptHandshake(code, started.hello, { ephemeral: fixed.responder })
    const done = await started.finish(accepted!.accept)
    const first = await done!.session.seal(bytes(vectors.records[0].plain))
    expect(first.seq).toBe(0)
    expect(hex(first.box)).toBe(vectors.records[0].toResponder)
  })
})

describe('the handshake', () => {
  it('gives both sides one session, and the words cross', async () => {
    const { phone, mac } = await pair()
    expect(phone.id).toBe(mac.id)
    expect(text((await mac.open(await phone.seal(utf8('up'))))!)).toBe('up')
    expect(text((await phone.open(await mac.seal(utf8('down'))))!)).toBe('down')
  })

  it('a relay with no code cannot pass for the Mac: its answer proves nothing', async () => {
    const code = newConnectCode()
    const started = await startHandshake(code)
    const stranger = await acceptHandshake(newConnectCode(), started.hello)
    expect(await started.finish(stranger!.accept)).toBeNull()
  })

  it('a relay with no code cannot pass for the phone: the Mac’s session stays shut', async () => {
    const code = newConnectCode()
    const relay = await startHandshake(newConnectCode())
    const accepted = await acceptHandshake(code, { ...relay.hello, id: await connectCodeId(code) })
    const relayDone = await relay.finish({ e: accepted!.accept.e, proof: accepted!.accept.proof })
    expect(relayDone).toBeNull()
    expect(await accepted!.confirm({ proof: Buffer.alloc(32).toString('base64url') })).toBe(false)
  })

  it('swapping either public key in flight fails the proof', async () => {
    const code = newConnectCode()
    const started = await startHandshake(code)
    const middle = await startHandshake(code)
    const accepted = await acceptHandshake(code, { ...started.hello, e: middle.hello.e })
    expect(await started.finish(accepted!.accept)).toBeNull()
  })

  it('a replayed hello opens no old session: every answer has a new key', async () => {
    const code = newConnectCode()
    const started = await startHandshake(code)
    const first = await acceptHandshake(code, started.hello)
    const second = await acceptHandshake(code, started.hello)
    expect(first!.session.id).not.toBe(second!.session.id)
  })

  it('an old proof does not confirm a new session', async () => {
    const code = newConnectCode()
    const started = await startHandshake(code)
    const first = await acceptHandshake(code, started.hello)
    const done = await started.finish(first!.accept)
    const second = await acceptHandshake(code, started.hello)
    expect(await second!.confirm(done!.finish)).toBe(false)
  })

  it('refuses another version, a bad key, a low-order key and a short code', async () => {
    const code = newConnectCode()
    const { hello } = await startHandshake(code)
    expect(await acceptHandshake(code, { ...hello, v: 2 } as unknown as SealHello)).toBeNull()
    expect(await acceptHandshake(code, { ...hello, e: 'nope' })).toBeNull()
    expect(await acceptHandshake(code, { ...hello, e: Buffer.alloc(32).toString('base64url') })).toBeNull()
    expect(await acceptHandshake(code, null as unknown as SealHello)).toBeNull()
    await expect(startHandshake(new Uint8Array(16))).rejects.toThrow('connect code')
  })

  it('a replayed answer gives the same session, never a second one counting from zero', async () => {
    const code = newConnectCode()
    const started = await startHandshake(code)
    const accepted = await acceptHandshake(code, started.hello)
    const [first, second] = await Promise.all([started.finish(accepted!.accept), started.finish(accepted!.accept)])
    expect(second!.session).toBe(first!.session)
    const third = await started.finish(accepted!.accept)
    expect(third!.session).toBe(first!.session)
    await first!.session.seal(utf8('a'))
    expect((await third!.session.seal(utf8('b'))).seq).toBe(1)
  })

  it('a forged answer does not spend the handshake: the real one still lands', async () => {
    const code = newConnectCode()
    const started = await startHandshake(code)
    const accepted = await acceptHandshake(code, started.hello)
    expect(await started.finish({ ...accepted!.accept, proof: Buffer.alloc(32).toString('base64url') })).toBeNull()
    expect(await started.finish(accepted!.accept)).not.toBeNull()
  })

  it('reads one spelling of a value: altered trailing bits are refused', async () => {
    const code = newConnectCode()
    const { hello } = await startHandshake(code)
    const last = hello.id.at(-1)!
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const twin = hello.id.slice(0, -1) + alphabet[alphabet.indexOf(last) + 1]
    expect(await acceptHandshake(code, { ...hello, id: twin })).toBeNull()
  })

  it('a code is 32 random bytes, and its id does not give it away', async () => {
    const a = newConnectCode()
    expect(a).toHaveLength(32)
    expect(hex(a)).not.toBe(hex(newConnectCode()))
    expect(Buffer.from(await connectCodeId(a), 'base64url')).toHaveLength(16)
  })
})

describe('records', () => {
  it('a changed byte, a changed sequence and a record from another session all fail', async () => {
    const { phone, mac } = await pair()
    const record = await phone.seal(utf8('words'))
    const box = Uint8Array.from(record.box)
    box[0] ^= 1
    expect(await mac.open({ seq: record.seq, box })).toBeNull()
    expect(await mac.open({ seq: record.seq + 1, box: record.box })).toBeNull()
    const other = await pair()
    expect(await other.mac.open(record)).toBeNull()
  })

  it('a record cannot be sent back to the side that sealed it', async () => {
    const { phone } = await pair()
    expect(await phone.open(await phone.seal(utf8('mine')))).toBeNull()
  })

  it('carries binary as it is, and an empty record', async () => {
    const { phone, mac } = await pair()
    const raw = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect(hex((await mac.open(await phone.seal(raw)))!)).toBe(hex(raw))
    expect(await mac.open(await phone.seal(new Uint8Array(0)))).toHaveLength(0)
  })

  it('refuses a record too large for the wire', async () => {
    const { phone } = await pair()
    await expect(phone.seal(new Uint8Array(SEAL_RECORD_MAX + 1))).rejects.toThrow('too large')
  })

  it('refuses a sequence no record has', async () => {
    const { phone, mac } = await pair()
    const record = await phone.seal(utf8('x'))
    expect(await mac.open({ seq: 2 ** 64, box: record.box })).toBeNull()
    expect(await mac.open({ seq: -1, box: record.box })).toBeNull()
    expect(await mac.open({ seq: 1.5, box: record.box })).toBeNull()
  })

  it('seals in the order asked, whatever the cipher’s timing', async () => {
    const { phone } = await pair()
    const records = await Promise.all([phone.seal(utf8('a')), phone.seal(utf8('b')), phone.seal(utf8('c'))])
    expect(records.map((record) => record.seq)).toEqual([0, 1, 2])
  })
})

describe('the wire', () => {
  it('reads records however HTTP cuts them', async () => {
    const { phone } = await pair()
    const records = await Promise.all(['one', 'two'].map((word) => phone.seal(utf8(word))))
    const wire = Buffer.concat(records.map(encodeRecord))
    const reader = createRecordReader()
    const seen = [...Array(wire.length).keys()].flatMap((i) => reader.push(wire.subarray(i, i + 1)))
    expect(seen.map((record) => record.seq)).toEqual([0, 1])
    expect(hex(seen[1].box)).toBe(hex(records[1].box))
  })

  it('stops on a length past the limit rather than wait for it', () => {
    const reader = createRecordReader()
    const head = Buffer.alloc(4)
    head.writeUInt32BE(0xffffffff)
    expect(() => reader.push(head)).toThrow('too large')
  })

  it('stays dead after that: nothing past a bad length can be trusted, or kept', () => {
    const reader = createRecordReader()
    const head = Buffer.alloc(4)
    head.writeUInt32BE(0xffffffff)
    expect(() => reader.push(head)).toThrow()
    expect(() => reader.push(new Uint8Array(1))).toThrow()
  })

  it('takes time in the bytes, not their square', () => {
    const one = encodeRecord({ seq: 1, box: new Uint8Array(16) })
    const many = Buffer.concat(Array.from({ length: 150_000 }, () => one))
    const started = performance.now()
    expect(createRecordReader().push(many)).toHaveLength(150_000)
    const big = encodeRecord({ seq: 2, box: new Uint8Array(SEAL_RECORD_MAX) })
    const reader = createRecordReader()
    const seen = [...big.keys()].flatMap((i) => reader.push(big.subarray(i, i + 1)))
    expect(seen).toHaveLength(1)
    expect(performance.now() - started).toBeLessThan(5000)
  })
})

describe('the inbox', () => {
  const inbox = (session: SealSession) => {
    const seen: string[] = []
    return { seen, box: createInbox(session, (plain) => seen.push(text(plain))) }
  }

  it('delivers in sequence, whichever order the requests landed in', async () => {
    const { phone, mac } = await pair()
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((word) => phone.seal(utf8(word))))
    const { seen, box } = inbox(mac)
    await box.accept(c)
    await box.accept(a)
    expect(seen).toEqual(['a'])
    await box.accept(b)
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('a resend is delivered once: a keystroke is typed once', async () => {
    const { phone, mac } = await pair()
    const record = await phone.seal(utf8('key'))
    const { seen, box } = inbox(mac)
    expect(await box.accept(record)).toBe('taken')
    expect(await box.accept(record)).toBe('duplicate')
    expect(seen).toEqual(['key'])
  })

  it('two resends racing are delivered once', async () => {
    const { phone, mac } = await pair()
    const record = await phone.seal(utf8('key'))
    const { seen, box } = inbox(mac)
    await Promise.all([box.accept(record), box.accept(record)])
    expect(seen).toEqual(['key'])
  })

  it('holds nothing it could not open, and nothing past its window', async () => {
    const { phone, mac } = await pair()
    const { seen, box } = inbox(mac)
    expect(await box.accept({ seq: 0, box: new Uint8Array(32) })).toBe('forged')
    expect(await box.accept({ seq: SEAL_WINDOW, box: (await phone.seal(utf8('x'))).box })).toBe('ahead')
    expect(seen).toEqual([])
    expect(box.next()).toBe(0)
  })

  it('a session has one inbox: a second would deliver a replay again', async () => {
    const { mac } = await pair()
    createInbox(mac, () => undefined)
    expect(() => createInbox(mac, () => undefined)).toThrow('one inbox')
  })

  it('withholding one record holds a budget, not a thousand records, and the missing one still lands', async () => {
    const { phone, mac } = await pair()
    const big = new Uint8Array(SEAL_RECORD_MAX)
    const count = Math.ceil(SEAL_INBOX_BYTES / SEAL_RECORD_MAX) + 3
    const records = []
    for (let i = 0; i < count; i += 1) records.push(await phone.seal(big))
    let delivered = 0
    const box = createInbox(mac, () => void (delivered += 1))
    const answers = []
    for (const record of records.slice(1)) answers.push(await box.accept(record))
    expect(answers).toContain('ahead')
    expect(await box.accept(records[0])).toBe('taken')
    expect(delivered).toBeGreaterThan(1)
  })

  it('a handler that throws loses its record, not the ones behind it', async () => {
    const { phone, mac } = await pair()
    const [a, b] = await Promise.all(['a', 'b'].map((word) => phone.seal(utf8(word))))
    const seen: string[] = []
    const failed: unknown[] = []
    const box = createInbox(mac, (plain) => {
      if (text(plain) === 'a') throw new Error('boom')
      seen.push(text(plain))
    }, (error) => failed.push(error))
    await box.accept(b)
    await box.accept(a)
    expect(seen).toEqual(['b'])
    expect(failed).toHaveLength(1)
  })
})

describe('frames', () => {
  const cases: SealFrame[] = [
    { kind: 'open', stream: 1, method: 'POST', path: '/api/x?y=1', headers: { authorization: 'Bearer t' } },
    { kind: 'head', stream: 4294967295, status: 200, headers: { 'content-type': 'image/png' } },
    { kind: 'data', stream: 2, data: Uint8Array.from([0, 255, 10]) },
    { kind: 'end', stream: 2 },
    { kind: 'abort', stream: 3, reason: 'gone' },
    { kind: 'ack', stream: 0, next: 4294967296 },
    { kind: 'ping', stream: 0 }
  ]

  it.each(cases)('$kind survives the wire', (frame) => {
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame)
  })

  it('a full data frame fits one record', async () => {
    const { phone } = await pair()
    const sealed = await phone.seal(encodeFrame({ kind: 'data', stream: 1, data: new Uint8Array(SEAL_DATA_MAX) }))
    expect(sealed.seq).toBe(0)
  })

  it('a peer with the code still cannot smuggle a bad request or answer', () => {
    const open = (value: unknown): SealFrame | null => decodeFrame(Uint8Array.from([1, 0, 0, 0, 1, ...new TextEncoder().encode(JSON.stringify(value))]))
    const head = (value: unknown): SealFrame | null => decodeFrame(Uint8Array.from([2, 0, 0, 0, 1, ...new TextEncoder().encode(JSON.stringify(value))]))
    const good = { method: 'GET', path: '/api/x', headers: {} }
    expect(open(good)).not.toBeNull()
    expect(open({ ...good, path: '//169.254.169.254/x' })).toBeNull()
    expect(open({ ...good, path: 'http://evil/' })).toBeNull()
    expect(open({ ...good, path: '/a\r\nb' })).toBeNull()
    expect(open({ ...good, method: 'GET /x' })).toBeNull()
    expect(open({ ...good, headers: { a: 'b\r\nc: d' } })).toBeNull()
    expect(open({ ...good, headers: { a: 'b\nc: d' } })).toBeNull()
    expect(open({ ...good, headers: { 'a b': 'c' } })).toBeNull()
    expect(open({ ...good, headers: ['a'] })).toBeNull()
    expect(head({ status: 200, headers: {} })).not.toBeNull()
    expect(head({ status: 200, headers: { 'set-cookie': 'a=1\nb=2' } })).not.toBeNull()
    expect(head({ status: 200, headers: { 'set-cookie': 'a=1\r\nb=2' } })).toBeNull()
    expect(head({ status: 1e400, headers: {} })).toBeNull()
    expect(head({ status: -1.5, headers: {} })).toBeNull()
    expect(head({ status: 99, headers: {} })).toBeNull()
  })

  it('reads junk as nothing', () => {
    expect(decodeFrame(new Uint8Array(0))).toBeNull()
    expect(decodeFrame(Uint8Array.from([9, 0, 0, 0, 1]))).toBeNull()
    expect(decodeFrame(Uint8Array.from([1, 0, 0, 0, 1, 123]))).toBeNull()
    expect(decodeFrame(encodeFrame({ kind: 'data', stream: 1, data: new Uint8Array(0) }).subarray(0, 3))).toBeNull()
    const noPath = new TextEncoder().encode(JSON.stringify({ method: 'GET', headers: {} }))
    expect(decodeFrame(Uint8Array.from([1, 0, 0, 0, 1, ...noPath]))).toBeNull()
    const badHeaders = new TextEncoder().encode(JSON.stringify({ status: 200, headers: { a: 1 } }))
    expect(decodeFrame(Uint8Array.from([2, 0, 0, 0, 1, ...badHeaders]))).toBeNull()
  })
})
