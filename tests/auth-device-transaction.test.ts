import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { deviceIdFor } from '../src/main/account-v2'
import { legacyDeviceId } from '../registry/src/v2-migrate-routes'
import {
  DEVICE_TRANSACTION_CONTEXT,
  DEVICE_TRANSACTION_PURPOSE,
  DeviceTransactions,
  canonicalDeviceKey,
  deviceIdOf,
  deviceTransactionTranscript,
  hashBrowserSecret,
  hashCsrfToken,
  readDevicePayload,
  type DeviceTransactionsOptions
} from '../registry/src/auth-device-transaction'

/**
 * THE DEVICE-BOUND AUTH TRANSACTION — a key proves possession of itself over
 * a transcript that names one transaction, inside one browser, exactly once.
 * Nothing here attaches a device or issues a session; these tests hold the
 * primitive to that, and to failing closed on every input it did not mint.
 */

const B64U = /^[A-Za-z0-9_-]+$/
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
/** Same decoded bytes, different text: sets an unused trailing bit. Needs a canonical input. */
const withPaddingBit = (value: string): string => value.slice(0, -1) + ALPHABET[ALPHABET.indexOf(value.at(-1)!) + 1]
const secret = (): string => randomBytes(32).toString('base64url')
const AUDIENCE = 'https://auth.cookrew.test'
const CAPACITY = { ok: false, reason: 'capacity' } as const

interface Device {
  jwk: Record<string, string>
  privateKey: KeyObject
  sign: (message: string) => string
}

const ed25519 = (): Device => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    jwk: publicKey.export({ format: 'jwk' }) as Record<string, string>,
    privateKey,
    sign: (message) => sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64url')
  }
}

const p256 = (): Device => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    jwk: publicKey.export({ format: 'jwk' }) as Record<string, string>,
    privateKey,
    sign: (message) => sign('sha256', Buffer.from(message, 'utf8'), privateKey).toString('base64url')
  }
}

interface Browser {
  browserSecret: string
  csrfToken: string
  browserSecretHash: string
  csrfHash: string
}

const browser = (): Browser => {
  const browserSecret = secret()
  const csrfToken = secret()
  return {
    browserSecret,
    csrfToken,
    browserSecretHash: hashBrowserSecret(browserSecret) as string,
    csrfHash: hashCsrfToken(csrfToken) as string
  }
}

const clock = (start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } => {
  let at = start
  return { now: () => at, advance: (ms) => (at += ms) }
}

const store = (options: Partial<DeviceTransactionsOptions> = {}): DeviceTransactions =>
  new DeviceTransactions({ isDeviceRevoked: () => false, audience: AUDIENCE, ...options })

function begin(
  transactions: DeviceTransactions,
  device: Device = ed25519(),
  who: Browser = browser(),
  extra: Record<string, unknown> = {}
) {
  const created = transactions.create({
    device: { publicKeyJwk: device.jwk, ...extra },
    browserSecretHash: who.browserSecretHash,
    csrfHash: who.csrfHash
  })
  if (!created.ok) throw new Error(`create refused: ${created.reason}`)
  return { created, device, who }
}

const proveWith = (transactions: DeviceTransactions, flow: ReturnType<typeof begin>, ...override: [signature?: unknown]) =>
  transactions.prove(flow.created.transactionId, {
    signature: override.length === 0 ? flow.device.sign(flow.created.transcript) : override[0],
    browserSecret: flow.who.browserSecret,
    csrfToken: flow.who.csrfToken
  })

const redeemWith = (transactions: DeviceTransactions, flow: ReturnType<typeof begin>) =>
  transactions.redeem({ state: flow.created.callbackState, browserSecret: flow.who.browserSecret })

describe('provider initiation device binding', () => {
  it('requires the proven device, the original browser and CSRF before consuming it', () => {
    const transactions = store()
    const flow = begin(transactions)
    const bound = { transactionId: flow.created.transactionId, browserSecret: flow.who.browserSecret, csrfToken: flow.who.csrfToken }
    expect(transactions.takeForProvider(bound).ok).toBe(false)
    expect(proveWith(transactions, flow).ok).toBe(true)
    expect(transactions.takeForProvider({ ...bound, browserSecret: secret() }).ok).toBe(false)
    expect(transactions.takeForProvider({ ...bound, csrfToken: secret() }).ok).toBe(false)
    const result = transactions.takeForProvider(bound)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected bound device')
    expect(result.result.device.deviceId).toBe(flow.created.deviceId)
    expect(Object.isFrozen(result.result.device)).toBe(true)
    expect(transactions.takeForProvider(bound).ok).toBe(false)
    expect(redeemWith(transactions, flow).ok).toBe(false)
  })

  it('fails closed on expiration and device revocation', () => {
    const time = clock()
    let revoked = false
    const transactions = store({ now: time.now, ttlMs: 100, isDeviceRevoked: () => revoked })
    const expired = begin(transactions)
    expect(proveWith(transactions, expired).ok).toBe(true)
    time.advance(100)
    expect(transactions.takeForProvider({ transactionId: expired.created.transactionId, browserSecret: expired.who.browserSecret, csrfToken: expired.who.csrfToken }).ok).toBe(false)
    const blocked = begin(transactions)
    expect(proveWith(transactions, blocked).ok).toBe(true)
    revoked = true
    expect(transactions.takeForProvider({ transactionId: blocked.created.transactionId, browserSecret: blocked.who.browserSecret, csrfToken: blocked.who.csrfToken }).ok).toBe(false)
  })
})

