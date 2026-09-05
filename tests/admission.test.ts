import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { statSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { admit, refusedRedirect, type AdmissionDeps } from '../src/main/admission'
import {
  admittedDevicesFile,
  createAdmittedDeviceStore,
  readAdmittedDevices
} from '../src/main/admitted-devices'
import { verifyCanvasToken, type RegistryKeys } from '../src/main/canvas-token'
import { createPairingKeyRing } from '../src/main/pairing-key'
import { fakeAccount, tempBase } from './support/idv2'

/** The registry's signing key, and a mint that speaks its wire shape. */
const registry = (): {
  keys: RegistryKeys
  mint: (claims: Record<string, unknown>, over?: { alg?: string }) => string
} => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>
  const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return {
    keys: { jwk, revoked: [] },
    mint: (claims, over = {}) => {
      const head = b64({ alg: over.alg ?? 'EdDSA', typ: 'JWT' })
      const body = b64(claims)
      const key = createPrivateKey({ key: privateKey.export({ format: 'jwk' }) as never, format: 'jwk' })
      const sig = sign(null, Buffer.from(`${head}.${body}`, 'utf8'), key).toString('base64url')
      return `${head}.${body}.${sig}`
    }
  }
}

const NOW = 1_800_000_000_000
const PHONE = 'phone-device-1'

