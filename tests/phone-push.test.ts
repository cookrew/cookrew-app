// PHONE PUSH, THE DESKTOP'S HALF (owner, 2026-11-16: the phone gets a real
// background push; cookrew.dev must not see what it says; plan
// docs/hitl-cross-workspace-2026-11-15 · v6.2 phase 4). The desktop encrypts
// each payload for the phone's subscription (RFC 8291, aes128gcm) and asks the
// registry to forward the ciphertext. The registry only signs and delivers.
import { createDecipheriv, createECDH, createHash, createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { encryptWebPush, MAX_PLAINTEXT, RECORD_SIZE } from '../src/main/web-push-crypto'
import { createPhonePush, PUSH_TTL_S, topicOf, type PhonePushDeps, type PushPayload } from '../src/main/phone-push'

const b64 = (s: string): Buffer => Buffer.from(s, 'base64url')

// RFC 8291, Appendix A.
const VECTOR = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
}

const hmac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest()

/** The phone's side, written apart from the module (RFC 8291 §3.4, RFC 8188), so the test is no echo of it. */
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16)
  const idlen = body[20]
  const asPublic = body.subarray(21, 21 + idlen)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(uaPrivate)
  const uaPublic = ecdh.getPublicKey()
  const secret = ecdh.computeSecret(asPublic)
  const prkKey = hmac(auth, secret)
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]))
  const prk = hmac(salt, ikm)
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16)
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12)
  const record = body.subarray(21 + idlen)
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(record.subarray(record.length - 16))
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()])
  return padded.subarray(0, padded.lastIndexOf(2))
}

describe('RFC 8291 encryption', () => {
  it('matches the RFC test vector byte for byte', () => {
    const body = encryptWebPush(b64(VECTOR.plaintext), b64(VECTOR.uaPublic), b64(VECTOR.auth), {
      salt: b64(VECTOR.salt),
      asPrivate: b64(VECTOR.asPrivate)
    })
    expect(body.toString('base64url')).toBe(VECTOR.body)
  })

  it('a fresh key and salt each time, and the phone can read it', () => {
    const phone = createECDH('prime256v1')
    phone.generateKeys()
    const auth = Buffer.alloc(16, 7)
    const words = Buffer.from(JSON.stringify({ title: 'Atlas needs you' }))
    const a = encryptWebPush(words, phone.getPublicKey(), auth)
    const b = encryptWebPush(words, phone.getPublicKey(), auth)
    expect(a.equals(b)).toBe(false)
    expect(a.readUInt32BE(16)).toBe(RECORD_SIZE)
    expect(decrypt(a, phone.getPrivateKey(), auth).toString()).toBe(words.toString())
  })

  it('refuses keys that are not a P-256 point or a 16-byte secret, and a payload too big for one record', () => {
    const phone = createECDH('prime256v1')
    phone.generateKeys()
    expect(() => encryptWebPush(Buffer.from('x'), Buffer.alloc(65), Buffer.alloc(16))).toThrow()
    expect(() => encryptWebPush(Buffer.from('x'), phone.getPublicKey(), Buffer.alloc(8))).toThrow()
    expect(() => encryptWebPush(Buffer.alloc(RECORD_SIZE), phone.getPublicKey(), Buffer.alloc(16))).toThrow()
  })

  it('the largest payload a push service takes is 3993 bytes: the whole body stays within 4096 (RFC 8291 §4)', () => {
    const phone = createECDH('prime256v1')
    phone.generateKeys()
    expect(MAX_PLAINTEXT).toBe(3993)
    expect(encryptWebPush(Buffer.alloc(MAX_PLAINTEXT), phone.getPublicKey(), Buffer.alloc(16)).length).toBe(4096)
    expect(() => encryptWebPush(Buffer.alloc(MAX_PLAINTEXT + 1), phone.getPublicKey(), Buffer.alloc(16))).toThrow()
  })
})