describe('device payloads', () => {
  it('accepts Ed25519 and P-256 public JWKs and reduces them to canonical members', () => {
    const ed = ed25519()
    const ec = p256()
    const one = readDevicePayload({ publicKeyJwk: { ...ed.jwk, kid: 'label', use: 'sig' } })
    const two = readDevicePayload({ publicKeyJwk: ec.jwk, name: 'Studio Mac' })
    expect(one?.publicKeyJwk).toEqual({ kty: 'OKP', crv: 'Ed25519', x: ed.jwk.x })
    expect(two?.publicKeyJwk).toEqual({ kty: 'EC', crv: 'P-256', x: ec.jwk.x, y: ec.jwk.y })
    expect(two?.name).toBe('Studio Mac')
    expect(one?.name).toBeNull()
  })

  it('derives the same device id as the desktop and the registry migration', () => {
    const ed = ed25519()
    const ec = p256()
    expect(deviceIdOf(readDevicePayload({ publicKeyJwk: ed.jwk })!.publicKeyJwk)).toBe(deviceIdFor(ed.jwk))
    expect(readDevicePayload({ publicKeyJwk: ed.jwk })!.deviceId).toBe(legacyDeviceId(ed.jwk))
    expect(readDevicePayload({ publicKeyJwk: ec.jwk })!.deviceId).toBe(legacyDeviceId(ec.jwk))
    expect(canonicalDeviceKey({ kty: 'OKP', crv: 'Ed25519', x: ed.jwk.x })).toBe(
      JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: ed.jwk.x })
    )
  })

  it('accepts a claimed device id only when it is the key’s own', () => {
    const ed = ed25519()
    expect(readDevicePayload({ publicKeyJwk: ed.jwk, deviceId: deviceIdFor(ed.jwk) })).not.toBeNull()
    expect(readDevicePayload({ publicKeyJwk: ed.jwk, deviceId: deviceIdFor(ed25519().jwk) })).toBeNull()
    expect(readDevicePayload({ publicKeyJwk: ed.jwk, deviceId: 42 })).toBeNull()
  })

  it('refuses malformed, private, foreign and degenerate keys', () => {
    const ed = ed25519()
    const ec = p256()
    const zero32 = Buffer.alloc(32).toString('base64url')
    const one32 = Buffer.from([1, ...Array(31).fill(0)]).toString('base64url')
    const order8a = Buffer.from('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', 'hex').toString('base64url')
    const order8b = Buffer.from('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', 'hex').toString('base64url')
    const minusOne = Buffer.from('ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', 'hex').toString('base64url')
    const nonCanonicalY = Buffer.from('eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', 'hex').toString('base64url')
    const zeroWithSign = Buffer.from([0, ...Array(30).fill(0), 0x80]).toString('base64url')
    const offCurve = { ...ec.jwk, y: Buffer.from(Buffer.from(ec.jwk.y, 'base64url').map((b, i) => (i === 31 ? b ^ 1 : b))).toString('base64url') }
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' })
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey.export({ format: 'jwk' })
    const privateEd = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })
    const nonCanonicalB64 = { ...ed.jwk, x: withPaddingBit(ed.jwk.x) }
    expect(Buffer.from(nonCanonicalB64.x, 'base64url').equals(Buffer.from(ed.jwk.x, 'base64url'))).toBe(true)
    const crowded: Record<string, string> = { ...ed.jwk }
    for (let i = 0; i < 40; i += 1) crowded[`m${i}`] = 'v'
    for (const bad of [
      null,
      undefined,
      'jwk',
      [],
      {},
      { publicKeyJwk: null },
      { publicKeyJwk: [] },
      { publicKeyJwk: rsa },
      { publicKeyJwk: p384 },
      { publicKeyJwk: privateEd },
      { publicKeyJwk: { ...ec.jwk, d: 'secret' } },
      { publicKeyJwk: { ...ed.jwk, crv: 'X25519' } },
      { publicKeyJwk: { ...ed.jwk, kty: 'EC' } },
      { publicKeyJwk: { ...ed.jwk, x: ed.jwk.x.slice(1) } },
      { publicKeyJwk: { ...ed.jwk, x: `${ed.jwk.x}A` } },
      { publicKeyJwk: { ...ed.jwk, x: ed.jwk.x.replace(/./, '+') } },
      { publicKeyJwk: { ...ed.jwk, x: 'x'.repeat(5000) } },
      { publicKeyJwk: { ...ed.jwk, x: 7 } },
      { publicKeyJwk: nonCanonicalB64 },
      { publicKeyJwk: { ...ed.jwk, x: zero32 } },
      { publicKeyJwk: { ...ed.jwk, x: one32 } },
      { publicKeyJwk: { ...ed.jwk, x: zeroWithSign } },
      { publicKeyJwk: { ...ed.jwk, x: order8a } },
      { publicKeyJwk: { ...ed.jwk, x: order8b } },
      { publicKeyJwk: { ...ed.jwk, x: minusOne } },
      { publicKeyJwk: { ...ed.jwk, x: nonCanonicalY } },
      { publicKeyJwk: offCurve },
      { publicKeyJwk: { ...ec.jwk, y: undefined } },
      { publicKeyJwk: { ...ec.jwk, x: Buffer.alloc(32, 0xff).toString('base64url') } },
      { publicKeyJwk: crowded }
    ]) expect(readDevicePayload(bad), JSON.stringify(bad)?.slice(0, 120)).toBeNull()
  })

  it('bounds the device name and normalizes control, format and bidi characters', () => {
    const jwk = ed25519().jwk
    const named = (name: unknown) => readDevicePayload({ publicKeyJwk: jwk, name })
    expect(named('a'.repeat(64))?.name).toBe('a'.repeat(64))
    for (const [raw, clean] of [
      ['Studio Mac', 'Studio Mac'],
      ['line\nbreak', 'line break'],
      ['tab\there', 'tab here'],
      ['nul\u0000x', 'nul x'],
      ['del\u007fx', 'del x'],
      ['c1\u0085x', 'c1 x'],
      ['sep\u2028x\u2029y', 'sep x y'],
      ['nbsp\u00a0x\u3000y', 'nbsp x y'],
      ['  padded   name  ', 'padded name'],
      ['rtl\u202eevil', 'rtlevil'],
      ['emb\u202ax\u202c', 'embx'],
      ['iso\u2066x\u2069', 'isox'],
      ['alm\u061cx', 'almx'],
      ['lrm\u200ex\u200f', 'lrmx'],
      ['zw\u200bx\u2060', 'zwx'],
      ['soft\u00adhyphen', 'softhyphen'],
      ['tag\u{E0041}x', 'tagx'],
      ['bom\ufeffx', 'bomx'],
      ['priv\ue000x', 'privx'],
      ['e\u0301', '\u00e9']
    ]) expect(named(raw)?.name, JSON.stringify(raw)).toBe(clean)
    for (const name of ['', '   ', '\u0000', '\u202e\u202c', '\n\t', 'a'.repeat(65), 'x'.repeat(5000), 'lone\ud800', 'lone\udc00x', 7, {}, ['x']]) {
      expect(named(name), JSON.stringify(name)).toBeNull()
    }
  })

  it('signs and returns the normalized name, never the raw one', () => {
    const transactions = store()
    const flow = begin(transactions, ed25519(), browser(), { name: 'pay\u202elap\u202c\nMac' })
    expect(flow.created.transcript.split('\n').at(-1)).toBe(`name:${JSON.stringify('paylap Mac')}`)
    expect(proveWith(transactions, flow).ok).toBe(true)
    const redeemed = redeemWith(transactions, flow)
    if (!redeemed.ok) throw new Error('redeem refused')
    expect(redeemed.result.device.name).toBe('paylap Mac')
  })
})

