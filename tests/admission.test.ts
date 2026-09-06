import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, statSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { admit, refusedRedirect, type AdmissionDeps } from '../src/main/admission'
import {
  admittedDevicesFile,
  createAdmittedDeviceStore,
  readAdmittedDevices
} from '../src/main/admitted-devices'
import { verifyCanvasToken, type RegistryKeys } from '../src/main/canvas-token'
import { createPairingKeyRing } from '../src/main/pairing-key'
import { createSpentTokenStore } from '../src/main/spent-tokens'
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
    expect(outcome.device).toMatchObject({
      deviceId: PHONE,
      name: 'iPhone',
      admittedAt: NOW,
      lastSeenAt: NOW
    })
    // Its OWN credential, handed over once.
    expect(outcome.token).toMatch(/^[A-Za-z0-9_-]{32,}$/)
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

  it('forgets a phone locally, and is idempotent about it', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    store.admit({ deviceId: PHONE })
    expect(store.forget(PHONE)).toBe(true)
    expect(store.forget(PHONE)).toBe(true)
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

describe('a link that named the Mac instead of the phone', () => {
  const account = fakeAccount()
  const reg = registry()
  let temp: { base: string; clean: () => void }
  let ring: ReturnType<typeof createPairingKeyRing>

  const deps = (): AdmissionDeps => ({
    account: () => account,
    keys: async () => reg.keys,
    refreshKeys: async () => reg.keys,
    admitted: createAdmittedDeviceStore({ base: temp.base, now: () => NOW }),
    acceptsPairingKey: (key) => ring.accepts(key),
    now: () => NOW
  })

  beforeEach(() => {
    temp = tempBase()
    ring = createPairingKeyRing({ now: () => NOW })
  })
  afterEach(() => temp.clean())

  const claims = (dev: string) => ({
    sub: account.username,
    scope: 'canvas',
    aud: account.deviceId,
    dev,
    exp: NOW + 60_000,
    jti: 'j1'
  })

  it('is its own refusal, not a forged-token one', async () => {
    // The link is well-formed, signed, in date and for this Mac. The only
    // thing wrong is which id one query parameter carried, which the person
    // holding the phone can neither see nor fix — so it must not read as a
    // forgery and send them looking in the wrong place.
    const outcome = await admit(
      {
        token: reg.mint(claims(account.deviceId)),
        key: ring.current().key,
        phoneDeviceId: account.deviceId
      },
      deps()
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.refusal.kind).toBe('device')
    expect(outcome.refusal.sentence).toBe(
      'That link named the Mac, not the phone — open it again from cookrew.dev.'
    )
  })

  it('says so before it looks at the key, so a bad key does not mask it', async () => {
    const outcome = await admit(
      { token: reg.mint(claims(account.deviceId)), key: 'ZZZZZZ', phoneDeviceId: account.deviceId },
      deps()
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.refusal.kind).toBe('device')
  })

  it('KEEPS THE STRICT CHECK for every other id', async () => {
    // Tolerance is for the one confusion worth naming, not for any id at all.
    const outcome = await admit(
      { token: reg.mint(claims(PHONE)), key: ring.current().key, phoneDeviceId: 'some-other-device' },
      deps()
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.refusal.kind).toBe('token')
      if (outcome.refusal.kind === 'token') expect(outcome.refusal.reason).toBe('wrong_phone')
    }
  })

  it('admits the phone normally when the ids are right', async () => {
    const outcome = await admit(
      { token: reg.mint(claims(PHONE)), key: ring.current().key, phoneDeviceId: PHONE },
      deps()
    )
    expect(outcome.ok).toBe(true)
  })

  it('sends both refusals back to the page, each naming itself', () => {
    expect(refusedRedirect('https://cookrew.dev', 'abc', 'device')).toBe(
      'https://cookrew.dev/me?refused=device&desktop=abc'
    )
    expect(refusedRedirect('https://cookrew.dev', 'abc')).toBe(
      'https://cookrew.dev/me?refused=key&desktop=abc'
    )
  })
})

describe('forgetting an admitted phone answers the question that was asked', () => {
  let temp: { base: string; clean: () => void }
  beforeEach(() => (temp = tempBase()))
  afterEach(() => temp.clean())

  it('is TRUE for a phone that was there, and true again for one that was not', () => {
    // "Did I rewrite a row" and "is this phone forgotten" are different
    // questions, and only the second is the one the sheet is asking. The old
    // answer reported false while succeeding, and the row came back.
    const store = createAdmittedDeviceStore({ base: temp.base })
    store.admit({ deviceId: PHONE })
    expect(store.forget(PHONE)).toBe(true)
    expect(store.forget(PHONE)).toBe(true)
    expect(store.has(PHONE)).toBe(false)
  })

  it('is true for a phone this Mac never admitted', () => {
    expect(createAdmittedDeviceStore({ base: temp.base }).forget('never-here')).toBe(true)
  })

  it('is FALSE only when the file would not take the change', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    store.admit({ deviceId: PHONE })
    // Readable but not writable: the row can still be seen, so this is a real
    // failure to remove it rather than a "nothing was there" no-op — the one
    // case where the sheet must keep the phone on screen.
    chmodSync(temp.base, 0o500)
    try {
      expect(store.forget(PHONE)).toBe(false)
      expect(store.has(PHONE)).toBe(true)
    } finally {
      chmodSync(temp.base, 0o700)
    }
  })
})

