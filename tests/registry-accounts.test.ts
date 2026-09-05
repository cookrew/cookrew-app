import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { AccountStore, LinkCodes, readDevice, presentable } from '../registry/src/accounts'
import { LINK_LIMIT, RateLimiter, clientAddress } from '../registry/src/rate-limit'
import { IdentityService, bindStatement, type IdentityConfig } from '../registry/src/identity'
import { jwkThumbprint } from '../registry/src/jwk'
import { parseAttestationObject } from '../registry/src/passkey'
import { platformAuthenticator } from './support/webauthn'

/**
 * ACCOUNTS — a username with devices, and the ceremony that speaks for it.
 *
 * The three properties this file exists to hold down, because each of them is a
 * silent disaster when it goes:
 *
 *   ONE NAME, MANY KEYS. Two machines of one person must both sign in. The old
 *   model refused the second one, and the whole design note is about that.
 *
 *   REVOCATION BITES BEFORE EXPIRY. A token names the device that made it, so a
 *   revoked laptop stops working the moment it is revoked — not when its
 *   ten-minute token happens to run out.
 *
 *   THE LAST DEVICE CANNOT LEAVE. Nobody holds a secret that could bring an
 *   account back, so the store refuses the revocation that would strand it.
 */

const CONFIG: IdentityConfig = {
  rpId: 'localhost',
  origin: 'http://localhost:8790',
  tokenTtlMs: 10 * 60 * 1000,
  challengeTtlMs: 90 * 1000,
  linkTtlMs: 2 * 60 * 1000
}

const b64 = (b: Buffer): string => b.toString('base64url')
const existsSyncSafe = (file: string): boolean => existsSync(file)

const jwkOf = (keys: { publicKey: KeyObject }): Record<string, unknown> =>
  keys.publicKey.export({ format: 'jwk' }) as Record<string, unknown>

/** A device, as one would arrive from a browser or the app. */
function device(kind: 'desktop' | 'phone' | 'browser' = 'desktop', name = 'MacBook') {
  const keys = generateKeyPairSync('ed25519')
  return {
    keys,
    wire: { id: randomUUID(), jwk: jwkOf(keys), kind, name }
  }
}

/** The software ceremony the site and the app both perform. */
function ceremony(keys: { privateKey: KeyObject }, handle: string) {
  const authData = Buffer.concat([
    createHash('sha256').update(CONFIG.rpId).digest(),
    Buffer.from([0x01]),
    Buffer.from([0, 0, 0, 1])
  ])
  return (challenge: string) => {
    const clientData = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', origin: CONFIG.origin, challenge }),
      'utf8'
    )
    return {
      credentialId: handle,
      clientDataJSON: b64(clientData),
      authenticatorData: b64(authData),
      signature: b64(
        sign(null, Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), keys.privateKey)
      )
    }
  }
}

let base = ''
let now = 1_000_000

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'registry-accounts-'))
  now = 1_000_000
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

/* ── the store ───────────────────────────────────────────────────────────── */