describe('the binding secrets', () => {
  it('hashes browser secrets and CSRF tokens under distinct domains', () => {
    const value = secret()
    const browserHash = hashBrowserSecret(value)
    const csrfHash = hashCsrfToken(value)
    expect(browserHash).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(csrfHash).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(browserHash).not.toBe(csrfHash)
    expect(browserHash).not.toBe(createHash('sha256').update(value).digest('base64url'))
    expect(hashBrowserSecret(value)).toBe(browserHash)
  })

  it('refuses secrets that cannot carry 256 bits or are unbounded', () => {
    for (const bad of [undefined, null, 7, '', 'short', 'x'.repeat(42), 'x'.repeat(129), '+'.repeat(43), `${secret()}\n`]) {
      expect(hashBrowserSecret(bad)).toBeNull()
      expect(hashCsrfToken(bad)).toBeNull()
    }
  })
})

describe('creating a transaction', () => {
  it('mints a random unique id, a 256-bit challenge and a distinct callback state', () => {
    const transactions = store({ max: 500 })
    const seen = new Set<string>()
    for (let i = 0; i < 200; i += 1) {
      const { created } = begin(transactions)
      expect(created.transactionId).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(Buffer.from(created.challenge, 'base64url').byteLength).toBe(32)
      expect(created.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(created.callbackState).toMatch(/^[A-Za-z0-9_-]{43}$/)
      for (const value of [created.transactionId, created.challenge, created.callbackState]) {
        expect(seen.has(value)).toBe(false)
        seen.add(value)
      }
    }
  })

  it('refuses binding hashes that are malformed or identical', () => {
    const transactions = store()
    const jwk = ed25519().jwk
    const who = browser()
    for (const [browserSecretHash, csrfHash] of [
      [who.browserSecretHash, who.browserSecretHash],
      ['short', who.csrfHash],
      [who.browserSecretHash, 'x'.repeat(44)],
      [undefined, who.csrfHash],
      [who.browserSecretHash, 7],
      ['/'.repeat(43), who.csrfHash]
    ]) {
      expect(transactions.create({ device: { publicKeyJwk: jwk }, browserSecretHash, csrfHash })).toEqual({ ok: false, reason: 'invalid' })
    }
    expect(transactions.create({ device: { publicKeyJwk: { kty: 'RSA' } }, browserSecretHash: who.browserSecretHash, csrfHash: who.csrfHash })).toEqual({ ok: false, reason: 'invalid' })
    expect(transactions.size).toBe(0)
  })

  it('refuses a device the account has already revoked, indistinguishably from malformed input', () => {
    const device = ed25519()
    const transactions = store({ isDeviceRevoked: (id) => id === deviceIdFor(device.jwk) })
    const who = browser()
    expect(transactions.create({ device: { publicKeyJwk: device.jwk }, browserSecretHash: who.browserSecretHash, csrfHash: who.csrfHash })).toEqual({ ok: false, reason: 'invalid' })
    expect(transactions.size).toBe(0)
    expect(begin(transactions).created.ok).toBe(true)
  })

  it('treats any revocation answer other than false as revoked', () => {
    for (const answer of [true, undefined, null, 0, '', 'false', {}]) {
      const transactions = store({ isDeviceRevoked: () => answer as never })
      const who = browser()
      expect(transactions.create({ device: { publicKeyJwk: ed25519().jwk }, browserSecretHash: who.browserSecretHash, csrfHash: who.csrfHash })).toEqual({ ok: false, reason: 'invalid' })
      expect(transactions.size).toBe(0)
    }
  })

  it('fails closed when the revocation check throws', () => {
    const transactions = store({
      isDeviceRevoked: () => {
        throw new Error('store unavailable')
      }
    })
    const who = browser()
    expect(transactions.create({ device: { publicKeyJwk: ed25519().jwk }, browserSecretHash: who.browserSecretHash, csrfHash: who.csrfHash })).toEqual({ ok: false, reason: 'invalid' })
    expect(transactions.size).toBe(0)
  })

  it('holds a bounded number of transactions and refuses rather than evicting', () => {
    const time = clock()
    const transactions = store({ max: 2, ttlMs: 1000, now: time.now })
    const first = begin(transactions)
    begin(transactions)
    const who = browser()
    expect(transactions.create({ device: { publicKeyJwk: ed25519().jwk }, browserSecretHash: who.browserSecretHash, csrfHash: who.csrfHash })).toEqual({ ok: false, reason: 'capacity' })
    expect(proveWith(transactions, first).ok).toBe(true)
    time.advance(1000)
    expect(begin(transactions).created.ok).toBe(true)
    expect(transactions.size).toBe(1)
  })

  it('rejects unsafe limits', () => {
    for (const options of [
      { ttlMs: 0 },
      { ttlMs: -1 },
      { ttlMs: Number.NaN },
      { ttlMs: 1.5 },
      { ttlMs: 16 * 60_000 },
      { max: 0 },
      { max: 1.5 },
      { max: 1_000_001 },
      { maxPerBrowser: 0 },
      { maxPerBrowser: 1.5 },
      { maxPerBrowser: 101 },
      { maxPerBrowser: '3' as never },
      { maxPerDevice: 0 },
      { maxPerDevice: Number.POSITIVE_INFINITY },
      { maxPerDevice: 101 }
    ]) {
      expect(() => store(options), JSON.stringify(options)).toThrow()
    }
    expect(() => new DeviceTransactions({} as DeviceTransactionsOptions)).toThrow()
    expect(() => new DeviceTransactions({ isDeviceRevoked: () => false } as unknown as DeviceTransactionsOptions)).toThrow()
  })
})

describe('the transcript', () => {
  it('is deterministic, domain separated and binds purpose, audience, expiry, the key, its id, the transaction and the challenge', () => {
    const time = clock()
    const transactions = store({ now: time.now, ttlMs: 120_000 })
    const { created, device } = begin(transactions, ed25519(), browser(), { name: 'Laptop' })
    const payload = readDevicePayload({ publicKeyJwk: device.jwk, name: 'Laptop' })!
    const expected = deviceTransactionTranscript({
      audience: AUDIENCE,
      transactionId: created.transactionId,
      challenge: created.challenge,
      expiresAt: created.expiresAt,
      device: payload
    })
    expect(created.transcript).toBe(expected)
    expect(created.expiresAt).toBe(time.now() + 120_000)
    expect(DEVICE_TRANSACTION_PURPOSE).toBe('authenticate-device')
    expect(created.transcript.split('\n')).toEqual([
      DEVICE_TRANSACTION_CONTEXT,
      'purpose:authenticate-device',
      `audience:${AUDIENCE}`,
      `transaction:${created.transactionId}`,
      `challenge:${created.challenge}`,
      `expires:${created.expiresAt}`,
      `device:${deviceIdFor(device.jwk)}`,
      `key:${canonicalDeviceKey(payload.publicKeyJwk)}`,
      `name:${JSON.stringify('Laptop')}`
    ])
    expect(created.deviceId).toBe(deviceIdFor(device.jwk))
    expect(DEVICE_TRANSACTION_CONTEXT).toMatch(/^cookrew-auth\//)
  })
})

describe('proving possession', () => {
  for (const [label, make] of [
    ['Ed25519', ed25519],
    ['P-256', p256]
  ] as const) {
    it(`accepts a ${label} signature over the transcript exactly once`, () => {
      const transactions = store()
      const flow = begin(transactions, make())
      expect(proveWith(transactions, flow)).toEqual({ ok: true, deviceId: flow.created.deviceId })
      expect(proveWith(transactions, flow)).toEqual({ ok: false, reason: 'wrong_phase' })
      const redeemed = redeemWith(transactions, flow)
      expect(redeemed.ok).toBe(true)
      if (!redeemed.ok) return
      expect(redeemed.result.device.deviceId).toBe(flow.created.deviceId)
      expect(redeemed.result.transactionId).toBe(flow.created.transactionId)
    })
  }

  it('takes the device payload as it stood at creation', () => {
    const transactions = store()
    const device = ed25519()
    const other = ed25519()
    const who = browser()
    const input = { publicKeyJwk: { ...device.jwk }, name: 'Original' }
    const created = transactions.create({ device: input, browserSecretHash: who.browserSecretHash, csrfHash: who.csrfHash })
    if (!created.ok) throw new Error('refused')
    input.publicKeyJwk.x = other.jwk.x
    input.name = 'Renamed'
    expect(created.transcript).toContain(device.jwk.x)
    expect(created.transcript).not.toContain('Renamed')
    const forged = transactions.prove(created.transactionId, {
      signature: other.sign(created.transcript.replace(device.jwk.x, other.jwk.x)),
      browserSecret: who.browserSecret,
      csrfToken: who.csrfToken
    })
    expect(forged).toEqual({ ok: false, reason: 'bad_proof' })
  })

  it('returns a frozen device that cannot be altered afterwards', () => {
    const transactions = store()
    const flow = begin(transactions, ed25519(), browser(), { name: 'Desk' })
    expect(proveWith(transactions, flow).ok).toBe(true)
    const redeemed = redeemWith(transactions, flow)
    if (!redeemed.ok) throw new Error('redeem refused')
    expect(Object.isFrozen(redeemed.result)).toBe(true)
    expect(Object.isFrozen(redeemed.result.device)).toBe(true)
    expect(Object.isFrozen(redeemed.result.device.publicKeyJwk)).toBe(true)
    expect(redeemed.result.device).toEqual({ publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: flow.device.jwk.x }, deviceId: flow.created.deviceId, name: 'Desk' })
    expect(Object.keys(redeemed.result).sort()).toEqual(['device', 'provenAt', 'transactionId'])
  })

  it('refuses a signature by another key and burns the transaction', () => {
    const transactions = store()
    const flow = begin(transactions)
    expect(proveWith(transactions, flow, ed25519().sign(flow.created.transcript))).toEqual({ ok: false, reason: 'bad_proof' })
    expect(proveWith(transactions, flow)).toEqual({ ok: false, reason: 'unknown' })
    expect(redeemWith(transactions, flow).ok).toBe(false)
  })

  it('refuses a signature lifted from another transaction or another protocol', () => {
    const transactions = store()
    const device = ed25519()
    const who = browser()
    const one = begin(transactions, device, who)
    const two = begin(transactions, device, who)
    expect(proveWith(transactions, two, device.sign(one.created.transcript))).toEqual({ ok: false, reason: 'bad_proof' })
    const three = begin(transactions, device, who)
    const hello = `cookrew-hello/1 ${three.created.deviceId} ${three.created.challenge}`
    expect(proveWith(transactions, three, device.sign(hello))).toEqual({ ok: false, reason: 'bad_proof' })
    expect(proveWith(transactions, one).ok).toBe(true)
  })

  it('accepts a P-256 signature as exactly 64 raw P1363 bytes or as canonical DER', () => {
    for (const dsaEncoding of ['ieee-p1363', 'der'] as const) {
      const transactions = store()
      const flow = begin(transactions, p256())
      const signature = sign('sha256', Buffer.from(flow.created.transcript), { key: flow.device.privateKey, dsaEncoding })
      if (dsaEncoding === 'ieee-p1363') expect(signature.byteLength).toBe(64)
      expect(proveWith(transactions, flow, signature.toString('base64url')), dsaEncoding).toEqual({ ok: true, deviceId: flow.created.deviceId })
    }
  })

  it('refuses P-256 signatures that are neither 64-byte P1363 nor canonical DER, or do not verify', () => {
    const minimal = (value: Buffer): Buffer => {
      let start = 0
      while (start < value.byteLength - 1 && value[start] === 0) start += 1
      const trimmed = value.subarray(start)
      return trimmed[0] & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : Buffer.from(trimmed)
    }
    const integer = (content: Buffer): Buffer => Buffer.concat([Buffer.from([0x02, content.byteLength]), content])
    const sequence = (body: Buffer, tag = 0x30): Buffer => Buffer.concat([Buffer.from([tag, body.byteLength]), body])
    const variants: Array<[string, (raw: Buffer) => Buffer | null]> = [
      ['raw, 63 bytes', (raw) => raw.subarray(0, 63)],
      ['raw, 65 bytes', (raw) => Buffer.concat([raw, Buffer.from([0])])],
      ['raw, tampered', (raw) => Buffer.from(raw.map((b, i) => (i === 63 ? b ^ 1 : b)))],
      ['raw, r and s swapped', (raw) => Buffer.concat([raw.subarray(32), raw.subarray(0, 32)])],
      ['raw, zero', () => Buffer.alloc(64)],
      ['DER, r padded with a redundant zero', (raw) => sequence(Buffer.concat([integer(Buffer.concat([Buffer.from([0]), minimal(raw.subarray(0, 32))])), integer(minimal(raw.subarray(32)))]))],
      ['DER, s padded with a redundant zero', (raw) => sequence(Buffer.concat([integer(minimal(raw.subarray(0, 32))), integer(Buffer.concat([Buffer.from([0]), minimal(raw.subarray(32))]))]))],
      ['DER, r as a negative integer', (raw) => (raw[0] & 0x80 ? sequence(Buffer.concat([integer(raw.subarray(0, 32)), integer(minimal(raw.subarray(32)))])) : null)],
      ['DER, long-form length', (raw) => {
        const body = Buffer.concat([integer(minimal(raw.subarray(0, 32))), integer(minimal(raw.subarray(32)))])
        return Buffer.concat([Buffer.from([0x30, 0x81, body.byteLength]), body])
      }],
      ['DER, trailing byte outside', (raw) => Buffer.concat([sequence(Buffer.concat([integer(minimal(raw.subarray(0, 32))), integer(minimal(raw.subarray(32)))])), Buffer.from([0])])],
      ['DER, trailing byte inside', (raw) => sequence(Buffer.concat([integer(minimal(raw.subarray(0, 32))), integer(minimal(raw.subarray(32))), Buffer.from([0])]))],
      ['DER, set tag', (raw) => sequence(Buffer.concat([integer(minimal(raw.subarray(0, 32))), integer(minimal(raw.subarray(32)))]), 0x31)],
      ['DER, one integer', (raw) => sequence(integer(minimal(raw.subarray(0, 32))))],
      ['DER, r and s swapped', (raw) => sequence(Buffer.concat([integer(minimal(raw.subarray(32))), integer(minimal(raw.subarray(0, 32)))]))],
      ['DER, s tampered', (raw) => {
        const s = Buffer.from(raw.subarray(32))
        s[31] ^= 1
        return sequence(Buffer.concat([integer(minimal(raw.subarray(0, 32))), integer(minimal(s))]))
      }]
    ]
    let negativeCovered = false
    for (const [label, mutate] of variants) {
      for (let attempt = 0; attempt < 64; attempt += 1) {
        const transactions = store()
        const flow = begin(transactions, p256())
        const raw = sign('sha256', Buffer.from(flow.created.transcript), { key: flow.device.privateKey, dsaEncoding: 'ieee-p1363' })
        const bad = mutate(raw)
        if (bad === null) continue
        if (label === 'DER, r as a negative integer') negativeCovered = true
        expect(proveWith(transactions, flow, bad.toString('base64url')), label).toEqual({ ok: false, reason: 'bad_proof' })
        break
      }
    }
    expect(negativeCovered).toBe(true)
  })

  it('reads an Ed25519 signature only as its 64 raw bytes', () => {
    const transactions = store()
    const flow = begin(transactions)
    const raw = Buffer.from(flow.device.sign(flow.created.transcript), 'base64url')
    const wrapped = Buffer.concat([Buffer.from([0x30, raw.byteLength]), raw])
    expect(proveWith(transactions, flow, wrapped.toString('base64url'))).toEqual({ ok: false, reason: 'bad_proof' })
  })

  it('refuses malformed signatures', () => {
    for (const bad of [undefined, null, 7, '', 'x'.repeat(5000), '+'.repeat(86), 'A'.repeat(85), 'A'.repeat(88), { sig: 'x' }]) {
      const transactions = store()
      const flow = begin(transactions)
      expect(proveWith(transactions, flow, bad)).toEqual({ ok: false, reason: 'bad_proof' })
    }
    const transactions = store()
    const flow = begin(transactions)
    const good = flow.device.sign(flow.created.transcript)
    const nonCanonical = withPaddingBit(good)
    expect(Buffer.from(nonCanonical, 'base64url').equals(Buffer.from(good, 'base64url'))).toBe(true)
    expect(proveWith(transactions, flow, nonCanonical)).toEqual({ ok: false, reason: 'bad_proof' })
  })

  it('refuses an unknown, malformed or revoked transaction id', () => {
    const transactions = store()
    const flow = begin(transactions)
    for (const id of [secret(), '', 'x'.repeat(5000), 7, null, `${flow.created.transactionId}=`]) {
      expect(transactions.prove(id, { signature: flow.device.sign(flow.created.transcript), browserSecret: flow.who.browserSecret, csrfToken: flow.who.csrfToken })).toEqual({ ok: false, reason: 'unknown' })
    }
    expect(transactions.revoke(flow.created.transactionId)).toBe(true)
    expect(transactions.revoke(flow.created.transactionId)).toBe(false)
    expect(transactions.revoke(42)).toBe(false)
    expect(proveWith(transactions, flow)).toEqual({ ok: false, reason: 'unknown' })
    expect(redeemWith(transactions, flow).ok).toBe(false)
  })

  it('refuses a device revoked after the transaction began', () => {
    const revoked = new Set<string>()
    const transactions = store({ isDeviceRevoked: (id) => revoked.has(id) })
    const flow = begin(transactions)
    revoked.add(flow.created.deviceId)
    expect(proveWith(transactions, flow)).toEqual({ ok: false, reason: 'revoked' })
    expect(transactions.size).toBe(0)
  })

  it('fails after expiry, and expiry is a deletion', () => {
    const time = clock()
    const transactions = store({ ttlMs: 60_000, now: time.now })
    const flow = begin(transactions)
    expect(flow.created.expiresAt).toBe(time.now() + 60_000)
    time.advance(60_000)
    expect(proveWith(transactions, flow)).toEqual({ ok: false, reason: 'expired' })
    expect(proveWith(transactions, flow)).toEqual({ ok: false, reason: 'unknown' })
    expect(transactions.size).toBe(0)
  })
})

describe('the browser binding', () => {
  it('requires the browser secret and CSRF token the transaction was bound to', () => {
    const other = browser()
    const cases: Array<(who: Browser) => { browserSecret: unknown; csrfToken: unknown }> = [
      (who) => ({ browserSecret: other.browserSecret, csrfToken: who.csrfToken }),
      (who) => ({ browserSecret: who.browserSecret, csrfToken: other.csrfToken }),
      (who) => ({ browserSecret: who.csrfToken, csrfToken: who.browserSecret }),
      (who) => ({ browserSecret: undefined, csrfToken: who.csrfToken }),
      (who) => ({ browserSecret: who.browserSecret, csrfToken: 'x'.repeat(5000) })
    ]
    for (const presented of cases) {
      const transactions = store()
      const flow = begin(transactions)
      const signature = flow.device.sign(flow.created.transcript)
      expect(transactions.prove(flow.created.transactionId, { signature, ...presented(flow.who) })).toEqual({ ok: false, reason: 'mismatch' })
      expect(proveWith(transactions, flow).ok).toBe(true)
    }
  })

  it('burns the transaction after repeated binding failures', () => {
    const transactions = store()
    const flow = begin(transactions)
    const signature = flow.device.sign(flow.created.transcript)
    for (let i = 0; i < 5; i += 1) {
      expect(transactions.prove(flow.created.transactionId, { signature, browserSecret: secret(), csrfToken: flow.who.csrfToken })).toEqual({ ok: false, reason: 'mismatch' })
    }
    expect(proveWith(transactions, flow)).toEqual({ ok: false, reason: 'unknown' })
  })

  it('does not accept a signature as a substitute for a binding', () => {
    const transactions = store()
    const flow = begin(transactions)
    expect(transactions.prove(flow.created.transactionId, { signature: flow.device.sign(flow.created.transcript) } as never)).toEqual({ ok: false, reason: 'mismatch' })
  })
})

describe('redeeming the callback', () => {
  it('requires a proof first, without spending the state', () => {
    const transactions = store()
    const flow = begin(transactions)
    expect(redeemWith(transactions, flow)).toEqual({ ok: false, reason: 'wrong_phase' })
    expect(proveWith(transactions, flow).ok).toBe(true)
    expect(redeemWith(transactions, flow).ok).toBe(true)
  })

  it('is single use', () => {
    const transactions = store()
    const flow = begin(transactions)
    expect(proveWith(transactions, flow).ok).toBe(true)
    expect(redeemWith(transactions, flow).ok).toBe(true)
    expect(redeemWith(transactions, flow)).toEqual({ ok: false, reason: 'unknown' })
    expect(transactions.size).toBe(0)
  })

  it('refuses a wrong, foreign or malformed state', () => {
    const transactions = store()
    const one = begin(transactions)
    const two = begin(transactions)
    expect(proveWith(transactions, one).ok).toBe(true)
    expect(proveWith(transactions, two).ok).toBe(true)
    for (const state of [secret(), one.created.transactionId, one.created.challenge, '', 'x'.repeat(5000), 7, null]) {
      expect(transactions.redeem({ state, browserSecret: one.who.browserSecret })).toEqual({ ok: false, reason: 'unknown' })
    }
    expect(transactions.redeem({ state: two.created.callbackState, browserSecret: one.who.browserSecret })).toEqual({ ok: false, reason: 'mismatch' })
    expect(redeemWith(transactions, one).ok).toBe(true)
    expect(redeemWith(transactions, two).ok).toBe(true)
  })

  it('requires the bound browser secret and burns after repeated failures', () => {
    const transactions = store()
    const flow = begin(transactions)
    expect(proveWith(transactions, flow).ok).toBe(true)
    for (let i = 0; i < 4; i += 1) {
      expect(transactions.redeem({ state: flow.created.callbackState, browserSecret: secret() })).toEqual({ ok: false, reason: 'mismatch' })
    }
    expect(transactions.redeem({ state: flow.created.callbackState, browserSecret: flow.who.csrfToken })).toEqual({ ok: false, reason: 'mismatch' })
    expect(redeemWith(transactions, flow)).toEqual({ ok: false, reason: 'unknown' })
  })

  it('refuses a device revoked between proof and callback', () => {
    const revoked = new Set<string>()
    const transactions = store({ isDeviceRevoked: (id) => revoked.has(id) })
    const flow = begin(transactions)
    expect(proveWith(transactions, flow).ok).toBe(true)
    revoked.add(flow.created.deviceId)
    expect(redeemWith(transactions, flow)).toEqual({ ok: false, reason: 'revoked' })
    expect(transactions.size).toBe(0)
  })

  it('fails once the transaction has expired, even after a proof', () => {
    const time = clock()
    const transactions = store({ ttlMs: 60_000, now: time.now })
    const flow = begin(transactions)
    time.advance(30_000)
    expect(proveWith(transactions, flow).ok).toBe(true)
    time.advance(30_000)
    expect(redeemWith(transactions, flow)).toEqual({ ok: false, reason: 'expired' })
    expect(redeemWith(transactions, flow)).toEqual({ ok: false, reason: 'unknown' })
  })

  it('stays atomic when the revocation callback re-enters the store', () => {
    let reenter: (() => void) | null = null
    const transactions = store({
      isDeviceRevoked: () => {
        const run = reenter
        reenter = null
        run?.()
        return false
      }
    })
    const flow = begin(transactions)
    expect(proveWith(transactions, flow).ok).toBe(true)
    let inner: ReturnType<typeof redeemWith> | null = null
    reenter = () => {
      inner = redeemWith(transactions, flow)
    }
    const outer = redeemWith(transactions, flow)
    expect(inner).not.toBeNull()
    expect([outer.ok, (inner as unknown as { ok: boolean }).ok].filter(Boolean)).toHaveLength(1)
  })

  it('never hands out a session or attaches a device', () => {
    const transactions = store()
    const flow = begin(transactions)
    expect(Object.keys(flow.created).sort()).toEqual(['callbackState', 'challenge', 'deviceId', 'expiresAt', 'ok', 'transactionId', 'transcript'])
    expect(proveWith(transactions, flow)).toEqual({ ok: true, deviceId: flow.created.deviceId })
    const redeemed = redeemWith(transactions, flow)
    expect(Object.keys(redeemed).sort()).toEqual(['ok', 'result'])
    if (!redeemed.ok) throw new Error('redeem refused')
    expect(Object.keys(redeemed.result).sort()).toEqual(['device', 'provenAt', 'transactionId'])
    expect(Object.keys(redeemed.result.device).sort()).toEqual(['deviceId', 'name', 'publicKeyJwk'])
  })
})

describe('input hygiene', () => {
  it('matches base64url output only', () => {
    const transactions = store()
    const { created } = begin(transactions)
    expect(B64U.test(created.transactionId)).toBe(true)
  })
})

describe('the audience and purpose', () => {
  it('accepts only an HTTPS origin or a loopback HTTP origin, exactly as serialized', () => {
    for (const audience of ['https://auth.cookrew.test', 'https://example.com:8443', 'https://localhost', 'http://localhost:5173', 'http://127.0.0.1:8080', 'http://[::1]:3000']) {
      expect(() => store({ audience }), audience).not.toThrow()
      expect(store({ audience }).audience).toBe(audience)
    }
    for (const audience of [
      undefined,
      null,
      7,
      {},
      '',
      'auth.cookrew.test',
      'http://auth.cookrew.test',
      'http://127.0.0.2',
      'http://localhost.evil.test',
      'http://0.0.0.0',
      'https://auth.cookrew.test/',
      'https://auth.cookrew.test/path',
      'https://auth.cookrew.test?x=1',
      'https://auth.cookrew.test#x',
      'https://user@auth.cookrew.test',
      'https://AUTH.cookrew.test',
      'https://auth.cookrew.test:443',
      'https://auth.cookrew.test\n',
      ' https://auth.cookrew.test',
      'ftp://auth.cookrew.test',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'null',
      `https://${'a'.repeat(300)}.test`
    ]) {
      expect(() => store({ audience: audience as never }), String(audience)).toThrow()
    }
  })

  it('is fixed at construction and cannot be chosen per request', () => {
    const options = { isDeviceRevoked: () => false, audience: AUDIENCE }
    const transactions = new DeviceTransactions(options)
    options.audience = 'https://evil.test'
    expect(Reflect.set(transactions, 'audience', 'https://evil.test')).toBe(false)
    expect(transactions.audience).toBe(AUDIENCE)
    const device = ed25519()
    const who = browser()
    const created = transactions.create({
      device: { publicKeyJwk: device.jwk },
      browserSecretHash: who.browserSecretHash,
      csrfHash: who.csrfHash,
      audience: 'https://evil.test',
      purpose: 'sign-in',
      expiresAt: 9_999_999_999_999
    } as never)
    if (!created.ok) throw new Error('refused')
    const lines = created.transcript.split('\n')
    expect(lines).toContain(`audience:${AUDIENCE}`)
    expect(lines).toContain('purpose:authenticate-device')
    expect(lines).toContain(`expires:${created.expiresAt}`)
    expect(created.transcript).not.toContain('evil')
    expect(created.transcript).not.toContain('9999999999999')
  })

  it('refuses a signature over a transcript naming another audience, purpose or expiry', () => {
    const tamper: Array<(lines: string[]) => string[]> = [
      (lines) => lines.map((line) => (line.startsWith('audience:') ? 'audience:https://evil.test' : line)),
      (lines) => lines.map((line) => (line.startsWith('purpose:') ? 'purpose:sign-in' : line)),
      (lines) => lines.map((line) => (line.startsWith('expires:') ? `expires:${Number(line.slice(8)) + 60_000}` : line)),
      (lines) => lines.filter((line) => !line.startsWith('audience:')),
      (lines) => lines.filter((line) => !line.startsWith('purpose:')),
      (lines) => lines.filter((line) => !line.startsWith('expires:'))
    ]
    for (const change of tamper) {
      const transactions = store()
      const flow = begin(transactions)
      const forged = change(flow.created.transcript.split('\n')).join('\n')
      expect(forged).not.toBe(flow.created.transcript)
      expect(proveWith(transactions, flow, flow.device.sign(forged))).toEqual({ ok: false, reason: 'bad_proof' })
    }
    const other = store({ audience: 'https://other.cookrew.test' })
    const flow = begin(other)
    expect(flow.created.transcript).toContain('audience:https://other.cookrew.test')
    expect(proveWith(other, flow).ok).toBe(true)
  })

  it('refuses to format a transcript with an invalid audience or expiry', () => {
    const transactions = store()
    const { created, device } = begin(transactions)
    const payload = readDevicePayload({ publicKeyJwk: device.jwk })!
    const base = { audience: AUDIENCE, transactionId: created.transactionId, challenge: created.challenge, expiresAt: created.expiresAt, device: payload }
    expect(deviceTransactionTranscript(base)).toBe(created.transcript)
    for (const bad of [
      { audience: 'http://auth.cookrew.test' },
      { audience: `${AUDIENCE}/` },
      { audience: undefined },
      { expiresAt: 1.5 },
      { expiresAt: Number.NaN },
      { expiresAt: -1 },
      { expiresAt: Number.MAX_SAFE_INTEGER + 2 },
      { expiresAt: '1' }
    ]) expect(() => deviceTransactionTranscript({ ...base, ...bad } as never), JSON.stringify(bad)).toThrow()
  })

  it('needs an integer clock so the signed expiry is exact', () => {
    const transactions = store({ now: () => 1_700_000_000_000.5 })
    const who = browser()
    expect(() => transactions.create({ device: { publicKeyJwk: ed25519().jwk }, browserSecretHash: who.browserSecretHash, csrfHash: who.csrfHash })).toThrow()
    expect(transactions.size).toBe(0)
  })
})

describe('per-browser and per-device limits', () => {
  const open = (transactions: DeviceTransactions, device: Device, who: Browser) =>
    transactions.create({ device: { publicKeyJwk: device.jwk }, browserSecretHash: who.browserSecretHash, csrfHash: who.csrfHash })

  it('allows three open transactions per browser by default and refuses a fourth without evicting', () => {
    const transactions = store()
    const who = browser()
    const flows = [0, 1, 2].map(() => begin(transactions, ed25519(), who))
    expect(open(transactions, ed25519(), who)).toEqual(CAPACITY)
    expect(open(transactions, p256(), who)).toEqual(CAPACITY)
    expect(begin(transactions).created.ok).toBe(true)
    expect(transactions.size).toBe(4)
    for (const flow of flows) {
      expect(proveWith(transactions, flow).ok).toBe(true)
      expect(redeemWith(transactions, flow).ok).toBe(true)
    }
  })

  it('allows three open transactions per device by default, across browsers', () => {
    const transactions = store()
    const device = p256()
    const flows = [0, 1, 2].map(() => begin(transactions, device, browser()))
    expect(open(transactions, device, browser())).toEqual(CAPACITY)
    expect(begin(transactions, p256(), browser()).created.ok).toBe(true)
    for (const flow of flows) {
      expect(proveWith(transactions, flow).ok).toBe(true)
      expect(redeemWith(transactions, flow).ok).toBe(true)
    }
  })

  it('honours configured limits independently', () => {
    const transactions = store({ maxPerBrowser: 1, maxPerDevice: 2 })
    const device = ed25519()
    const who = browser()
    begin(transactions, device, who)
    expect(open(transactions, ed25519(), who)).toEqual(CAPACITY)
    begin(transactions, device, browser())
    expect(open(transactions, device, browser())).toEqual(CAPACITY)
    expect(transactions.size).toBe(2)
  })

  it('still applies the global limit', () => {
    const transactions = store({ max: 2 })
    begin(transactions)
    begin(transactions)
    expect(open(transactions, ed25519(), browser())).toEqual(CAPACITY)
  })

  type Flow = ReturnType<typeof begin>
  const releases: Array<[string, (transactions: DeviceTransactions, flow: Flow) => void]> = [
    ['redeem', (transactions, flow) => {
      expect(proveWith(transactions, flow).ok).toBe(true)
      expect(redeemWith(transactions, flow).ok).toBe(true)
    }],
    ['cancel, twice', (transactions, flow) => {
      expect(transactions.revoke(flow.created.transactionId)).toBe(true)
      expect(transactions.revoke(flow.created.transactionId)).toBe(false)
    }],
    ['bad proof', (transactions, flow) => {
      expect(proveWith(transactions, flow, ed25519().sign(flow.created.transcript))).toEqual({ ok: false, reason: 'bad_proof' })
      expect(proveWith(transactions, flow)).toEqual({ ok: false, reason: 'unknown' })
    }],
    ['binding failures at proof', (transactions, flow) => {
      for (let i = 0; i < 6; i += 1) transactions.prove(flow.created.transactionId, { signature: 'x', browserSecret: secret(), csrfToken: flow.who.csrfToken })
    }],
    ['binding failures at redeem', (transactions, flow) => {
      expect(proveWith(transactions, flow).ok).toBe(true)
      for (let i = 0; i < 6; i += 1) transactions.redeem({ state: flow.created.callbackState, browserSecret: secret() })
    }]
  ]
  for (const [label, release] of releases) {
    it(`frees exactly one slot per browser and per device after ${label}`, () => {
      const transactions = store()
      const device = ed25519()
      const who = browser()
      const flows = [0, 1, 2].map(() => begin(transactions, device, who))
      expect(open(transactions, device, who)).toEqual(CAPACITY)
      release(transactions, flows[0])
      expect(transactions.size).toBe(2)
      const replacement = begin(transactions, device, who)
      expect(open(transactions, device, who)).toEqual(CAPACITY)
      expect(open(transactions, device, browser())).toEqual(CAPACITY)
      expect(open(transactions, ed25519(), who)).toEqual(CAPACITY)
      for (const flow of [flows[1], flows[2], replacement]) expect(proveWith(transactions, flow).ok).toBe(true)
    })
  }

  it('frees the slot of a device revoked mid-transaction', () => {
    const revoked = new Set<string>()
    const transactions = store({ isDeviceRevoked: (id) => revoked.has(id) })
    const who = browser()
    const flows = [0, 1, 2].map(() => begin(transactions, ed25519(), who))
    revoked.add(flows[0].created.deviceId)
    expect(proveWith(transactions, flows[0])).toEqual({ ok: false, reason: 'revoked' })
    expect(begin(transactions, ed25519(), who).created.ok).toBe(true)
    expect(open(transactions, ed25519(), who)).toEqual(CAPACITY)
  })

  it('frees slots on expiry, whether noticed by a request or by the sweep', () => {
    const time = clock()
    const transactions = store({ ttlMs: 1000, now: time.now })
    const device = ed25519()
    const who = browser()
    const first = begin(transactions, device, who)
    time.advance(500)
    const later = [begin(transactions, device, who), begin(transactions, device, who)]
    expect(open(transactions, device, who)).toEqual(CAPACITY)
    time.advance(500)
    expect(proveWith(transactions, first)).toEqual({ ok: false, reason: 'expired' })
    begin(transactions, device, who)
    expect(open(transactions, device, who)).toEqual(CAPACITY)
    time.advance(500)
    expect(transactions.size).toBe(3)
    const fresh = [begin(transactions, device, who), begin(transactions, device, who)]
    expect(open(transactions, device, who)).toEqual(CAPACITY)
    expect(transactions.size).toBe(3)
    for (const flow of later) expect(proveWith(transactions, flow)).toEqual({ ok: false, reason: 'unknown' })
    for (const flow of fresh) expect(proveWith(transactions, flow).ok).toBe(true)
  })

  it('keeps counts exact when the revocation callback re-enters and cancels', () => {
    let reenter: (() => void) | null = null
    const transactions = store({
      isDeviceRevoked: () => {
        const run = reenter
        reenter = null
        run?.()
        return false
      }
    })
    const device = ed25519()
    const who = browser()
    const flows = [0, 1, 2].map(() => begin(transactions, device, who))
    reenter = () => {
      expect(transactions.revoke(flows[0].created.transactionId)).toBe(true)
    }
    expect(proveWith(transactions, flows[0])).toEqual({ ok: false, reason: 'unknown' })
    expect(transactions.revoke(flows[0].created.transactionId)).toBe(false)
    begin(transactions, device, who)
    expect(open(transactions, device, who)).toEqual(CAPACITY)
  })
})

describe('browser WebCrypto signatures', () => {
  const subtle = globalThis.crypto.subtle
  const proveInBrowser = async (algorithm: { name: string; namedCurve?: string }, params: AlgorithmIdentifier | EcdsaParams, length: number) => {
    const pair = (await subtle.generateKey(algorithm as EcKeyGenParams, true, ['sign', 'verify'])) as CryptoKeyPair
    const jwk = await subtle.exportKey('jwk', pair.publicKey)
    const transactions = store()
    const who = browser()
    const created = transactions.create({ device: { publicKeyJwk: jwk, name: 'Browser' }, browserSecretHash: who.browserSecretHash, csrfHash: who.csrfHash })
    if (!created.ok) throw new Error(`create refused: ${created.reason}`)
    const signature = Buffer.from(await subtle.sign(params, pair.privateKey, new TextEncoder().encode(created.transcript)))
    expect(signature.byteLength).toBe(length)
    const proven = transactions.prove(created.transactionId, { signature: signature.toString('base64url'), browserSecret: who.browserSecret, csrfToken: who.csrfToken })
    expect(proven).toEqual({ ok: true, deviceId: created.deviceId })
    expect(transactions.redeem({ state: created.callbackState, browserSecret: who.browserSecret }).ok).toBe(true)
  }

  it('accepts the raw P1363 P-256 signature WebCrypto emits', async () => {
    for (let i = 0; i < 8; i += 1) await proveInBrowser({ name: 'ECDSA', namedCurve: 'P-256' }, { name: 'ECDSA', hash: 'SHA-256' }, 64)
  })

  it('accepts the Ed25519 signature WebCrypto emits', async () => {
    await proveInBrowser({ name: 'Ed25519' }, { name: 'Ed25519' }, 64)
  })

  it('refuses a WebCrypto P-256 signature by another browser key', async () => {
    const pair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const stranger = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const transactions = store()
    const who = browser()
    const created = transactions.create({ device: { publicKeyJwk: await subtle.exportKey('jwk', pair.publicKey) }, browserSecretHash: who.browserSecretHash, csrfHash: who.csrfHash })
    if (!created.ok) throw new Error('refused')
    const signature = Buffer.from(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, stranger.privateKey, new TextEncoder().encode(created.transcript)))
    expect(transactions.prove(created.transactionId, { signature: signature.toString('base64url'), browserSecret: who.browserSecret, csrfToken: who.csrfToken })).toEqual({ ok: false, reason: 'bad_proof' })
  })
})