describe('the phone sender', () => {
  function phone() {
    const ecdh = createECDH('prime256v1')
    ecdh.generateKeys()
    return { ecdh, sub: { id: 's1', p256dh: ecdh.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') } }
  }
  const payload: PushPayload = { v: 1, title: 'Atlas needs you', body: 'in GOAT Team', tag: 'agent:a', machineId: 'm1', workspaceId: 'w1', agentId: 'a' }
  function harness(over: Partial<PhonePushDeps> = {}) {
    const p = phone()
    const sent: { subscription: string; body: string; ttl: number; urgency: string; topic?: string }[] = []
    let clock = 0
    const deps: PhonePushDeps = {
      subscriptions: vi.fn(() => Promise.resolve({ ok: true as const, list: [p.sub] })),
      send: vi.fn((req) => {
        sent.push(req)
        return Promise.resolve('sent' as const)
      }),
      now: () => clock,
      topicKey: Buffer.alloc(32, 9),
      ...over
    }
    return { push: createPhonePush(deps), deps, sent, p, tick: (ms: number) => void (clock += ms) }
  }

  it('sends each subscription the payload, encrypted for it, with what the push service needs', async () => {
    const h = harness()
    await h.push.send(payload, 'high')
    expect(h.sent).toHaveLength(1)
    const { body, ttl, urgency, topic, subscription } = h.sent[0]
    expect({ subscription, ttl, urgency }).toEqual({ subscription: 's1', ttl: PUSH_TTL_S, urgency: 'high' })
    expect(topic).toBe(topicOf('agent:a', Buffer.alloc(32, 9)))
    expect(JSON.parse(decrypt(b64(body), h.p.ecdh.getPrivateKey(), Buffer.alloc(16, 3)).toString())).toEqual(payload)
  })

  it('the registry sees no words: nothing readable leaves in the request', async () => {
    const h = harness()
    await h.push.send(payload, 'normal')
    expect(JSON.stringify(h.sent)).not.toContain('Atlas')
    expect(JSON.stringify(h.sent)).not.toContain('GOAT')
  })

  it('reads the subscriptions once and keeps them a while', async () => {
    const h = harness()
    await h.push.send(payload, 'high')
    await h.push.send(payload, 'high')
    expect(h.deps.subscriptions).toHaveBeenCalledTimes(1)
  })

  it('a subscription the push service has dropped is dropped here too, and the list read again next time', async () => {
    const h = harness({ send: vi.fn(() => Promise.resolve('gone' as const)) })
    await h.push.send(payload, 'high')
    await h.push.send(payload, 'high')
    expect(h.deps.subscriptions).toHaveBeenCalledTimes(2)
  })

  it('a registry with push off is not asked again for a while', async () => {
    const h = harness({ subscriptions: vi.fn(() => Promise.resolve({ ok: false as const, off: true })) })
    await h.push.send(payload, 'high')
    await h.push.send(payload, 'high')
    expect(h.deps.subscriptions).toHaveBeenCalledTimes(1)
    h.tick(31 * 60_000)
    await h.push.send(payload, 'high')
    expect(h.deps.subscriptions).toHaveBeenCalledTimes(2)
  })

  it('no phone subscribed: nothing sent, nothing thrown', async () => {
    const h = harness({ subscriptions: vi.fn(() => Promise.resolve({ ok: true as const, list: [] })) })
    await h.push.send(payload, 'high')
    expect(h.sent).toEqual([])
  })

  it('a bad key on one subscription does not stop the others', async () => {
    const good = phone()
    const h = harness({
      subscriptions: vi.fn(() => Promise.resolve({ ok: true as const, list: [{ id: 'bad', p256dh: 'AAAA', auth: 'AAAA' }, good.sub] }))
    })
    await h.push.send(payload, 'high')
    expect(h.sent.map((s) => s.subscription)).toEqual(['s1'])
  })

  it('a failed read or send never throws into the caller', async () => {
    const h = harness({ subscriptions: vi.fn(() => Promise.reject(new Error('offline'))) })
    await expect(h.push.send(payload, 'high')).resolves.toBeUndefined()
  })

  it('a topic is short, safe and the same for the same tag under one key', () => {
    const key = Buffer.alloc(32, 1)
    expect(topicOf('agent:a', key)).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
    expect(topicOf('agent:a', key)).toBe(topicOf('agent:a', key))
    expect(topicOf('agent:a', key)).not.toBe(topicOf('agent:b', key))
  })

  it('a topic names nobody to the registry or the push service: keyed by a secret only this desktop holds', () => {
    expect(topicOf('agent:a', Buffer.alloc(32, 1))).not.toBe(topicOf('agent:a', Buffer.alloc(32, 2)))
    expect(topicOf('agent:a', Buffer.alloc(32, 1))).not.toBe(createHash('sha256').update('agent:a').digest('base64url').slice(0, 32))
  })
})
