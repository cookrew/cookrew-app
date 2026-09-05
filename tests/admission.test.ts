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

/**
 * A stand-in for the registry, minting EXACTLY the way registry/src/v2-tokens
 * does: two segments, and the signature over the base64url body STRING rather
 * than over the JSON behind it. Getting that wrong is the one mistake that
 * would pass every test written on this side and fail against the real thing,
 * so the last test in this file checks a token from the registry's own class.
 */
const registry = (): {
  keys: RegistryKeys
  mint: (claims: Record<string, unknown>) => string
} => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    keys: { jwk: publicKey.export({ format: 'jwk' }) as Record<string, unknown>, revoked: [] },
    mint: (claims) => {
      const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
      const key = createPrivateKey({ key: privateKey.export({ format: 'jwk' }) as never, format: 'jwk' })
      return `${body}.${sign(null, Buffer.from(body, 'utf8'), key).toString('base64url')}`
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

  it('refuses a revoked DEVICE id — the list holds both kinds', () => {
    // registry/src/v2-tokens publishes device ids and session jtis in one
    // `revoked` array, so a verifier must not assume the entries are one kind.
    const keys: RegistryKeys = { ...reg.keys, revoked: [PHONE] }
    expect(verifyCanvasToken(reg.mint(good), keys, expectation))
      .toEqual({ ok: false, reason: 'revoked' })
  })

  it('refuses a tampered payload', () => {
    const [, sig] = reg.mint(good).split('.')
    const forged = Buffer.from(JSON.stringify({ ...good, sub: 'mira' })).toString('base64url')
    expect(verifyCanvasToken(`${forged}.${sig}`, reg.keys, expectation))
      .toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('refuses a signature made over the RAW JSON instead of the body segment', () => {
    // The one mistake that would pass a test written only on this side: the
    // registry signs the base64url segment it transmits, not the JSON behind
    // it, and a verifier that checks the other one agrees with nobody.
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const json = JSON.stringify(good)
    const body = Buffer.from(json, 'utf8').toString('base64url')
    const key = createPrivateKey({ key: privateKey.export({ format: 'jwk' }) as never, format: 'jwk' })
    const wrong = sign(null, Buffer.from(json, 'utf8'), key).toString('base64url')
    const keys: RegistryKeys = { jwk: publicKey.export({ format: 'jwk' }) as Record<string, unknown>, revoked: [] }
    expect(verifyCanvasToken(`${body}.${wrong}`, keys, expectation))
      .toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('refuses anything that is not two non-empty segments', () => {
    for (const bad of ['', 'a', 'a.b.c', '.b', 'a.', '..', 'not-a-token']) {
      expect(verifyCanvasToken(bad, reg.keys, expectation).ok, bad).toBe(false)
    }
  })

  it('refuses a well-signed token that is missing a claim', () => {
    const { jti: _drop, ...missing } = good
    expect(verifyCanvasToken(reg.mint(missing), reg.keys, expectation))
      .toEqual({ ok: false, reason: 'malformed' })
  })

  it('agrees with the registry\'s OWN minter, key and all', async () => {
    // The two sides are one format described in two places. This is the only
    // test that can tell whether the descriptions still match.
    const { V2Tokens } = await import('../registry/src/v2-tokens')
    const temp = tempBase()
    try {
      const tokens = new V2Tokens(temp.base)
      const minted = tokens.mintCanvasToken(account.username, PHONE, account.deviceId)
      const keys: RegistryKeys = { jwk: tokens.publicKeyJwk(), revoked: [] }
      const result = verifyCanvasToken(minted.token, keys, { ...expectation, now: Date.now() })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.claims).toMatchObject({
        sub: account.username,
        dev: PHONE,
        scope: 'canvas',
        aud: account.deviceId,
        jti: minted.jti
      })
      // And the registry reads back what it minted, so neither side drifted.
      expect(tokens.verify(minted.token, { scope: 'canvas', aud: account.deviceId })).not.toBeNull()
    } finally {
      temp.clean()
    }
  })

  it('refuses a canvas token minted for another desktop by the real minter', async () => {
    const { V2Tokens } = await import('../registry/src/v2-tokens')
    const temp = tempBase()
    try {
      const tokens = new V2Tokens(temp.base)
      const other = fakeAccount()
      const minted = tokens.mintCanvasToken(account.username, PHONE, other.deviceId)
      const keys: RegistryKeys = { jwk: tokens.publicKeyJwk(), revoked: [] }
      expect(verifyCanvasToken(minted.token, keys, { ...expectation, now: Date.now() }))
        .toEqual({ ok: false, reason: 'wrong_desktop' })
    } finally {
      temp.clean()
    }
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
