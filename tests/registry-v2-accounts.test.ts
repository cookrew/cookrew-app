import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { V2Accounts, V2_FILE } from '../registry/src/v2-accounts'
import { V2Tokens } from '../registry/src/v2-tokens'
import { RECOVERY_ALPHABET, sanitiseJwk } from '../registry/src/v2-secrets'

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
  it('mints an account whose first device is the one that claimed it', () => {
    const d = device()
    const out = store.create({ username: 'drej', password: PASSWORD, device: d })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.account.username).toBe('drej')
    expect(out.account.devices.map((x) => x.id)).toEqual([d.id])
    expect(out.device.kind).toBe('desktop')
    expect(store.has('drej')).toBe(true)
  })

  it('refuses a name someone already holds, and says which', () => {
    store.create({ username: 'anvz', password: PASSWORD, device: device() })
    const again = store.create({ username: 'anvz', password: PASSWORD, device: device('browser') })
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.reason).toBe('taken')
  })

  it('refuses a name that is not a username, including the reserved acct- prefix', () => {
    for (const username of ['Drej', 'a'.repeat(33), '-drej', 'drej-', 'dr ej', '', 'acct-1234']) {
      const out = store.create({ username, password: PASSWORD, device: device() })
      expect(out.ok, username).toBe(false)
      if (!out.ok) expect(out.reason, username).toBe('bad_username')
    }
  })

  it('refuses a password under twelve characters or over 256', () => {
    for (const password of ['short', 'elevenchar', 'x'.repeat(257)]) {
      const out = store.create({ username: `u${password.length}`, password, device: device() })
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.reason).toBe('weak_password')
    }
    expect(store.create({ username: 'twelve', password: 'x'.repeat(12), device: device() }).ok).toBe(true)
  })

  it('never keeps the password itself — only a salted scrypt hash', () => {
    store.create({ username: 'drej', password: PASSWORD, device: device() })
    const raw = readFileSync(path.join(dir, V2_FILE), 'utf8')
    expect(raw.includes(PASSWORD)).toBe(false)
    expect(store.verifyPassword('drej', PASSWORD)).toBe(true)
    expect(store.verifyPassword('drej', `${PASSWORD} `)).toBe(false)
    expect(store.verifyPassword('nobody', PASSWORD)).toBe(false)
  })
})

