import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { V2Accounts, V2_FILE } from '../registry/src/v2-accounts'
import { V2Tokens } from '../registry/src/v2-tokens'
import { RECOVERY_ALPHABET, sanitiseJwk } from '../registry/src/v2-secrets'
import { HashGate } from '../registry/src/v2-hash-gate'
import { Limiter, callerAddress } from '../registry/src/v2-limiter'

/**
 * IDENTITY v2 — THE STORE.
 *
 * A person is an account and a device is a proof of presence (P2), so every
 * rule here is about that pair: a name is claimed once, a password is the
 * floor under it, and a device can always be taken away as long as it is not
 * the last one. Nothing in this file prints a hash or a token: a test output
 * that carries a credential is a credential in a log.
 */

const PASSWORD = 'correct horse battery staple'

const device = (kind: 'desktop' | 'phone' | 'browser' = 'desktop', name = 'This Mac') => ({
  id: randomUUID(),
  kind,
  name,
  jwk: { kty: 'OKP', crv: 'Ed25519', x: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYWE' }
})

let dir = ''
let store: V2Accounts

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'v2-accounts-'))
  store = new V2Accounts(dir)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('claiming a username', () => {
  it('mints an account whose first device is the one that claimed it', async () => {
    const d = device()
    const out = await store.create({ username: 'drej', password: PASSWORD, device: d })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.account.username).toBe('drej')
    expect(out.account.devices.map((x) => x.id)).toEqual([d.id])
    expect(out.device.kind).toBe('desktop')
    expect(store.has('drej')).toBe(true)
  })

  it('refuses a name someone already holds, and says which', async () => {
    await store.create({ username: 'anvz', password: PASSWORD, device: device() })
    const again = await store.create({ username: 'anvz', password: PASSWORD, device: device('browser') })
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.reason).toBe('taken')
  })

  it('refuses a name that is not a username, including the reserved acct- prefix', async () => {
    for (const username of ['Drej', 'a'.repeat(33), '-drej', 'drej-', 'dr ej', '', 'acct-1234']) {
      const out = await store.create({ username, password: PASSWORD, device: device() })
      expect(out.ok, username).toBe(false)
      if (!out.ok) expect(out.reason, username).toBe('bad_username')
    }
  })

  it('refuses a password under twelve characters or over 256', async () => {
    for (const password of ['short', 'elevenchar', 'x'.repeat(257)]) {
      const out = await store.create({ username: `u${password.length}`, password, device: device() })
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.reason).toBe('weak_password')
    }
    expect((await store.create({ username: 'twelve', password: 'x'.repeat(12), device: device() })).ok).toBe(true)
  })

  it('never keeps the password itself — only a salted scrypt hash', async () => {
    await store.create({ username: 'drej', password: PASSWORD, device: device() })
    const raw = readFileSync(path.join(dir, V2_FILE), 'utf8')
    expect(raw.includes(PASSWORD)).toBe(false)
    expect(await store.verifyPassword('drej', PASSWORD)).toBe(true)
    expect(await store.verifyPassword('drej', `${PASSWORD} `)).toBe(false)
    expect(await store.verifyPassword('nobody', PASSWORD)).toBe(false)
  })
})