describe('canvas token claims, each refused on its own', () => {
  const account = fakeAccount()
  const reg = registry()
  const good = {
    sub: account.username,
    scope: 'canvas',
    aud: account.deviceId,
    dev: PHONE,
    exp: NOW + 60_000,
    jti: 'jti-1'
  }
  const expectation = {
    username: account.username,
    deviceId: account.deviceId,
    phoneDeviceId: PHONE,
    now: NOW
  }

  it('accepts a token that names this account, this desktop and this phone', () => {
    const result = verifyCanvasToken(reg.mint(good), reg.keys, expectation)
    expect(result.ok).toBe(true)
  })

  it('refuses another account', () => {
    const r = verifyCanvasToken(reg.mint({ ...good, sub: 'mira' }), reg.keys, expectation)
    expect(r).toEqual({ ok: false, reason: 'wrong_account' })
  })

  it('refuses another scope, so a door token cannot open the canvas', () => {
    const r = verifyCanvasToken(reg.mint({ ...good, scope: 'door' }), reg.keys, expectation)
    expect(r).toEqual({ ok: false, reason: 'wrong_scope' })
  })

  it("refuses another Mac's audience — the owner's own token, replayed here", () => {
    const r = verifyCanvasToken(reg.mint({ ...good, aud: 'other-desktop' }), reg.keys, expectation)
    expect(r).toEqual({ ok: false, reason: 'wrong_desktop' })
  })

  it('refuses another phone, so a token cannot be forwarded', () => {
    const r = verifyCanvasToken(reg.mint({ ...good, dev: 'another-phone' }), reg.keys, expectation)
    expect(r).toEqual({ ok: false, reason: 'wrong_phone' })
  })

  it('refuses an expired token, and one expiring exactly now', () => {
    expect(verifyCanvasToken(reg.mint({ ...good, exp: NOW - 1 }), reg.keys, expectation))
      .toEqual({ ok: false, reason: 'expired' })
    expect(verifyCanvasToken(reg.mint({ ...good, exp: NOW }), reg.keys, expectation))
      .toEqual({ ok: false, reason: 'expired' })
  })

  it('refuses a revoked jti', () => {
    const keys: RegistryKeys = { ...reg.keys, revoked: ['jti-1'] }
    expect(verifyCanvasToken(reg.mint(good), keys, expectation))
      .toEqual({ ok: false, reason: 'revoked' })
  })

  it('refuses a signature from any other key', () => {
    const other = registry()
    expect(verifyCanvasToken(other.mint(good), reg.keys, expectation))
      .toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('refuses a tampered payload', () => {
    const token = reg.mint(good)
    const [head, , sig] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ ...good, sub: 'mira' })).toString('base64url')
    expect(verifyCanvasToken(`${head}.${forged}.${sig}`, reg.keys, expectation))
      .toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('never lets the token choose its own algorithm', () => {
    expect(verifyCanvasToken(reg.mint(good, { alg: 'none' }), reg.keys, expectation))
      .toEqual({ ok: false, reason: 'bad_algorithm' })
    expect(verifyCanvasToken(reg.mint(good, { alg: 'HS256' }), reg.keys, expectation))
      .toEqual({ ok: false, reason: 'bad_algorithm' })
  })

  it('refuses anything that is not three non-empty base64url segments', () => {
    for (const bad of ['', 'a.b', 'a.b.c.d', 'a..c', '...', 'not-a-token']) {
      expect(verifyCanvasToken(bad, reg.keys, expectation).ok, bad).toBe(false)
    }
  })

  it('refuses a well-signed token that is missing a claim', () => {
    const { jti: _drop, ...missing } = good
    expect(verifyCanvasToken(reg.mint(missing), reg.keys, expectation))
      .toEqual({ ok: false, reason: 'malformed' })
  })

  it('checks the signature before it reads a claim', () => {
    // Unsigned garbage with every claim wrong still refuses as bad_signature,
    // so a probe cannot learn which claim it got wrong without the key.
    const other = registry()
    const r = verifyCanvasToken(
      other.mint({ ...good, sub: 'mira', scope: 'door', aud: 'x', dev: 'y' }),
      reg.keys,
      expectation
    )
    expect(r).toEqual({ ok: false, reason: 'bad_signature' })
  })
})

describe('admission: token plus presence', () => {
  const account = fakeAccount()
  const reg = registry()
  const claims = {
    sub: account.username,
    scope: 'canvas',
    aud: account.deviceId,
    dev: PHONE,
    exp: NOW + 60_000,
    jti: 'jti-1'
  }
  let temp: { base: string; clean: () => void }
  let ring: ReturnType<typeof createPairingKeyRing>
  let refreshes: number

  const deps = (over: Partial<AdmissionDeps> = {}): AdmissionDeps => ({
    account: () => account,
    keys: async () => reg.keys,
    refreshKeys: async () => {
      refreshes++
      return reg.keys
    },
    admitted: createAdmittedDeviceStore({ base: temp.base, now: () => NOW }),
    acceptsPairingKey: (key) => ring.accepts(key),
    now: () => NOW,
    ...over
  })

  beforeEach(() => {
    temp = tempBase()
    ring = createPairingKeyRing({ now: () => NOW })
    refreshes = 0
  })
  afterEach(() => temp.clean())

  it('admits a good token with the current key, and records the phone', async () => {
    const key = ring.current().key
    const outcome = await admit(
      { token: reg.mint(claims), key, phoneDeviceId: PHONE, phoneName: 'iPhone' },
      deps()
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.firstTime).toBe(true)
    expect(outcome.device).toEqual({
      deviceId: PHONE,
      name: 'iPhone',
      admittedAt: NOW,
      lastSeenAt: NOW
    })
    expect(readAdmittedDevices(temp.base).map((d) => d.deviceId)).toEqual([PHONE])
  })

  it('admits an already-admitted phone with NO key at all', async () => {
    const store = createAdmittedDeviceStore({ base: temp.base, now: () => NOW })
    store.admit({ deviceId: PHONE, name: 'iPhone' })
    const outcome = await admit(
      { token: reg.mint(claims), key: null, phoneDeviceId: PHONE },
      deps()
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.firstTime).toBe(false)
  })

  it('refuses a wrong key with the sentence about two minutes', async () => {
    ring.current()
    const outcome = await admit(
      { token: reg.mint(claims), key: 'ZZZZZZ', phoneDeviceId: PHONE },
      deps()
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.refusal.kind).toBe('key')
    expect(outcome.refusal.sentence).toBe("Not this Mac's key — it changes every two minutes.")
    // Nothing is written for a refused phone.
    expect(readAdmittedDevices(temp.base)).toEqual([])
  })

  it('refuses a bad token with the sentence about this Mac', async () => {
    const other = registry()
    const outcome = await admit(
      { token: other.mint(claims), key: ring.current().key, phoneDeviceId: PHONE },
      deps()
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.refusal.kind).toBe('token')
    expect(outcome.refusal.sentence).toBe(
      'This sign-in is not for this Mac — open it again from cookrew.dev.'
    )
  })

  it('checks the token before the key, so a good key never rescues a bad token', async () => {
    const outcome = await admit(
      { token: reg.mint({ ...claims, aud: 'other' }), key: ring.current().key, phoneDeviceId: PHONE },
      deps()
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.refusal.kind).toBe('token')
  })

  it('refuses when this Mac has no account', async () => {
    const outcome = await admit(
      { token: reg.mint(claims), key: ring.current().key, phoneDeviceId: PHONE },
      deps({ account: () => null })
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.refusal.kind).toBe('token')
  })

  it('refuses when the phone names no device id', async () => {
    const outcome = await admit(
      { token: reg.mint(claims), key: ring.current().key, phoneDeviceId: null },
      deps()
    )
    expect(outcome.ok).toBe(false)
  })

  it('refetches the registry key exactly once when a signature fails', async () => {
    const other = registry()
    await admit(
      { token: reg.mint(claims), key: ring.current().key, phoneDeviceId: PHONE },
      deps({ keys: async () => other.keys, refreshKeys: async () => { refreshes++; return reg.keys } })
    )
    expect(refreshes).toBe(1)
  })

  it('does not refetch when the refusal is a claim, not a signature', async () => {
    await admit(
      { token: reg.mint({ ...claims, scope: 'door' }), key: ring.current().key, phoneDeviceId: PHONE },
      deps()
    )
    expect(refreshes).toBe(0)
  })

  it('refuses when the registry key cannot be reached and none is cached', async () => {
    const outcome = await admit(
      { token: reg.mint(claims), key: ring.current().key, phoneDeviceId: PHONE },
      deps({ keys: async () => null, refreshKeys: async () => null })
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.refusal.kind).toBe('token')
  })

  it('refreshes last-seen on a second admission without duplicating the phone', async () => {
    let clock = NOW
    const store = createAdmittedDeviceStore({ base: temp.base, now: () => clock })
    await admit(
      { token: reg.mint(claims), key: ring.current().key, phoneDeviceId: PHONE, phoneName: 'iPhone' },
      deps({ admitted: store })
    )
    clock = NOW + 90_000
    const again = await admit(
      { token: reg.mint(claims), key: null, phoneDeviceId: PHONE },
      deps({ admitted: store })
    )
    expect(again.ok).toBe(true)
    const devices = readAdmittedDevices(temp.base)
    expect(devices).toHaveLength(1)
    expect(devices[0].admittedAt).toBe(NOW)
    expect(devices[0].lastSeenAt).toBe(NOW + 90_000)
    expect(devices[0].name).toBe('iPhone')
  })
})

describe('the admitted-devices file', () => {
  let temp: { base: string; clean: () => void }
  beforeEach(() => (temp = tempBase()))
  afterEach(() => temp.clean())

  it('is written 0600 — it decides who opens this Mac', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    store.admit({ deviceId: PHONE })
    expect(statSync(admittedDevicesFile(temp.base)).mode & 0o777).toBe(0o600)
  })

  it('reads an absent or corrupt file as nobody admitted, never as a crash', () => {
    expect(readAdmittedDevices(temp.base)).toEqual([])
    const store = createAdmittedDeviceStore({ base: temp.base })
    expect(store.has(PHONE)).toBe(false)
    expect(store.list()).toEqual([])
  })

  it('forgets a phone locally, and says whether there was one to forget', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    store.admit({ deviceId: PHONE })
    expect(store.forget(PHONE)).toBe(true)
    expect(store.forget(PHONE)).toBe(false)
    expect(store.has(PHONE)).toBe(false)
  })

  it('lists the most recently seen phone first', () => {
    let clock = 1000
    const store = createAdmittedDeviceStore({ base: temp.base, now: () => clock })
    store.admit({ deviceId: 'a' })
    clock = 2000
    store.admit({ deviceId: 'b' })
    expect(store.list().map((d) => d.deviceId)).toEqual(['b', 'a'])
  })
})

describe('the refused-key redirect', () => {
  it('sends the phone back to the page that sent it, with the reason', () => {
    expect(refusedRedirect('https://cookrew.dev', 'abc-123')).toBe(
      'https://cookrew.dev/me?refused=key&desktop=abc-123'
    )
  })

  it('escapes the device id and tolerates a trailing slash on the origin', () => {
    expect(refusedRedirect('https://reg.test/', 'a b')).toBe(
      'https://reg.test/me?refused=key&desktop=a%20b'
    )
  })
})