describe('a device describes itself, or it is not attached', () => {
  it('refuses an id that is not a UUID, an unknown kind, and a nameless device', () => {
    const bad = [
      { ...device(), id: 'device-1' },
      { ...device(), kind: 'toaster' },
      { ...device(), name: '' },
      { ...device(), name: 'x'.repeat(65) },
      { ...device(), jwk: { kty: 'RSA', n: 'x', e: 'AQAB' } },
      { ...device(), jwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc', d: 'a-private-half' } }
    ]
    for (const d of bad) {
      const out = store.create({ username: `u${bad.indexOf(d)}`, password: PASSWORD, device: d as never })
      expect(out.ok, JSON.stringify(d.kind)).toBe(false)
      if (!out.ok) expect(out.reason).toBe('bad_device')
    }
  })

  it('keeps only the public members of a key it accepts', () => {
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

  it('reuses a device id the account already knows rather than attaching a twin', () => {
    const d = device()
    store.create({ username: 'drej', password: PASSWORD, device: d })
    const back = store.signIn({ username: 'drej', password: PASSWORD, device: { ...d, name: 'Renamed' } })
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.device.id).toBe(d.id)
    expect(store.get('drej')?.devices).toHaveLength(1)
  })

  it('attaches a new device on sign-in, and refuses a device id another account holds', () => {
    const first = device()
    store.create({ username: 'drej', password: PASSWORD, device: first })
    const phone = device('phone', 'iPhone')
    const out = store.signIn({ username: 'drej', password: PASSWORD, device: phone })
    expect(out.ok).toBe(true)
    expect(store.get('drej')?.devices).toHaveLength(2)

    store.create({ username: 'mira', password: PASSWORD, device: device('browser') })
    const stolen = store.signIn({ username: 'mira', password: PASSWORD, device: phone })
    expect(stolen.ok).toBe(false)
    if (!stolen.ok) expect(stolen.reason).toBe('bad_device')
  })

  it('answers the same refusal for an unknown user and a wrong password', () => {
    store.create({ username: 'drej', password: PASSWORD, device: device() })
    const wrong = store.signIn({ username: 'drej', password: 'not the password', device: device('browser') })
    const nobody = store.signIn({ username: 'ghost', password: PASSWORD, device: device('browser') })
    expect(wrong.ok).toBe(false)
    expect(nobody.ok).toBe(false)
    if (!wrong.ok && !nobody.ok) expect(wrong.reason).toBe(nobody.reason)
  })
})

describe('sessions are revocable, and bounded', () => {
  it('holds a session per sign-in and forgets the oldest past fifty', () => {
    const d = device()
    store.create({ username: 'drej', password: PASSWORD, device: d })
    const first = store.startSession('drej', d.id)
    expect(first).not.toBeNull()
    if (!first) return
    expect(store.isLiveSession('drej', first.jti)).toBe(true)
    for (let i = 0; i < 60; i++) store.startSession('drej', d.id)
    expect(store.get('drej')?.sessions).toHaveLength(50)
    expect(store.isLiveSession('drej', first.jti)).toBe(false)
  })

  it('ends one session without touching the others', () => {
    const d = device()
    store.create({ username: 'drej', password: PASSWORD, device: d })
    const a = store.startSession('drej', d.id)
    const b = store.startSession('drej', d.id)
    if (!a || !b) throw new Error('no session')
    store.closeSession('drej', a.jti)
    expect(store.isLiveSession('drej', a.jti)).toBe(false)
    expect(store.isLiveSession('drej', b.jti)).toBe(true)
  })
})

describe('revoking a device', () => {
  it('kills that device’s sessions and lists it as revoked', () => {
    const mac = device()
    const phone = device('phone', 'iPhone')
    store.create({ username: 'drej', password: PASSWORD, device: mac })
    store.signIn({ username: 'drej', password: PASSWORD, device: phone })
    const onPhone = store.startSession('drej', phone.id)
    const onMac = store.startSession('drej', mac.id)
    if (!onPhone || !onMac) throw new Error('no session')

    const out = store.revokeDevice('drej', phone.id)
    expect(out.ok).toBe(true)
    expect(store.isLiveSession('drej', onPhone.jti)).toBe(false)
    expect(store.isLiveSession('drej', onMac.jti)).toBe(true)
    expect(store.revokedDevices()).toContain(phone.id)
    expect(store.get('drej')?.devices.map((d) => d.id)).toEqual([mac.id])
  })

  it('refuses the last device, and allows the current one', () => {
    const mac = device()
    const phone = device('phone', 'iPhone')
    store.create({ username: 'drej', password: PASSWORD, device: mac })
    store.signIn({ username: 'drej', password: PASSWORD, device: phone })
    expect(store.revokeDevice('drej', mac.id).ok).toBe(true)
    const last = store.revokeDevice('drej', phone.id)
    expect(last.ok).toBe(false)
    if (!last.ok) expect(last.reason).toBe('last_device')
  })

  it('is unknown for a device that is not on the account', () => {
    store.create({ username: 'drej', password: PASSWORD, device: device() })
    const out = store.revokeDevice('drej', randomUUID())
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('not_found')
  })
})

describe('recovery codes', () => {
  it('mints eight readable codes, stores none of them in the clear, and spends each once', () => {
    const d = device()
    store.create({ username: 'drej', password: PASSWORD, device: d })
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

  it('replaces the previous set, so an old sheet of codes is worthless', () => {
    store.create({ username: 'drej', password: PASSWORD, device: device() })
    const old = store.mintRecoveryCodes('drej')
    const fresh = store.mintRecoveryCodes('drej')
    expect(store.useRecoveryCode('drej', old[0])).toBe(false)
    expect(store.useRecoveryCode('drej', fresh[0])).toBe(true)
  })
})

describe('the profile, the desktops and the password', () => {
  it('takes a display name and a small avatar, and refuses a big or foreign one', () => {
    store.create({ username: 'drej', password: PASSWORD, device: device() })
    expect(store.setProfile('drej', { displayName: 'Drej' }).ok).toBe(true)
    expect(store.get('drej')?.displayName).toBe('Drej')
    expect(store.setProfile('drej', { displayName: 'x'.repeat(41) }).ok).toBe(false)
    expect(store.setProfile('drej', { avatar: `data:image/png;base64,${'A'.repeat(40)}` }).ok).toBe(true)
    expect(store.setProfile('drej', { avatar: 'https://example.com/a.png' }).ok).toBe(false)
    expect(store.setProfile('drej', { avatar: `data:image/gif;base64,${'A'.repeat(40)}` }).ok).toBe(false)
    expect(store.setProfile('drej', { avatar: `data:image/png;base64,${'A'.repeat(90_000)}` }).ok).toBe(false)
  })

  it('records a desktop’s workspaces by name and id, and bounds both', () => {
    const d = device()
    store.create({ username: 'drej', password: PASSWORD, device: d })
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

  it('changes a password only when the current one is right', () => {
    store.create({ username: 'drej', password: PASSWORD, device: device() })
    expect(store.changePassword('drej', 'wrong', 'a longer new password').ok).toBe(false)
    expect(store.changePassword('drej', PASSWORD, 'short').ok).toBe(false)
    expect(store.changePassword('drej', PASSWORD, 'a longer new password').ok).toBe(true)
    expect(store.verifyPassword('drej', 'a longer new password')).toBe(true)
    expect(store.verifyPassword('drej', PASSWORD)).toBe(false)
  })

  it('shows a public profile with no devices on it', () => {
    const d = device()
    store.create({ username: 'drej', password: PASSWORD, device: d })
    store.setProfile('drej', { displayName: 'Drej' })
    const shown = store.publicProfile('drej')
    expect(shown).toEqual({ username: 'drej', displayName: 'Drej' })
    expect(JSON.stringify(shown)).not.toContain(d.id)
    expect(store.publicProfile('nobody')).toBeNull()
  })
})

describe('the file on disk', () => {
  it('is written atomically, private to its owner, and leaves no temp behind', () => {
    store.create({ username: 'drej', password: PASSWORD, device: device() })
    const file = path.join(dir, V2_FILE)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir).filter((n) => n.includes('.tmp'))).toEqual([])
    const reopened = new V2Accounts(dir)
    expect(reopened.has('drej')).toBe(true)
    expect(reopened.verifyPassword('drej', PASSWORD)).toBe(true)
  })

  it('refuses to start on a torn file, in a sentence that names it', () => {
    const file = path.join(dir, V2_FILE)
    writeFileSync(file, '{"accounts":[{"username":"drej"', { mode: 0o600 })
    expect(() => new V2Accounts(dir)).toThrow(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    // And it did not quietly reset: the bytes are still there for a human.
    expect(readFileSync(file, 'utf8')).toContain('drej')
  })

  it('refuses a file whose shape is wrong rather than reading past it', () => {
    const file = path.join(dir, V2_FILE)
    writeFileSync(file, JSON.stringify({ accounts: 'all of them' }), { mode: 0o600 })
    expect(() => new V2Accounts(dir)).toThrow(/accounts-v2\.json/)
    chmodSync(file, 0o600)
  })
})

describe('tokens', () => {
  it('mints a session and a call token on the registry’s own key and format', () => {
    const tokens = new V2Tokens(dir, { revoked: () => new Set(store.revokedDevices()) })
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

  it('rejects a bad signature, a wrong scope, an expired token and a revoked device', () => {
    const mac = device()
    const phone = device('phone', 'iPhone')
    store.create({ username: 'drej', password: PASSWORD, device: mac })
    store.signIn({ username: 'drej', password: PASSWORD, device: phone })
    const tokens = new V2Tokens(dir, { revoked: () => new Set(store.revokedDevices()) })

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

  it('shares the registry’s existing token key, so one key signs everything', () => {
    const a = new V2Tokens(dir)
    const b = new V2Tokens(dir)
    const minted = a.mintSession('drej', randomUUID(), 'jti-1')
    expect(b.verify(minted.token, 'session')?.sub).toBe('drej')
    expect(b.publicKeyJwk().kty).toBe('OKP')
  })
})

describe('the phase 4 seam', () => {
  it('asks for no second factor yet, and says so in one place', () => {
    store.create({ username: 'drej', password: PASSWORD, device: device() })
    const account = store.get('drej')
    expect(account).not.toBeNull()
    if (!account) return
    expect(store.nextFactorFor(account)).toBeNull()
  })
})