describe('a key that is presented is a key that is checked', () => {
  // THE OWNER WATCHED OPEN SUCCEED ON A KEY THAT DID NOT MATCH. A device this
  // Mac had admitted before skipped the check entirely, so a wrong key was not
  // refused — it was never looked at, which reads exactly like a pass.
  const account = fakeAccount()
  const reg = registry()
  const claims = {
    sub: account.username,
    scope: 'canvas',
    aud: account.deviceId,
    dev: PHONE,
    exp: NOW + 600_000,
    jti: 'j-key'
  }
  let temp: { base: string; clean: () => void }
  let ring: ReturnType<typeof createPairingKeyRing>
  let spent: ReturnType<typeof createSpentTokenStore>
  let lines: string[]

  const deps = (over: Partial<AdmissionDeps> = {}): AdmissionDeps => ({
    account: () => account,
    keys: async () => reg.keys,
    refreshKeys: async () => reg.keys,
    admitted: createAdmittedDeviceStore({ base: temp.base, now: () => NOW }),
    acceptsPairingKey: (key) => ring.accepts(key),
    spend: (jti, exp) => spent.spend(jti, exp),
    log: (message) => lines.push(message),
    now: () => NOW,
    ...over
  })

  /** A phone this Mac has let in before. */
  const alreadyAdmitted = (): void => {
    createAdmittedDeviceStore({ base: temp.base, now: () => NOW }).admit({ deviceId: PHONE })
  }

  beforeEach(() => {
    temp = tempBase()
    ring = createPairingKeyRing({ now: () => NOW })
    spent = createSpentTokenStore({ base: temp.base, now: () => NOW })
    lines = []
  })
  afterEach(() => temp.clean())

  it('REFUSES an admitted device that presents a WRONG key', async () => {
    alreadyAdmitted()
    ring.current()
    const outcome = await admit(
      { token: reg.mint(claims), key: 'ZZZZZZ', phoneDeviceId: PHONE },
      deps()
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.refusal.kind).toBe('key')
    expect(outcome.refusal.sentence).toBe("Not this Mac's key — it changes every two minutes.")
  })

  it('admits an admitted device that presents NO key', async () => {
    alreadyAdmitted()
    const outcome = await admit(
      { token: reg.mint(claims), key: null, phoneDeviceId: PHONE },
      deps()
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.firstTime).toBe(false)
  })

  it('treats an empty ?key= as no key, not as a wrong one', async () => {
    // It carries nothing to check, and refusing it would turn a page that
    // happens to append the parameter into a phone that cannot get in.
    alreadyAdmitted()
    for (const key of ['', '   ']) {
      const outcome = await admit(
        { token: reg.mint({ ...claims, jti: `j-${key.length}` }), key, phoneDeviceId: PHONE },
        deps()
      )
      expect(outcome.ok, JSON.stringify(key)).toBe(true)
    }
  })

  it('refuses a NEW device that presents a wrong key', async () => {
    ring.current()
    const outcome = await admit(
      { token: reg.mint(claims), key: 'ZZZZZZ', phoneDeviceId: PHONE },
      deps()
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.refusal.kind).toBe('key')
  })

  it('admits a NEW device that presents the right key', async () => {
    const outcome = await admit(
      { token: reg.mint(claims), key: ring.current().key, phoneDeviceId: PHONE },
      deps()
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.firstTime).toBe(true)
  })

  it('refuses a NEW device that presents no key at all', async () => {
    const outcome = await admit(
      { token: reg.mint(claims), key: null, phoneDeviceId: PHONE },
      deps()
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.refusal.kind).toBe('key')
  })

  it('takes the PREVIOUS rotation from an admitted device, as from any other', async () => {
    alreadyAdmitted()
    const first = ring.current().key
    ring.current()
    const outcome = await admit(
      { token: reg.mint(claims), key: first, phoneDeviceId: PHONE },
      deps()
    )
    expect(outcome.ok).toBe(true)
  })

  it('DOES NOT BURN THE CANVAS TOKEN on a key refusal, so a retry works', async () => {
    alreadyAdmitted()
    const token = reg.mint(claims)
    const wrong = await admit({ token, key: 'ZZZZZZ', phoneDeviceId: PHONE }, deps())
    expect(wrong.ok).toBe(false)
    expect(spent.spent('j-key')).toBe(false)

    // The same link, with the key read off the screen this time.
    const retry = await admit({ token, key: ring.current().key, phoneDeviceId: PHONE }, deps())
    expect(retry.ok).toBe(true)
    expect(spent.spent('j-key')).toBe(true)
  })

  it('leaves the admission untouched when the key is refused', async () => {
    alreadyAdmitted()
    const before = createAdmittedDeviceStore({ base: temp.base }).list()
    await admit({ token: reg.mint(claims), key: 'ZZZZZZ', phoneDeviceId: PHONE }, deps())
    expect(createAdmittedDeviceStore({ base: temp.base }).list()).toEqual(before)
  })

  it('says one sentence per refusal, with a device prefix and NO KEY MATERIAL', async () => {
    alreadyAdmitted()
    const secret = ring.current().key
    await admit({ token: reg.mint(claims), key: 'ZZZZZZ', phoneDeviceId: PHONE }, deps())
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe('admission refused for phone-de…: the key did not match')
    // Neither the key that was typed nor the one that would have worked.
    expect(lines[0]).not.toContain('ZZZZZZ')
    expect(lines[0]).not.toContain(secret)
    expect(lines[0]).not.toContain('j-key')
  })

  it('says one sentence for a refused token too, and none for a success', async () => {
    const other = registry()
    await admit(
      { token: other.mint(claims), key: ring.current().key, phoneDeviceId: PHONE },
      deps()
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('bad_signature')

    lines = []
    await admit(
      { token: reg.mint(claims), key: ring.current().key, phoneDeviceId: PHONE },
      deps({ log: (message) => lines.push(message) })
    )
    expect(lines).toEqual([])
  })
})