describe('AccountStore', () => {
  const store = (): AccountStore => new AccountStore(base, () => now)

  it('mints a handle with its first device, and refuses the second claim', () => {
    const s = store()
    const first = device()
    expect(s.mint('drej', first.wire)).toEqual({
      ok: true,
      handle: 'drej',
      deviceId: first.wire.id
    })
    expect(s.mint('drej', device().wire)).toEqual({ ok: false, reason: 'taken' })
    expect(s.devices('drej')[0].boundBy).toBe('first')
  })

  it('holds a handle to the route-name rule', () => {
    const s = store()
    expect(s.mint('Not A Handle', device().wire).ok).toBe(false)
    expect(s.mint('-leading', device().wire)).toEqual({ ok: false, reason: 'bad_handle' })
    expect(s.mint('a'.repeat(33), device().wire)).toEqual({ ok: false, reason: 'bad_handle' })
  })

  it('refuses a device that is not one', () => {
    const s = store()
    expect(s.mint('drej', { ...device().wire, id: 'not-a-uuid' })).toEqual({
      ok: false,
      reason: 'bad_device'
    })
    expect(s.mint('drej', { ...device().wire, kind: 'toaster' })).toEqual({
      ok: false,
      reason: 'bad_device'
    })
    expect(s.mint('drej', { ...device().wire, name: '   ' })).toEqual({
      ok: false,
      reason: 'bad_device'
    })
    expect(s.mint('drej', { ...device().wire, jwk: { kty: 'RSA', n: 'x', e: 'y' } })).toEqual({
      ok: false,
      reason: 'bad_device'
    })
  })

  it('NEVER stores the private half, even when one is handed over', () => {
    const s = store()
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const careless = keys.privateKey.export({ format: 'jwk' }) as Record<string, unknown>
    expect(careless.d).toBeTypeOf('string')
    expect(s.mint('drej', { id: randomUUID(), jwk: careless, kind: 'browser', name: 'Chrome' }).ok).toBe(true)
    expect(s.devices('drej')[0].jwk.d).toBeUndefined()
    expect(readFileSync(path.join(base, 'accounts.json'), 'utf8')).not.toContain('"d"')
  })

  it('binds a second device and remembers who vouched', () => {
    const s = store()
    const laptop = device()
    s.mint('drej', laptop.wire)
    const phone = device('phone', 'iPhone')
    expect(s.bind('drej', phone.wire, laptop.wire.id)).toEqual({ ok: true, deviceId: phone.wire.id })
    expect(s.active('drej')).toHaveLength(2)
    expect(s.device('drej', phone.wire.id)?.boundBy).toBe(laptop.wire.id)
  })

  it('refuses to re-bind an id it already knows, revoked or not', () => {
    const s = store()
    const laptop = device()
    s.mint('drej', laptop.wire)
    const phone = device('phone')
    s.bind('drej', phone.wire, laptop.wire.id)
    expect(s.bind('drej', phone.wire, laptop.wire.id)).toEqual({ ok: false, reason: 'device_exists' })
    s.revoke('drej', phone.wire.id)
    // Reusing a revoked id would resurrect every token still carrying it.
    expect(s.bind('drej', { ...phone.wire, jwk: jwkOf(generateKeyPairSync('ed25519')) }, laptop.wire.id)).toEqual({
      ok: false,
      reason: 'device_exists'
    })
  })

  it('refuses to bind to an account nobody minted', () => {
    expect(store().bind('nobody', device().wire, 'x')).toEqual({ ok: false, reason: 'no_account' })
  })

  it('revokes a device, keeps its record, and REFUSES to strand an account', () => {
    const s = store()
    const laptop = device()
    s.mint('drej', laptop.wire)
    // One device: revoking it would leave a name nobody can sign for, and no
    // support desk can undo that.
    expect(s.revoke('drej', laptop.wire.id)).toEqual({ ok: false, reason: 'last_device' })
    const phone = device('phone')
    s.bind('drej', phone.wire, laptop.wire.id)
    now += 5
    expect(s.revoke('drej', phone.wire.id)).toEqual({ ok: true })
    expect(s.active('drej')).toHaveLength(1)
    // The record STAYS, with a time on it.
    expect(s.devices('drej')).toHaveLength(2)
    expect(s.device('drej', phone.wire.id)?.revokedAt).toBe(now)
    expect(s.signer('drej', phone.wire.id)).toBeNull()
    expect(s.revoked()).toEqual([phone.wire.id])
    expect(s.isRevoked(phone.wire.id)).toBe(true)
    expect(s.revoke('drej', randomUUID())).toEqual({ ok: false, reason: 'no_device' })
  })

  it('survives a restart', () => {
    const s = store()
    const laptop = device()
    s.mint('drej', laptop.wire)
    expect(new AccountStore(base, () => now).device('drej', laptop.wire.id)?.name).toBe('MacBook')
  })

  it('is an EMPTY store when there is no file, and REFUSES TO START on a torn one', () => {
    // The two must not look the same. No file is a new deployment; a file that
    // will not parse is a deployment whose every revocation would silently
    // revert if it came up empty, and somebody re-minting a handle that
    // already has an owner is not a failure anyone notices in time.
    expect(new AccountStore(base, () => now).handles()).toEqual([])
    const file = path.join(base, 'accounts.json')
    store().mint('drej', device().wire)
    writeFileSync(file, '{ "drej": { "devi')
    expect(() => new AccountStore(base, () => now)).toThrow(/accounts\.json exists but is not readable JSON/)
    // And the sentence names the file, so the page it produces is actionable.
    expect(() => new AccountStore(base, () => now)).toThrow(file)
  })

  it('writes whole, 0600, and leaves no sibling behind', () => {
    const s = store()
    s.mint('drej', device().wire)
    const file = path.join(base, 'accounts.json')
    // 0600: this file decides who may act for an account, and the default
    // 0644 puts that in front of every other user on the host.
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(existsSyncSafe(`${file}.tmp`)).toBe(false)
  })

  it('drops entries a hand edit made nonsense of, and keeps the rest', () => {
    const good = device()
    writeFileSync(
      path.join(base, 'accounts.json'),
      JSON.stringify({
        drej: { devices: [{ ...good.wire, boundBy: 'first', at: 1 }, { id: 'nope' }] },
        'Not A Handle': { devices: [{ ...device().wire, boundBy: 'first', at: 1 }] },
        empty: { devices: [] }
      })
    )
    const s = new AccountStore(base, () => now)
    expect(s.handles()).toEqual(['drej'])
    expect(s.devices('drej')).toHaveLength(1)
  })

  it('migrates the legacy credential map, once, without touching it', () => {
    const s = store()
    const keys = generateKeyPairSync('ed25519')
    expect(s.migrate([{ credentialId: 'drej', jwk: jwkOf(keys) }])).toBe(1)
    expect(s.devices('drej')).toHaveLength(1)
    expect(s.devices('drej')[0]).toMatchObject({ kind: 'browser', boundBy: 'first' })
    // Idempotent, and additive: a second run changes nothing, and a device
    // bound since is not undone.
    s.bind('drej', device('phone').wire, s.devices('drej')[0].id)
    expect(s.migrate([{ credentialId: 'drej', jwk: jwkOf(keys) }])).toBe(0)
    expect(s.devices('drej')).toHaveLength(2)
    // A credential id that could never be a handle is left where it was.
    expect(s.migrate([{ credentialId: 'NOT A HANDLE', jwk: jwkOf(keys) }])).toBe(0)
  })

  it('advances a passkey counter upward only', () => {
    const s = store()
    const laptop = device()
    s.mint('drej', laptop.wire)
    const passkey = { ...device('browser').wire, kind: 'passkey' as const }
    s.bind('drej', passkey, laptop.wire.id, { credentialId: 'cred-abc', signCount: 4 })
    expect(s.device('drej', passkey.id)?.signCount).toBe(4)
    s.recordSignCount('drej', passkey.id, 9)
    expect(s.device('drej', passkey.id)?.signCount).toBe(9)
    // A request that lost a race must not roll the ceiling back and re-open
    // the replay it was meant to close.
    s.recordSignCount('drej', passkey.id, 5)
    s.recordSignCount('drej', passkey.id, -1)
    s.recordSignCount('nobody', passkey.id, 100)
    expect(s.device('drej', passkey.id)?.signCount).toBe(9)
    // And it survives the round trip through the file.
    expect(new AccountStore(base, () => now).device('drej', passkey.id)?.signCount).toBe(9)
  })

  it('finds a passkey by the credential id its authenticator chose', () => {
    const s = store()
    const laptop = device()
    s.mint('drej', laptop.wire)
    const passkey = { ...device('browser').wire, kind: 'passkey' as const }
    s.bind('drej', passkey, laptop.wire.id, { credentialId: 'cred-abc' })
    expect(s.byCredentialId('cred-abc')?.handle).toBe('drej')
    expect(s.byCredentialId('cred-zzz')).toBeNull()
    // The same authenticator cannot be enrolled twice, anywhere.
    s.mint('mira', device().wire)
    const other = s.devices('mira')[0]
    expect(s.bind('mira', device('browser').wire, other.id, { credentialId: 'cred-abc' })).toEqual({
      ok: false,
      reason: 'device_exists'
    })
  })
})