describe('a device describes itself, or it is not attached', () => {
  it('refuses an id that is not a UUID, an unknown kind, and a nameless device', async () => {
    const bad = [
      { ...device(), id: 'device-1' },
      { ...device(), kind: 'toaster' },
      { ...device(), name: '' },
      { ...device(), name: 'x'.repeat(65) },
      { ...device(), jwk: { kty: 'RSA', n: 'x', e: 'AQAB' } },
      { ...device(), jwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc', d: 'a-private-half' } }
    ]
    for (const d of bad) {
      const out = await store.create({ username: `u${bad.indexOf(d)}`, password: PASSWORD, device: d as never })
      expect(out.ok, JSON.stringify(d.kind)).toBe(false)
      if (!out.ok) expect(out.reason).toBe('bad_device')
    }
  })

  it('keeps only the public members of a key it accepts', async () => {
    expect(sanitiseJwk({ kty: 'OKP', crv: 'Ed25519', x: 'abc', use: 'sig', extra: 1 })).toEqual({
      kty: 'OKP',
      crv: 'Ed25519',
      x: 'abc'
    })
    expect(sanitiseJwk({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b', ext: true })).toEqual({
      kty: 'EC',
      crv: 'P-256',
      x: 'a',
      y: 'b'
    })
    expect(sanitiseJwk({ kty: 'EC', crv: 'P-384', x: 'a', y: 'b' })).toBeNull()
    expect(sanitiseJwk({ kty: 'OKP', crv: 'Ed25519', x: 'a', d: 'secret' })).toBeNull()
  })

  it('reuses a device id the account already knows rather than attaching a twin', async () => {
    const d = device()
    await store.create({ username: 'drej', password: PASSWORD, device: d })
    const back = await store.signIn({ username: 'drej', password: PASSWORD, device: { ...d, name: 'Renamed' } })
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.device.id).toBe(d.id)
    expect(store.get('drej')?.devices).toHaveLength(1)
  })

  it('attaches a new device on sign-in, and refuses a device id another account holds', async () => {
    const first = device()
    await store.create({ username: 'drej', password: PASSWORD, device: first })
    const phone = device('phone', 'iPhone')
    const out = await store.signIn({ username: 'drej', password: PASSWORD, device: phone })
    expect(out.ok).toBe(true)
    expect(store.get('drej')?.devices).toHaveLength(2)

    await store.create({ username: 'mira', password: PASSWORD, device: device('browser') })
    const stolen = await store.signIn({ username: 'mira', password: PASSWORD, device: phone })
    expect(stolen.ok).toBe(false)
    if (!stolen.ok) expect(stolen.reason).toBe('bad_device')
  })

  it('answers the same refusal for an unknown user and a wrong password', async () => {
    await store.create({ username: 'drej', password: PASSWORD, device: device() })
    const wrong = await store.signIn({ username: 'drej', password: 'not the password', device: device('browser') })
    const nobody = await store.signIn({ username: 'ghost', password: PASSWORD, device: device('browser') })
    expect(wrong.ok).toBe(false)
    expect(nobody.ok).toBe(false)
    if (!wrong.ok && !nobody.ok) expect(wrong.reason).toBe(nobody.reason)
  })
})

describe('sessions are revocable, and bounded', () => {
  it('holds a session per sign-in and forgets the oldest past fifty', async () => {
    const d = device()
    await store.create({ username: 'drej', password: PASSWORD, device: d })
    const first = store.startSession('drej', d.id)
    expect(first).not.toBeNull()
    if (!first) return
    expect(store.isLiveSession('drej', first.jti)).toBe(true)
    for (let i = 0; i < 60; i++) store.startSession('drej', d.id)
    expect(store.get('drej')?.sessions).toHaveLength(50)
    expect(store.isLiveSession('drej', first.jti)).toBe(false)
  })

  it('ends one session without touching the others', async () => {
    const d = device()
    await store.create({ username: 'drej', password: PASSWORD, device: d })
    const a = store.startSession('drej', d.id)
    const b = store.startSession('drej', d.id)
    if (!a || !b) throw new Error('no session')
    store.closeSession('drej', a.jti)
    expect(store.isLiveSession('drej', a.jti)).toBe(false)
    expect(store.isLiveSession('drej', b.jti)).toBe(true)
  })
})

describe('revoking a device', () => {
  it('kills that device’s sessions and lists it as revoked', async () => {
    const mac = device()
    const phone = device('phone', 'iPhone')
    await store.create({ username: 'drej', password: PASSWORD, device: mac })
    await store.signIn({ username: 'drej', password: PASSWORD, device: phone })
    const onPhone = store.startSession('drej', phone.id)
    const onMac = store.startSession('drej', mac.id)
    if (!onPhone || !onMac) throw new Error('no session')

    const out = store.revokeDevice('drej', phone.id)
    expect(out.ok).toBe(true)
    expect(store.isLiveSession('drej', onPhone.jti)).toBe(false)
    expect(store.isLiveSession('drej', onMac.jti)).toBe(true)
    expect(store.revokedIds()).toContain(phone.id)
    expect(store.get('drej')?.devices.map((d) => d.id)).toEqual([mac.id])
  })

  it('refuses the last device, and allows the current one', async () => {
    const mac = device()
    const phone = device('phone', 'iPhone')
    await store.create({ username: 'drej', password: PASSWORD, device: mac })
    await store.signIn({ username: 'drej', password: PASSWORD, device: phone })
    expect(store.revokeDevice('drej', mac.id).ok).toBe(true)
    const last = store.revokeDevice('drej', phone.id)
    expect(last.ok).toBe(false)
    if (!last.ok) expect(last.reason).toBe('last_device')
  })

  it('is unknown for a device that is not on the account', async () => {
    await store.create({ username: 'drej', password: PASSWORD, device: device() })
    const out = store.revokeDevice('drej', randomUUID())
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('not_found')
  })
})

describe('recovery codes', () => {
  it('mints eight readable codes, stores none of them in the clear, and spends each once', async () => {
    const d = device()
    await store.create({ username: 'drej', password: PASSWORD, device: d })
    const codes = store.mintRecoveryCodes('drej')
    expect(codes).toHaveLength(8)
    for (const code of codes) {
      expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/)
      for (const ch of code.replace('-', '')) expect(RECOVERY_ALPHABET).toContain(ch)
    }
    const raw = readFileSync(path.join(dir, V2_FILE), 'utf8')
    for (const code of codes) expect(raw.includes(code)).toBe(false)

    expect(store.useRecoveryCode('drej', codes[0])).toBe(true)
    expect(store.useRecoveryCode('drej', codes[0])).toBe(false)
    expect(store.useRecoveryCode('drej', codes[1].toLowerCase())).toBe(true)
    expect(store.useRecoveryCode('drej', 'ZZZZ-ZZZZ')).toBe(false)
  })

  it('replaces the previous set, so an old sheet of codes is worthless', async () => {
    await store.create({ username: 'drej', password: PASSWORD, device: device() })
    const old = store.mintRecoveryCodes('drej')
    const fresh = store.mintRecoveryCodes('drej')
    expect(store.useRecoveryCode('drej', old[0])).toBe(false)
    expect(store.useRecoveryCode('drej', fresh[0])).toBe(true)
  })
})

