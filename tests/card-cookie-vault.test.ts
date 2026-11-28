// A CARD'S COOKIES KEPT ACROSS A CHROME RESTART (card-cookie-vault.ts): sealed
// with the app's keychain key, written beside the card's profile, and read back
// as exactly the cookies Chrome would take again. Never plaintext, never a
// throw into startup.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCardCookieVault, VAULT_FILE, type CardCookieVaultDeps } from '../src/main/card-cookie-vault'
import type { SafeStorageLike } from '../src/main/secrets-seal'

const PREFIX = 'SEALED:'

/** Stands in for safeStorage: reversible, never the value's own bytes, and a wrong tag throws. */
function fakeSafeStorage(available = true): SafeStorageLike & { sealed: number } {
  const safe = {
    sealed: 0,
    isEncryptionAvailable: () => available,
    encryptString: (value: string): Buffer => {
      safe.sealed += 1
      return Buffer.from(PREFIX + Buffer.from(value, 'utf8').toString('base64').split('').reverse().join(''))
    },
    decryptString: (box: Buffer): string => {
      const text = box.toString('latin1')
      if (!text.startsWith(PREFIX)) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return Buffer.from(text.slice(PREFIX.length).split('').reverse().join(''), 'base64').toString('utf8')
    }
  }
  return safe
}

/** What Storage.getCookies answers for a session cookie (Aliyun's login is one). */
const SESSION = {
  name: 'login_aliyunid_ticket',
  value: 'T-0123456789',
  domain: '.aliyun.com',
  path: '/',
  expires: -1,
  size: 32,
  httpOnly: true,
  secure: true,
  session: true,
  sameSite: 'None',
  priority: 'Medium',
  sameParty: false,
  sourceScheme: 'Secure',
  sourcePort: 443
}

/** A host-only persistent cookie. */
const PERSISTENT = {
  name: 'cf_clearance',
  value: 'clear-abc',
  domain: 'dash.cloudflare.com',
  path: '/',
  expires: 4102444800,
  size: 21,
  httpOnly: false,
  secure: true,
  session: false,
  sameSite: 'Lax',
  priority: 'Medium',
  sourceScheme: 'Secure',
  sourcePort: 443
}

const PARTITIONED = {
  name: '__Host-chips',
  value: 'p1',
  domain: 'widget.example',
  path: '/',
  expires: -1,
  httpOnly: true,
  secure: true,
  session: true,
  sameSite: 'None',
  partitionKey: { topLevelSite: 'https://example.com', hasCrossSiteAncestor: false }
}

let root: string
let lines: string[]

function vault(over: Partial<CardCookieVaultDeps> = {}) {
  return createCardCookieVault({
    safeStorage: fakeSafeStorage(),
    profileRoot: () => root,
    log: (line) => lines.push(line),
    now: () => Date.UTC(2026, 10, 28),
    platform: 'darwin',
    ...over
  })
}

const fileOf = (id: string): string => path.join(root, id, VAULT_FILE)

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'card-cookie-vault-'))
  mkdirSync(path.join(root, 'card-a'))
  lines = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('saving a card', () => {
  it('round-trips the fields Chrome takes back, session cookies included', () => {
    const v = vault()
    expect(v.save('card-a', [SESSION, PERSISTENT, PARTITIONED])).toEqual({ saved: 3 })
    expect(v.load('card-a')).toEqual([
      { name: 'login_aliyunid_ticket', value: 'T-0123456789', domain: '.aliyun.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' },
      { name: 'cf_clearance', value: 'clear-abc', domain: 'dash.cloudflare.com', path: '/', expires: 4102444800, httpOnly: false, secure: true, sameSite: 'Lax' },
      {
        name: '__Host-chips',
        value: 'p1',
        domain: 'widget.example',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None',
        partitionKey: { topLevelSite: 'https://example.com', hasCrossSiteAncestor: false }
      }
    ])
  })

  it('writes ciphertext only, owner-only, with no temp file left behind', () => {
    vault().save('card-a', [SESSION])
    const bytes = readFileSync(fileOf('card-a'))
    expect(bytes.toString('latin1')).not.toContain('T-0123456789')
    expect(bytes.toString('latin1')).not.toContain('aliyun')
    expect(statSync(fileOf('card-a')).mode & 0o777).toBe(0o600)
    expect(readdirSync(path.join(root, 'card-a'))).toEqual([VAULT_FILE])
  })

  it('keeps an empty value and unicode values exactly', () => {
    const v = vault()
    const empty = { ...PERSISTENT, name: 'flag', value: '' }
    const unicode = { ...PERSISTENT, name: 'who', value: '王小明 ✓ é 🍪' }
    v.save('card-a', [empty, unicode])
    expect(v.load('card-a')?.map((c) => c.value)).toEqual(['', '王小明 ✓ é 🍪'])
  })

  it('drops fields setCookies does not take, and a cookie with no domain', () => {
    const v = vault()
    v.save('card-a', [{ ...PERSISTENT, somethingNew: { nested: true } }, { name: 'x', value: 'y', path: '/' }])
    const [only, ...rest] = v.load('card-a') ?? []
    expect(rest).toEqual([])
    expect(Object.keys(only).sort()).toEqual(['domain', 'expires', 'httpOnly', 'name', 'path', 'sameSite', 'secure', 'value'])
  })

  it('refuses to write anything when encryption is unavailable (fail closed)', () => {
    const v = vault({ safeStorage: fakeSafeStorage(false) })
    expect(v.save('card-a', [SESSION])).toEqual({ refused: 'no-encryption' })
    expect(existsSync(fileOf('card-a'))).toBe(false)
    expect(lines.join('\n')).toMatch(/encryption/i)
  })

  it('refuses on Linux when the keyring is the basic_text fallback', () => {
    const safe = { ...fakeSafeStorage(), getSelectedStorageBackend: () => 'basic_text' }
    const v = vault({ safeStorage: safe, platform: 'linux' })
    expect(v.save('card-a', [SESSION])).toEqual({ refused: 'no-encryption' })
    expect(existsSync(fileOf('card-a'))).toBe(false)
  })

  it('refuses a list over the cookie cap, says so, and leaves no stale vault', () => {
    const v = vault({ maxCookies: 3 })
    v.save('card-a', [SESSION])
    const many = Array.from({ length: 4 }, (_, i) => ({ ...PERSISTENT, name: `c${i}` }))
    expect(v.save('card-a', many)).toEqual({ refused: 'too-many' })
    expect(existsSync(fileOf('card-a'))).toBe(false)
    expect(lines.join('\n')).toMatch(/4 cookies.*3/)
  })

  it('refuses a list over the byte cap', () => {
    const v = vault({ maxBytes: 1024 })
    const big = Array.from({ length: 4 }, (_, i) => ({ ...PERSISTENT, name: `c${i}`, value: 'x'.repeat(400) }))
    expect(v.save('card-a', big)).toEqual({ refused: 'too-large' })
    expect(existsSync(fileOf('card-a'))).toBe(false)
    expect(lines.join('\n')).toMatch(/bytes/)
  })

  it('never logs a cookie value', () => {
    vault({ maxCookies: 0 }).save('card-a', [SESSION])
    vault({ safeStorage: fakeSafeStorage(false) }).save('card-a', [SESSION])
    expect(lines.join('\n')).not.toContain('T-0123456789')
  })

  it('refuses a card id that would leave the profile root', () => {
    expect(vault().save('../escape', [SESSION])).toEqual({ refused: 'bad-card' })
    expect(existsSync(path.join(path.dirname(root), VAULT_FILE))).toBe(false)
  })

  it('reports a write that fails instead of throwing', () => {
    expect(vault().save('no-such-profile', [SESSION])).toEqual({ refused: 'write-failed' })
  })
})