describe('readDevice / presentable', () => {
  it('trims a name and refuses a nameless device', () => {
    const d = device().wire
    expect(readDevice({ ...d, name: '  Work laptop  ' })?.name).toBe('Work laptop')
    expect(readDevice({ ...d, name: 'x'.repeat(200) })?.name).toHaveLength(64)
    expect(readDevice(null)).toBeNull()
    expect(readDevice([d])).toBeNull()
  })

  it('shows a device without private material', () => {
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const shown = presentable({
      id: randomUUID(),
      jwk: keys.privateKey.export({ format: 'jwk' }) as Record<string, unknown>,
      kind: 'desktop',
      name: 'MacBook',
      boundBy: 'first',
      at: 1
    })
    expect(JSON.stringify(shown)).not.toContain('"d"')
  })
})

/* ── link codes ──────────────────────────────────────────────────────────── */

describe('LinkCodes', () => {
  it('issues a six-character code from an unambiguous alphabet', () => {
    const codes = new LinkCodes(2 * 60 * 1000, () => now)
    const issued = codes.issue('drej', 'dev-1')
    expect(issued.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
    // No I, O, 0 or 1: a code that fails because it was read correctly and
    // typed correctly is the worst kind of refusal.
    expect(issued.code).not.toMatch(/[IO01]/)
    expect(issued.exp).toBe(now + 2 * 60 * 1000)
  })

  it('spends a code once, and names the device that issued it', () => {
    const codes = new LinkCodes(2 * 60 * 1000, () => now)
    const { code } = codes.issue('drej', 'dev-1')
    expect(codes.spend(code.toLowerCase(), 'drej')).toEqual({ ok: true, by: 'dev-1' })
    expect(codes.spend(code, 'drej')).toEqual({ ok: false, reason: 'unknown' })
  })

  it('expires in two minutes', () => {
    const codes = new LinkCodes(2 * 60 * 1000, () => now)
    const { code } = codes.issue('drej', 'dev-1')
    now += 2 * 60 * 1000 + 1
    expect(codes.spend(code, 'drej')).toEqual({ ok: false, reason: 'expired' })
  })

  it('BURNS a code presented for the wrong handle', () => {
    // Otherwise a code is grindable: guess a handle, keep the code, try again.
    const codes = new LinkCodes(2 * 60 * 1000, () => now)
    const { code } = codes.issue('drej', 'dev-1')
    expect(codes.spend(code, 'mira')).toEqual({ ok: false, reason: 'wrong_handle' })
    expect(codes.spend(code, 'drej')).toEqual({ ok: false, reason: 'unknown' })
  })
})

describe('LinkCodes under guessing', () => {
  it('THROWS THE CODE AWAY after ten wrong guesses at the same account', () => {
    // A wrong guess cannot be counted against the code that was guessed at —
    // there isn't one — so it is counted against the codes outstanding for the
    // account being guessed at. Ten is far more than a person mistypes and far
    // fewer than a script needs.
    const codes = new LinkCodes(2 * 60 * 1000, () => now)
    const { code } = codes.issue('drej', 'dev-1')
    for (let i = 0; i < 9; i++) {
      expect(codes.spend('AAAAAA', 'drej')).toEqual({ ok: false, reason: 'unknown' })
    }
    expect(codes.wrongGuesses(code)).toBe(9)
    // The real code still works at nine.
    const survivor = new LinkCodes(2 * 60 * 1000, () => now)
    const alive = survivor.issue('drej', 'dev-1')
    for (let i = 0; i < 9; i++) survivor.spend('AAAAAA', 'drej')
    expect(survivor.spend(alive.code, 'drej')).toEqual({ ok: true, by: 'dev-1' })
    // At ten it is gone, and the person who was waiting has to ask for
    // another — which is a thing they notice.
    codes.spend('AAAAAA', 'drej')
    expect(codes.wrongGuesses(code)).toBeNull()
    expect(codes.spend(code, 'drej')).toEqual({ ok: false, reason: 'unknown' })
  })

  it('does not let guesses at one account burn another account’s codes', () => {
    const codes = new LinkCodes(2 * 60 * 1000, () => now)
    const drej = codes.issue('drej', 'dev-1')
    const mira = codes.issue('mira', 'dev-2')
    for (let i = 0; i < 12; i++) codes.spend('AAAAAA', 'drej')
    expect(codes.outstanding('drej')).toBe(0)
    expect(codes.outstanding('mira')).toBe(1)
    expect(codes.spend(mira.code, 'mira')).toEqual({ ok: true, by: 'dev-2' })
    expect(codes.spend(drej.code, 'drej').ok).toBe(false)
  })
})

describe('RateLimiter', () => {
  const limiter = (): RateLimiter => new RateLimiter({ ...LINK_LIMIT, longMs: 2 * 60 * 1000 }, () => now)

  it('allows the burst and refuses the one after it, with a retry-after', () => {
    const l = limiter()
    for (let i = 0; i < 10; i++) expect(l.take('drej|1.2.3.4').ok).toBe(true)
    const refused = l.take('drej|1.2.3.4')
    expect(refused.ok).toBe(false)
    expect(refused.retryAfter).toBeGreaterThan(0)
  })

  it('COUNTS a refused attempt, so the limit is not its own reset', () => {
    const l = limiter()
    for (let i = 0; i < 15; i++) l.take('drej|1.2.3.4')
    now += 30 * 1000
    // Half a minute later the window still holds those fifteen.
    expect(l.take('drej|1.2.3.4').ok).toBe(false)
  })

  it('lets the short window roll, and still holds the lifetime cap', () => {
    const l = limiter()
    for (let i = 0; i < 10; i++) l.take('drej|1.2.3.4')
    now += 61 * 1000
    // The burst has aged out — but only ten of the twenty are spent.
    for (let i = 0; i < 10; i++) expect(l.take('drej|1.2.3.4').ok).toBe(true)
    expect(l.take('drej|1.2.3.4').ok).toBe(false)
    now += 61 * 1000
    // Past the code's whole lifetime, everything is forgotten.
    expect(l.take('drej|1.2.3.4').ok).toBe(true)
  })

  it('keeps one caller’s attempts off another’s bucket', () => {
    const l = limiter()
    for (let i = 0; i < 25; i++) l.take('drej|1.2.3.4')
    expect(l.take('drej|5.6.7.8').ok).toBe(true)
    expect(l.take('mira|1.2.3.4').ok).toBe(true)
  })
})

describe('clientAddress', () => {
  it('reads the socket, normalises IPv4-mapped IPv6, and IGNORES the header', () => {
    const request = {
      socket: { remoteAddress: '::ffff:10.0.0.7' },
      headers: { 'x-forwarded-for': '9.9.9.9' }
    } as never
    // Trusting the header would let any caller pick its own bucket by sending
    // one, which is the same as having no limiter at all.
    expect(clientAddress(request)).toBe('10.0.0.7')
    expect(clientAddress({ socket: {}, headers: {} } as never)).toBe('unknown')
  })
})

/* ── the ceremony, against accounts ──────────────────────────────────────── */

describe('IdentityService — one account, many devices', () => {
  it('mints a token naming the DEVICE that signed, for either device', () => {
    const identity = new IdentityService(base, CONFIG, () => now)
    const laptop = device()
    identity.accounts.mint('drej', laptop.wire)
    const phone = device('phone')
    identity.accounts.bind('drej', phone.wire, laptop.wire.id)

    for (const held of [laptop, phone]) {
      const out = identity.assert(ceremony(held.keys, 'drej')(identity.challenge()), 'account')
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect(identity.verifyToken(out.token)).toMatchObject({
        sub: 'drej',
        dev: held.wire.id,
        scope: 'account'
      })
    }
  })

  it('refuses a key that belongs to nobody, and one that was revoked', () => {
    const identity = new IdentityService(base, CONFIG, () => now)
    const laptop = device()
    identity.accounts.mint('drej', laptop.wire)
    const phone = device('phone')
    identity.accounts.bind('drej', phone.wire, laptop.wire.id)

    const stranger = device()
    expect(identity.assert(ceremony(stranger.keys, 'drej')(identity.challenge()))).toEqual({
      ok: false,
      reason: 'bad_signature'
    })
    identity.accounts.revoke('drej', phone.wire.id)
    expect(identity.assert(ceremony(phone.keys, 'drej')(identity.challenge()))).toEqual({
      ok: false,
      reason: 'bad_signature'
    })
  })

  it('KILLS a live token the moment its device is revoked', () => {
    const identity = new IdentityService(base, CONFIG, () => now)
    const laptop = device()
    identity.accounts.mint('drej', laptop.wire)
    const phone = device('phone')
    identity.accounts.bind('drej', phone.wire, laptop.wire.id)
    const out = identity.assert(ceremony(phone.keys, 'drej')(identity.challenge()), 'account')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(identity.verifyToken(out.token)).not.toBeNull()
    identity.accounts.revoke('drej', phone.wire.id)
    // Not at the end of the TTL — now. This is the whole point of `dev`.
    expect(identity.verifyToken(out.token)).toBeNull()
  })

  it('publishes the revoked ids beside the signing key', () => {
    const identity = new IdentityService(base, CONFIG, () => now)
    const laptop = device()
    identity.accounts.mint('drej', laptop.wire)
    const phone = device('phone')
    identity.accounts.bind('drej', phone.wire, laptop.wire.id)
    expect(identity.revokedDevices()).toEqual([])
    identity.accounts.revoke('drej', phone.wire.id)
    expect(identity.revokedDevices()).toEqual([phone.wire.id])
  })

  it('keeps the legacy credential map working, and migrates it at boot', () => {
    const legacy = new IdentityService(base, CONFIG, () => now)
    const keys = generateKeyPairSync('ed25519')
    legacy.register('drej', jwkOf(keys))
    // Same process: the enrolment became an account with one device.
    expect(legacy.accounts.active('drej')).toHaveLength(1)
    // Fresh process over the same directory: still one, not two.
    const rebooted = new IdentityService(base, CONFIG, () => now)
    expect(rebooted.accounts.active('drej')).toHaveLength(1)
    const out = rebooted.assert(ceremony(keys, 'drej')(rebooted.challenge()), 'download')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(identityClaims(rebooted, out.token).dev).toBe(rebooted.accounts.active('drej')[0].id)
  })
})

const identityClaims = (identity: IdentityService, token: string): Record<string, unknown> =>
  identity.verifyToken(token) as unknown as Record<string, unknown>

describe('token scopes', () => {
  const withAccount = (): { identity: IdentityService; held: ReturnType<typeof device> } => {
    const identity = new IdentityService(base, CONFIG, () => now)
    const held = device()
    identity.accounts.mint('drej', held.wire)
    return { identity, held }
  }

  it('mints each of the six scopes, and refuses a scope minted broad', () => {
    const { identity, held } = withAccount()
    for (const scope of ['download', 'publish', 'account', 'serve'] as const) {
      const out = identity.assert(ceremony(held.keys, 'drej')(identity.challenge()), scope)
      expect(out.ok).toBe(true)
      if (out.ok) expect(identity.verifyToken(out.token)?.scope).toBe(scope)
    }
    // A call token without a door, and a link token without a device, are both
    // refused rather than minted unconfined.
    expect(identity.assert(ceremony(held.keys, 'drej')(identity.challenge()), 'call')).toEqual({
      ok: false,
      reason: 'bad_audience'
    })
    expect(identity.assert(ceremony(held.keys, 'drej')(identity.challenge()), 'link')).toEqual({
      ok: false,
      reason: 'bad_audience'
    })
    expect(
      identity.assert(ceremony(held.keys, 'drej')(identity.challenge()), 'link', 'not-a-uuid')
    ).toEqual({ ok: false, reason: 'bad_audience' })
  })

  it('gives a link token two minutes and ONE use', () => {
    const { identity, held } = withAccount()
    const target = randomUUID()
    const out = identity.assert(ceremony(held.keys, 'drej')(identity.challenge()), 'link', target)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const claims = identity.verifyToken(out.token)
    expect(claims).toMatchObject({ scope: 'link', aud: target })
    expect(claims?.jti).toBeTypeOf('string')
    // Two minutes, not the ten every other scope gets.
    expect(claims?.exp).toBe(now + 2 * 60 * 1000)
    expect(identity.spendLink(out.token, target)).not.toBeNull()
    expect(identity.spendLink(out.token, target)).toBeNull()
    // And it may only be spent on the device it names.
    const second = identity.assert(ceremony(held.keys, 'drej')(identity.challenge()), 'link', target)
    if (!second.ok) return
    expect(identity.spendLink(second.token, randomUUID())).toBeNull()
  })

  it('expires a link token before an account token would have', () => {
    const { identity, held } = withAccount()
    const target = randomUUID()
    const out = identity.assert(ceremony(held.keys, 'drej')(identity.challenge()), 'link', target)
    if (!out.ok) return
    now += 2 * 60 * 1000 + 1
    expect(identity.verifyToken(out.token)).toBeNull()
  })

  it('refuses a scope it does not know, even correctly signed', () => {
    const { identity, held } = withAccount()
    const dev = held.wire.id
    // Minted by this very server, with this server's key — and still refused,
    // because the scope list is checked on the way back in rather than assumed
    // from the fact that the signature holds.
    const forged = identity.mintFor('drej', dev, 'root' as never)
    expect(forged).not.toBeNull()
    expect(identity.verifyToken(String(forged))).toBeNull()
    expect(identity.verifyToken(String(identity.mintFor('drej', dev, 'serve')))).toMatchObject({
      scope: 'serve',
      dev
    })
    // And a call token still needs its door.
    expect(identity.mintFor('drej', dev, 'call')).toBeNull()
    expect(identity.verifyToken(String(identity.mintFor('drej', dev, 'call', '@drej/alpha')))).toMatchObject({
      aud: '@drej/alpha'
    })
  })
})

/* ── real WebAuthn ───────────────────────────────────────────────────────── */

describe('IdentityService.assertPasskey', () => {
  /** A P-256 platform authenticator, producing DER signatures like a real one. */
  const authenticator = (over: { rpId?: string; flags?: number } = {}) => {
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const authData = Buffer.concat([
      createHash('sha256').update(over.rpId ?? CONFIG.rpId).digest(),
      Buffer.from([over.flags ?? 0x05]),
      Buffer.from([0, 0, 0, 7])
    ])
    return {
      jwk: jwkOf(keys),
      get(challenge: string, id: string, tweak: { origin?: string; type?: string } = {}) {
        const clientData = Buffer.from(
          JSON.stringify({
            type: tweak.type ?? 'webauthn.get',
            origin: tweak.origin ?? CONFIG.origin,
            challenge,
            crossOrigin: false
          }),
          'utf8'
        )
        const signature = sign(
          'sha256',
          Buffer.concat([authData, createHash('sha256').update(clientData).digest()]),
          keys.privateKey
        )
        return {
          credential: {
            id,
            rawId: id,
            type: 'public-key' as const,
            response: {
              clientDataJSON: b64(clientData),
              authenticatorData: b64(authData),
              signature: b64(signature)
            }
          }
        }
      }
    }
  }

  const enrolled = (): {
    identity: IdentityService
    auth: ReturnType<typeof authenticator>
    id: string
    deviceId: string
  } => {
    const identity = new IdentityService(base, CONFIG, () => now)
    const laptop = device()
    identity.accounts.mint('drej', laptop.wire)
    const auth = authenticator()
    const id = 'Y3JlZC1pZA'
    const deviceId = randomUUID()
    identity.accounts.bind(
      'drej',
      { id: deviceId, jwk: auth.jwk, kind: 'passkey', name: 'Touch ID' },
      laptop.wire.id,
      { credentialId: id }
    )
    return { identity, auth, id, deviceId }
  }

  it('verifies a real assertion and mints a token for the account behind it', () => {
    const { identity, auth, id, deviceId } = enrolled()
    const out = identity.assertPasskey(auth.get(identity.challenge(), id), 'account')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    // The credential id means nothing by itself — the devices table is what
    // turns it into an account.
    expect(out.sub).toBe('drej')
    expect(identity.verifyToken(out.token)).toMatchObject({ sub: 'drej', dev: deviceId, scope: 'account' })
  })

  it('consumes the challenge, so a captured assertion cannot be replayed', () => {
    const { identity, auth, id } = enrolled()
    const assertion = auth.get(identity.challenge(), id)
    expect(identity.assertPasskey(assertion).ok).toBe(true)
    expect(identity.assertPasskey(assertion)).toEqual({ ok: false, reason: 'unknown_challenge' })
  })

  it('refuses a foreign origin, a wrong RP, a missing user and a wrong type', () => {
    const { identity, auth, id } = enrolled()
    expect(identity.assertPasskey(auth.get(identity.challenge(), id, { origin: 'http://evil.test' }))).toEqual({
      ok: false,
      reason: 'wrong_origin'
    })
    expect(identity.assertPasskey(auth.get(identity.challenge(), id, { type: 'webauthn.create' }))).toEqual({
      ok: false,
      reason: 'wrong_type'
    })
    const elsewhere = authenticator({ rpId: 'evil.test' })
    const identity2 = new IdentityService(base, CONFIG, () => now)
    identity2.accounts.bind(
      'drej',
      { id: randomUUID(), jwk: elsewhere.jwk, kind: 'passkey', name: 'elsewhere' },
      identity2.accounts.active('drej')[0].id,
      { credentialId: 'other' }
    )
    expect(identity2.assertPasskey(elsewhere.get(identity2.challenge(), 'other'))).toEqual({
      ok: false,
      reason: 'wrong_rp'
    })
    const absent = authenticator({ flags: 0x00 })
    const identity3 = new IdentityService(base, CONFIG, () => now)
    identity3.accounts.bind(
      'drej',
      { id: randomUUID(), jwk: absent.jwk, kind: 'passkey', name: 'absent' },
      identity3.accounts.active('drej')[0].id,
      { credentialId: 'absent' }
    )
    expect(identity3.assertPasskey(absent.get(identity3.challenge(), 'absent'))).toEqual({
      ok: false,
      reason: 'user_not_present'
    })
  })

  it('refuses an unknown credential, a revoked one, and a mismatched handle', () => {
    const { identity, auth, id, deviceId } = enrolled()
    expect(identity.assertPasskey(auth.get(identity.challenge(), 'nobody'))).toEqual({
      ok: false,
      reason: 'unknown_credential'
    })
    expect(
      identity.assertPasskey({ ...auth.get(identity.challenge(), id), handle: 'mira' })
    ).toEqual({ ok: false, reason: 'unknown_credential' })
    identity.accounts.revoke('drej', deviceId)
    expect(identity.assertPasskey(auth.get(identity.challenge(), id))).toEqual({
      ok: false,
      reason: 'unknown_credential'
    })
  })

  it('refuses a signature made by a different key over the same bytes', () => {
    const { identity, id } = enrolled()
    const impostor = authenticator()
    expect(identity.assertPasskey(impostor.get(identity.challenge(), id))).toEqual({
      ok: false,
      reason: 'bad_signature'
    })
  })
})

describe('the signature counter', () => {
  /** Enrol a platform authenticator, exactly as the passkey route would. */
  const enrol = (signCount = 1) => {
    const identity = new IdentityService(base, CONFIG, () => now)
    const laptop = device()
    identity.accounts.mint('drej', laptop.wire)
    const auth = platformAuthenticator({ rpId: CONFIG.rpId, origin: CONFIG.origin, signCount })
    const parsed = parseAttestationObject(
      Buffer.from(auth.create(identity.challenge()).response.attestationObject, 'base64url')
    )
    if (!parsed.ok) throw new Error('the fixture did not parse')
    const deviceId = randomUUID()
    identity.accounts.bind(
      'drej',
      { id: deviceId, jwk: parsed.passkey.jwk, kind: 'passkey', name: 'Touch ID' },
      laptop.wire.id,
      { credentialId: parsed.passkey.credentialId, signCount: parsed.passkey.signCount }
    )
    return { identity, auth, deviceId }
  }

  it('accepts assertions whose count advances, and records the ceiling', () => {
    const { identity, auth, deviceId } = enrol()
    expect(identity.accounts.device('drej', deviceId)?.signCount).toBe(1)
    for (const expected of [2, 3, 4]) {
      expect(identity.assertPasskey(auth.get(identity.challenge())).ok).toBe(true)
      expect(identity.accounts.device('drej', deviceId)?.signCount).toBe(expected)
    }
  })

  it('REFUSES a count that did not move, and one that went backwards', () => {
    // The only signal WebAuthn gives that a credential has been cloned or an
    // assertion replayed from a capture.
    const { identity, auth, deviceId } = enrol()
    expect(identity.assertPasskey(auth.get(identity.challenge())).ok).toBe(true)
    expect(identity.accounts.device('drej', deviceId)?.signCount).toBe(2)
    expect(identity.assertPasskey(auth.get(identity.challenge(), { signCount: 2 }))).toEqual({
      ok: false,
      reason: 'sign_count'
    })
    expect(identity.assertPasskey(auth.get(identity.challenge(), { signCount: 1 }))).toEqual({
      ok: false,
      reason: 'sign_count'
    })
    // A refused assertion must not move the ceiling, or a failed replay would
    // lock the real device out.
    expect(identity.accounts.device('drej', deviceId)?.signCount).toBe(2)
    expect(identity.assertPasskey(auth.get(identity.challenge())).ok).toBe(true)
  })

  it('leaves an authenticator that does not count alone, forever', () => {
    // Zero is what the specification says an authenticator without a counter
    // reports, and refusing those would refuse most security keys.
    const { identity, auth, deviceId } = enrol(0)
    for (let i = 0; i < 3; i++) {
      expect(identity.assertPasskey(auth.get(identity.challenge())).ok).toBe(true)
    }
    expect(identity.accounts.device('drej', deviceId)?.signCount).toBe(0)
  })

  it('does not apply to the software ceremony, which writes a constant', () => {
    // The site's own key signs a fixed counter every time; enforcing there
    // would refuse every second sign-in.
    const identity = new IdentityService(base, CONFIG, () => now)
    const held = device()
    identity.accounts.mint('drej', held.wire)
    for (let i = 0; i < 3; i++) {
      expect(identity.assert(ceremony(held.keys, 'drej')(identity.challenge())).ok).toBe(true)
    }
  })
})

describe('IdentityService.register', () => {
  it('narrows the key it is handed, and never writes a private half', () => {
    const identity = new IdentityService(base, CONFIG, () => now)
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const careless = keys.privateKey.export({ format: 'jwk' }) as Record<string, unknown>
    expect(careless.d).toBeTypeOf('string')
    expect(identity.register('drej', careless)).toEqual({ ok: true })
    const stored = readFileSync(path.join(base, 'credentials.json'), 'utf8')
    expect(stored).not.toContain(String(careless.d))
    expect(JSON.parse(stored)[0].jwk.d).toBeUndefined()
    // Written 0600, whole: it is the file that says which key owns a handle.
    expect(statSync(path.join(base, 'credentials.json')).mode & 0o777).toBe(0o600)
    // And the key still verifies, because narrowing kept the public half.
    expect(identity.assert(ceremony(keys, 'drej')(identity.challenge())).ok).toBe(true)
  })

  it('refuses a key nothing here can verify, rather than storing a dead one', () => {
    const identity = new IdentityService(base, CONFIG, () => now)
    expect(identity.register('drej', { kty: 'RSA', n: 'a', e: 'b' })).toEqual({
      ok: false,
      reason: 'bad_key'
    })
    expect(identity.accounts.exists('drej')).toBe(false)
  })

  it('is idempotent for the same key however it was spelled', () => {
    const identity = new IdentityService(base, CONFIG, () => now)
    const keys = generateKeyPairSync('ed25519')
    const jwk = jwkOf(keys)
    expect(identity.register('drej', jwk).ok).toBe(true)
    // Members in another order — the same key, and not an attempted takeover.
    expect(identity.register('drej', { x: jwk.x, kty: jwk.kty, crv: jwk.crv }).ok).toBe(true)
    expect(identity.register('drej', jwkOf(generateKeyPairSync('ed25519')))).toEqual({
      ok: false,
      reason: 'credential_exists'
    })
  })

  it('writes the token key 0600, because it is a private key', () => {
    const identity = new IdentityService(base, CONFIG, () => now)
    identity.publicKeyJwk()
    expect(statSync(path.join(base, 'token-key.jwk')).mode & 0o777).toBe(0o600)
  })
})

/* ── the bind statement ──────────────────────────────────────────────────── */

describe('bindStatement', () => {
  it('names the account, the new device AND its key', () => {
    const keys = generateKeyPairSync('ed25519')
    const thumbprint = jwkThumbprint(jwkOf(keys))
    const id = randomUUID()
    expect(bindStatement('drej', id, String(thumbprint))).toBe(
      `cookrew-bind/1 drej ${id} ${thumbprint}`
    )
  })
})