describe('the profile, the desktops and the password', () => {
  it('takes a display name and a small avatar, and refuses a big or foreign one', async () => {
    await store.create({ username: 'drej', password: PASSWORD, device: device() })
    expect(store.setProfile('drej', { displayName: 'Drej' }).ok).toBe(true)
    expect(store.get('drej')?.displayName).toBe('Drej')
    expect(store.setProfile('drej', { displayName: 'x'.repeat(41) }).ok).toBe(false)
    expect(store.setProfile('drej', { avatar: `data:image/png;base64,${'A'.repeat(40)}` }).ok).toBe(true)
    expect(store.setProfile('drej', { avatar: 'https://example.com/a.png' }).ok).toBe(false)
    expect(store.setProfile('drej', { avatar: `data:image/gif;base64,${'A'.repeat(40)}` }).ok).toBe(false)
    expect(store.setProfile('drej', { avatar: `data:image/png;base64,${'A'.repeat(90_000)}` }).ok).toBe(false)
  })

  it('records a desktop’s workspaces by name and id, and bounds both', async () => {
    const d = device()
    await store.create({ username: 'drej', password: PASSWORD, device: d })
    const ok = store.putDesktop('drej', d.id, {
      name: 'MacBook Pro',
      workspaces: [{ id: 'w1', name: 'Cookrew Dev' }]
    })
    expect(ok.ok).toBe(true)
    expect(store.get('drej')?.desktops[0]?.workspaces).toEqual([{ id: 'w1', name: 'Cookrew Dev' }])

    const many = Array.from({ length: 65 }, (_, i) => ({ id: `w${i}`, name: `W${i}` }))
    expect(store.putDesktop('drej', d.id, { name: 'MacBook Pro', workspaces: many }).ok).toBe(false)
    expect(store.putDesktop('drej', d.id, { name: 'x'.repeat(65), workspaces: [] }).ok).toBe(false)
    expect(store.putDesktop('drej', randomUUID(), { name: 'Ghost', workspaces: [] }).ok).toBe(false)
  })

  it('changes a password only when the current one is right', async () => {
    await store.create({ username: 'drej', password: PASSWORD, device: device() })
    expect((await store.changePassword('drej', 'wrong', 'a longer new password')).ok).toBe(false)
    expect((await store.changePassword('drej', PASSWORD, 'short')).ok).toBe(false)
    expect((await store.changePassword('drej', PASSWORD, 'a longer new password')).ok).toBe(true)
    expect(await store.verifyPassword('drej', 'a longer new password')).toBe(true)
    expect(await store.verifyPassword('drej', PASSWORD)).toBe(false)
  })

  it('shows a public profile with no devices on it', async () => {
    const d = device()
    await store.create({ username: 'drej', password: PASSWORD, device: d })
    store.setProfile('drej', { displayName: 'Drej' })
    const shown = store.publicProfile('drej')
    expect(shown).toEqual({ username: 'drej', displayName: 'Drej' })
    expect(JSON.stringify(shown)).not.toContain(d.id)
    expect(store.publicProfile('nobody')).toBeNull()
  })
})