describe('loading a card', () => {
  it('is null for a card that has no vault yet, without a log line', () => {
    expect(vault().load('card-a')).toBeNull()
    expect(lines).toEqual([])
  })

  it('is null for a corrupt file and logs once', () => {
    writeFileSync(fileOf('card-a'), Buffer.from([0, 1, 2, 3, 250]))
    const v = vault()
    expect(v.load('card-a')).toBeNull()
    expect(v.load('card-a')).toBeNull()
    expect(lines).toHaveLength(1)
  })

  it('is null for a sealed value of an old or unknown format', () => {
    const safe = fakeSafeStorage()
    writeFileSync(fileOf('card-a'), safe.encryptString(JSON.stringify([SESSION])))
    expect(vault({ safeStorage: safe }).load('card-a')).toBeNull()
    writeFileSync(fileOf('card-a'), safe.encryptString(JSON.stringify({ v: 99, cookies: [SESSION] })))
    expect(vault({ safeStorage: safe }).load('card-a')).toBeNull()
    writeFileSync(fileOf('card-a'), safe.encryptString('not json'))
    expect(vault({ safeStorage: safe }).load('card-a')).toBeNull()
  })

  it('is null when the key cannot open it (a bad tag, another app name)', () => {
    vault().save('card-a', [SESSION])
    const other: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => {
        throw new Error('bad tag')
      }
    }
    expect(vault({ safeStorage: other }).load('card-a')).toBeNull()
    expect(lines.join('\n')).toMatch(/could not be opened/)
  })

  it('is null when encryption is unavailable now', () => {
    vault().save('card-a', [SESSION])
    expect(vault({ safeStorage: fakeSafeStorage(false) }).load('card-a')).toBeNull()
  })

  it('does not follow a symlink in place of the vault', () => {
    const elsewhere = path.join(root, 'elsewhere.bin')
    writeFileSync(elsewhere, fakeSafeStorage().encryptString(JSON.stringify({ v: 1, cookies: [SESSION] })))
    symlinkSync(elsewhere, fileOf('card-a'))
    expect(vault().load('card-a')).toBeNull()
  })

  it('leaves out a cookie that has expired since it was kept', () => {
    const v = vault()
    v.save('card-a', [PERSISTENT, { ...PERSISTENT, name: 'old', expires: Date.UTC(2026, 0, 1) / 1000 }])
    expect(v.load('card-a')?.map((c) => c.name)).toEqual(['cf_clearance'])
  })

  it('never throws for a bad card id', () => {
    expect(() => vault().load('../x')).not.toThrow()
    expect(vault().load('../x')).toBeNull()
  })
})

describe('forgetting every card', () => {
  it('deletes each vault and keeps every profile', () => {
    mkdirSync(path.join(root, 'card-b'))
    writeFileSync(path.join(root, 'card-b', 'Cookies'), 'chrome-db')
    const v = vault()
    v.save('card-a', [SESSION])
    v.save('card-b', [PERSISTENT])
    expect(v.forgetAll()).toBe(2)
    expect(existsSync(fileOf('card-a'))).toBe(false)
    expect(existsSync(fileOf('card-b'))).toBe(false)
    expect(existsSync(path.join(root, 'card-a'))).toBe(true)
    expect(readFileSync(path.join(root, 'card-b', 'Cookies'), 'utf8')).toBe('chrome-db')
    expect(v.load('card-a')).toBeNull()
  })

  it('is 0 when there is no profile root yet', () => {
    expect(vault({ profileRoot: () => path.join(root, 'missing') }).forgetAll()).toBe(0)
  })
})