describe('the file on disk', () => {
  it('is written atomically, private to its owner, and leaves no temp behind', async () => {
    await store.create({ username: 'drej', password: PASSWORD, device: device() })
    const file = path.join(dir, V2_FILE)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir).filter((n) => n.includes('.tmp'))).toEqual([])
    const reopened = new V2Accounts(dir)
    expect(reopened.has('drej')).toBe(true)
    expect(await reopened.verifyPassword('drej', PASSWORD)).toBe(true)
  })

  it('refuses to start on a torn file, in a sentence that names it', async () => {
    const file = path.join(dir, V2_FILE)
    writeFileSync(file, '{"accounts":[{"username":"drej"', { mode: 0o600 })
    expect(() => new V2Accounts(dir)).toThrow(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    // And it did not quietly reset: the bytes are still there for a human.
    expect(readFileSync(file, 'utf8')).toContain('drej')
  })

  it('refuses a file whose shape is wrong rather than reading past it', async () => {
    const file = path.join(dir, V2_FILE)
    writeFileSync(file, JSON.stringify({ accounts: 'all of them' }), { mode: 0o600 })
    expect(() => new V2Accounts(dir)).toThrow(/accounts-v2\.json/)
    chmodSync(file, 0o600)
  })
})

describe('tokens', () => {
  it('mints a session and a call token on the registry’s own key and format', async () => {
    const tokens = new V2Tokens(dir, { revoked: () => new Set(store.revokedIds()) })
    const dev = randomUUID()
    const session = tokens.mintSession('drej', dev, 'jti-1')
    expect(session.token.split('.')).toHaveLength(2)
    const claims = tokens.verify(session.token, 'session')
    expect(claims?.sub).toBe('drej')
    expect(claims?.dev).toBe(dev)
    expect(claims?.jti).toBe('jti-1')
    // Thirty days, not ten minutes: a session is not a retry ticket.
    expect(session.exp - Date.now()).toBeGreaterThan(29 * 24 * 3600 * 1000)

    const call = tokens.mintCallToken('drej', dev, '@drej/alpha')
    expect(tokens.verify(call.token, 'call')?.aud).toBe('@drej/alpha')
    expect(call.exp - Date.now()).toBeLessThan(11 * 60 * 1000)
  })

  it('rejects a bad signature, a wrong scope, an expired token and a revoked device', async () => {
    const mac = device()
    const phone = device('phone', 'iPhone')
    await store.create({ username: 'drej', password: PASSWORD, device: mac })
    await store.signIn({ username: 'drej', password: PASSWORD, device: phone })
    const tokens = new V2Tokens(dir, { revoked: () => new Set(store.revokedIds()) })

    const session = tokens.mintSession('drej', phone.id, 'jti-1')
    expect(tokens.verify(session.token, 'session')).not.toBeNull()
    expect(tokens.verify(session.token, 'call')).toBeNull()
    expect(tokens.verify(`${session.token}x`, 'session')).toBeNull()
    expect(tokens.verify('not-a-token', 'session')).toBeNull()

    store.revokeDevice('drej', phone.id)
    expect(tokens.verify(session.token, 'session')).toBeNull()

    const past = new V2Tokens(dir, { now: () => Date.now() - 31 * 24 * 3600 * 1000 })
    const stale = past.mintSession('drej', mac.id, 'jti-2')
    expect(tokens.verify(stale.token, 'session')).toBeNull()
  })

  it('shares the registry’s existing token key, so one key signs everything', async () => {
    const a = new V2Tokens(dir)
    const b = new V2Tokens(dir)
    const minted = a.mintSession('drej', randomUUID(), 'jti-1')
    expect(b.verify(minted.token, 'session')?.sub).toBe('drej')
    expect(b.publicKeyJwk().kty).toBe('OKP')
  })
})

describe('the phase 4 seam, filled', () => {
  /**
   * The seam moved: what an account HAS is phase 4's own store (a TOTP seed
   * is a secret and does not belong in the file a profile renders from), so
   * what stays here is the half only this store can do — ending every sitting
   * but one, which is what "not me" asks for.
   */
  it('ends every other sitting and publishes their ids, keeping the caller’s', async () => {
    const first = device()
    const second = device('phone', 'iPhone')
    await store.create({ username: 'drej', password: PASSWORD, device: first })
    store.attachDevice('drej', second)
    const mine = store.startSession('drej', first.id)
    const theirs = store.startSession('drej', second.id)
    expect(mine).not.toBeNull()
    expect(theirs).not.toBeNull()
    if (!mine || !theirs) return

    expect(store.endOtherSessions('drej', mine.jti)).toBe(1)
    expect(store.isLiveSession('drej', mine.jti)).toBe(true)
    expect(store.isLiveSession('drej', theirs.jti)).toBe(false)
    // A door verifies offline, so the ended sitting has to be published.
    expect(store.revokedFor('drej')).toContain(theirs.jti)
    // The phone itself stays attached: "not me" ends sittings, it does not
    // take somebody's device off their account.
    expect(store.get('drej')?.devices.some((d) => d.id === second.id)).toBe(true)
    expect(store.endOtherSessions('drej', mine.jti)).toBe(0)
  })
})

describe('the hash gate (security review, HIGH)', () => {
  it('never stretches more than its ceiling at once, and queues the rest', async () => {
    const gate = new HashGate(2, 4)
    let peak = 0
    const work = async (): Promise<void> => {
      peak = Math.max(peak, gate.active)
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    await Promise.all(Array.from({ length: 10 }, () => gate.run(work)))
    expect(peak).toBeLessThanOrEqual(2)
    expect(gate.active).toBe(0)
  })

  it('says it is overloaded once the queue is longer than it will hold', async () => {
    const gate = new HashGate(1, 3)
    let open = (): void => undefined
    const barrier = new Promise<void>((resolve) => (open = resolve))
    const busy = Array.from({ length: 8 }, () => gate.run(() => barrier))
    await new Promise((resolve) => setImmediate(resolve))
    expect(gate.overloaded).toBe(true)
    open()
    await Promise.all(busy)
    // Drained, so the next caller is served rather than refused for ever.
    expect(gate.overloaded).toBe(false)
  })
})

describe('the limiter’s idea of who is asking (security review, HIGH)', () => {
  it('does not let a forwarded header mint a fresh key', () => {
    const limiter = new Limiter(2)
    const spoof = (value: string): boolean =>
      limiter.take(callerAddress({ 'x-forwarded-for': value }, '203.0.113.9'))
    expect(spoof('1.1.1.1')).toBe(true)
    expect(spoof('2.2.2.2')).toBe(true)
    // A third try under a third invented address is still the same peer.
    expect(spoof('3.3.3.3')).toBe(false)
  })

  it('reads the chain only from a hop the deployment named, and only its last entry', () => {
    expect(callerAddress({ 'x-forwarded-for': '9.9.9.9, 10.0.0.7' }, '10.0.0.1', ['10.0.0.1'])).toBe('10.0.0.7')
    expect(callerAddress({ 'x-forwarded-for': '9.9.9.9' }, '10.0.0.2', ['10.0.0.1'])).toBe('10.0.0.2')
    // One address, one key: the IPv6-mapped spelling is not a second caller.
    expect(callerAddress({}, '::ffff:203.0.113.9')).toBe('203.0.113.9')
  })
})

describe('changing a password ends the other sittings (security review, MEDIUM)', () => {
  it('keeps the caller’s session, ends the rest, and publishes them as revoked', async () => {
    const mac = device()
    const phone = device('phone', 'iPhone')
    await store.create({ username: 'drej', password: PASSWORD, device: mac })
    await store.signIn({ username: 'drej', password: PASSWORD, device: phone })
    const here = store.startSession('drej', mac.id)
    const there = store.startSession('drej', phone.id)
    if (!here || !there) throw new Error('no session')

    expect((await store.changePassword('drej', PASSWORD, 'a longer new password', here.jti)).ok).toBe(true)
    expect(store.isLiveSession('drej', here.jti)).toBe(true)
    expect(store.isLiveSession('drej', there.jti)).toBe(false)
    expect(store.revokedIds()).toContain(there.jti)
    expect(store.revokedIds()).not.toContain(here.jti)
    // The phone is still ATTACHED — the password changed, the device did not.
    expect(store.get('drej')?.devices.map((d) => d.id)).toContain(phone.id)
  })

  it('does the same when a new sheet of recovery codes is taken', async () => {
    const mac = device()
    const phone = device('phone', 'iPhone')
    await store.create({ username: 'drej', password: PASSWORD, device: mac })
    await store.signIn({ username: 'drej', password: PASSWORD, device: phone })
    const here = store.startSession('drej', mac.id)
    const there = store.startSession('drej', phone.id)
    if (!here || !there) throw new Error('no session')

    store.mintRecoveryCodes('drej', here.jti)
    expect(store.isLiveSession('drej', here.jti)).toBe(true)
    expect(store.isLiveSession('drej', there.jti)).toBe(false)
    expect(store.revokedIds()).toContain(there.jti)
  })

  it('refuses a token whose session was revoked, not only one whose device was', async () => {
    const mac = device()
    const phone = device('phone', 'iPhone')
    await store.create({ username: 'drej', password: PASSWORD, device: mac })
    await store.signIn({ username: 'drej', password: PASSWORD, device: phone })
    const here = store.startSession('drej', mac.id)
    const there = store.startSession('drej', phone.id)
    if (!here || !there) throw new Error('no session')
    const tokens = new V2Tokens(dir, { revoked: () => new Set(store.revokedIds()) })
    const carried = tokens.mintSession('drej', phone.id, there.jti)
    expect(tokens.verify(carried.token, 'session')).not.toBeNull()

    await store.changePassword('drej', PASSWORD, 'a longer new password', here.jti)
    expect(tokens.verify(carried.token, 'session')).toBeNull()
  })
})

describe('revocations are kept per account (security review, MEDIUM)', () => {
  it('600 revocations across two accounts never drop the other’s', async () => {
    const spare = { drej: device('phone', 'Spare A'), mira: device('phone', 'Spare B') }
    await store.create({ username: 'drej', password: PASSWORD, device: spare.drej })
    await store.create({ username: 'mira', password: PASSWORD, device: spare.mira })

    const churn = (username: string, n: number): string[] => {
      const gone: string[] = []
      for (let i = 0; i < n; i++) {
        const one = device('browser', `Chrome ${i}`)
        store.attachDevice(username, one)
        expect(store.revokeDevice(username, one.id).ok).toBe(true)
        gone.push(one.id)
      }
      return gone
    }
    const first = churn('mira', 1)[0]
    churn('drej', 300)
    churn('mira', 299)

    // Mira's own cap is 200, so her earliest is gone from HER list — but it
    // was never at the mercy of Drej's three hundred.
    expect(store.revokedFor('mira')).not.toContain(first)
    const mine = churn('mira', 1)[0]
    expect(store.revokedFor('mira')).toContain(mine)
    expect(store.revokedFor('drej')).toHaveLength(200)
    expect(store.revokedFor('mira')).toHaveLength(200)
    expect(store.revokedFor('drej').some((id) => store.revokedFor('mira').includes(id))).toBe(false)
  }, 30_000)
})
