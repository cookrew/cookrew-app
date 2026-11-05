// A SEALED SECRET IS ENCRYPTED AT REST (owner 2026-11-05): the file holds
// ciphertext, and the key sits in the keychain under the app's own ACL, so a
// process that reads the file gets nothing and an agent has to go through
// `cookrew secret`, where the read is audited. Migration is the one place a
// real value can be lost, so most of this file is about what it must not do.

import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSecretsStore, type SecretSealer } from '../src/main/secrets-store'
import { electronSealer, excludeFromBackup } from '../src/main/secrets-seal'

const VALUE = 'sk_live_51Hx9QxSEALEDVALUE0000'

/** Stands in for safeStorage: reversible, and never the value's own bytes. */
const sealer = (over: Partial<SecretSealer> = {}): SecretSealer => ({
  available: () => true,
  seal: (value) => Buffer.from(`v10:${Buffer.from(value).toString('hex')}`),
  open: (box) => Buffer.from(box.toString().replace(/^v10:/, ''), 'hex').toString(),
  ...over
})

const base = (): string => mkdtempSync(path.join(tmpdir(), 'cookrew-seal-'))
const fileIn = (dir: string, name: string): string => path.join(dir, 'secrets', name)

/** A secret as every version before this one wrote it. */
const plain = (dir: string, name: string, value = VALUE): void => {
  mkdirSync(path.join(dir, 'secrets'), { recursive: true, mode: 0o700 })
  writeFileSync(fileIn(dir, name), JSON.stringify({ value, served: true, createdAt: 5, updatedAt: 9 }), { mode: 0o600 })
}

describe('sealing', () => {
  it('leaves ciphertext in the file and gives the value back to read', () => {
    const dir = base()
    const store = createSecretsStore({ baseDir: dir, sealer: sealer() })
    const row = store.put('stripe-key', VALUE, { served: true })
    expect(row).toMatchObject({ name: 'stripe-key', served: true })
    const raw = readFileSync(fileIn(dir, 'stripe-key'), 'utf8')
    expect(raw).not.toContain(VALUE)
    const stored = JSON.parse(raw) as Record<string, unknown>
    expect(stored.value).toBeUndefined()
    expect(typeof stored.sealed).toBe('string')
    expect(statSync(fileIn(dir, 'stripe-key')).mode & 0o777).toBe(0o600)
    expect(store.read('stripe-key')).toMatchObject({ value: VALUE, served: true })
  })

  it('lists a sealed secret without opening it', () => {
    const dir = base()
    const store = createSecretsStore({ baseDir: dir, sealer: sealer() })
    store.put('stripe-key', VALUE)
    const blind = createSecretsStore({ baseDir: dir, sealer: sealer({ open: () => { throw new Error('asked') } }) })
    expect(blind.list().map((row) => row.name)).toEqual(['stripe-key'])
  })

  it('refuses to write in the clear where the keychain is required and absent', () => {
    const dir = base()
    const store = createSecretsStore({ baseDir: dir, sealer: sealer({ available: () => false }), requireSealer: true })
    expect(() => store.put('stripe-key', VALUE)).toThrow(/keychain/)
    expect(() => readFileSync(fileIn(dir, 'stripe-key'))).toThrow()
  })

  it('never puts the value in an error', () => {
    const store = createSecretsStore({ baseDir: base(), sealer: sealer({ seal: () => { throw new Error('locked') } }) })
    let said = ''
    try {
      store.put('stripe-key', VALUE)
    } catch (e) {
      said = String(e)
    }
    expect(said).toContain('stripe-key')
    expect(said).not.toContain(VALUE)
  })
})

describe('a sealed value another build cannot open', () => {
  const stuck = (warn: (m: string) => void = () => undefined) => {
    const dir = base()
    createSecretsStore({ baseDir: dir, sealer: sealer() }).put('stripe-key', VALUE)
    return { dir, store: createSecretsStore({ baseDir: dir, sealer: sealer({ open: () => { throw new Error('wrong key') } }), warn }) }
  }

  it('reads as nothing, stays listed, and is said once, by name only', () => {
    const said: string[] = []
    const { store } = stuck((m) => said.push(m))
    expect(store.read('stripe-key')).toBeNull()
    expect(store.read('stripe-key')).toBeNull()
    expect(store.list().map((row) => row.name)).toEqual(['stripe-key'])
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('stripe-key')
  })

  it('is left on disk by a migration, and replaced by a new seal', () => {
    const { dir, store } = stuck()
    const before = readFileSync(fileIn(dir, 'stripe-key'), 'utf8')
    store.migrate()
    expect(readFileSync(fileIn(dir, 'stripe-key'), 'utf8')).toBe(before)
    store.put('stripe-key', 'sk_new')
    expect(readFileSync(fileIn(dir, 'stripe-key'), 'utf8')).not.toBe(before)
  })
})

describe('a box that opens to the wrong thing', () => {
  it('is not taken for a value: noise from a wrong key reads as nothing', () => {
    const dir = base()
    createSecretsStore({ baseDir: dir, sealer: sealer() }).put('stripe-key', VALUE)
    expect(createSecretsStore({ baseDir: dir, sealer: sealer({ open: () => 'a7f3-noise' }) }).read('stripe-key')).toBeNull()
  })

  it('a file moved to another name does not open there', () => {
    const dir = base()
    const store = createSecretsStore({ baseDir: dir, sealer: sealer() })
    store.put('a-key', VALUE)
    writeFileSync(fileIn(dir, 'b-key'), readFileSync(fileIn(dir, 'a-key')), { mode: 0o600 })
    expect(store.read('b-key')).toBeNull()
    expect(store.read('a-key')?.value).toBe(VALUE)
  })

  it('a value with newlines comes back whole', () => {
    const store = createSecretsStore({ baseDir: base(), sealer: sealer() })
    const pem = '-----BEGIN KEY-----\nabc\n\ndef\n-----END KEY-----\n'
    store.put('pem-key', pem)
    expect(store.read('pem-key')?.value).toBe(pem)
  })
})

describe('moving a clear file in', () => {
  it('seals it in place: same name, same dates, same flag, no clear value left', () => {
    const dir = base()
    plain(dir, 'dsv4')
    const store = createSecretsStore({ baseDir: dir, sealer: sealer() })
    expect(store.read('dsv4')?.value).toBe(VALUE)
    expect(store.migrate()).toEqual({ sealed: ['dsv4'], failed: [] })
    const raw = readFileSync(fileIn(dir, 'dsv4'), 'utf8')
    expect(raw).not.toContain(VALUE)
    expect(store.read('dsv4')).toEqual({ value: VALUE, served: true, createdAt: 5, updatedAt: 9 })
    expect(statSync(fileIn(dir, 'dsv4')).mode & 0o777).toBe(0o600)
    expect(readdirSync(path.join(dir, 'secrets'))).toEqual(['dsv4'])
  })

  it('does nothing the second time', () => {
    const dir = base()
    plain(dir, 'dsv4')
    const store = createSecretsStore({ baseDir: dir, sealer: sealer() })
    store.migrate()
    const after = readFileSync(fileIn(dir, 'dsv4'), 'utf8')
    expect(store.migrate()).toEqual({ sealed: [], failed: [] })
    expect(readFileSync(fileIn(dir, 'dsv4'), 'utf8')).toBe(after)
  })

  it('keeps the clear file when the sealed copy does not open back to the same value', () => {
    const dir = base()
    plain(dir, 'dsv4')
    const before = readFileSync(fileIn(dir, 'dsv4'), 'utf8')
    const store = createSecretsStore({ baseDir: dir, sealer: sealer({ open: () => 'something else' }) })
    expect(store.migrate()).toEqual({ sealed: [], failed: ['dsv4'] })
    expect(readFileSync(fileIn(dir, 'dsv4'), 'utf8')).toBe(before)
  })

  it('keeps the clear file when sealing throws, and goes on to the next', () => {
    const dir = base()
    plain(dir, 'a-key', 'first')
    plain(dir, 'b-key', 'second')
    const before = readFileSync(fileIn(dir, 'a-key'), 'utf8')
    const good = sealer()
    const store = createSecretsStore({ baseDir: dir, sealer: sealer({ seal: (v) => { if (v.endsWith('first')) throw new Error('locked'); return good.seal(v) } }) })
    expect(store.migrate()).toEqual({ sealed: ['b-key'], failed: ['a-key'] })
    expect(readFileSync(fileIn(dir, 'a-key'), 'utf8')).toBe(before)
    expect(store.read('a-key')?.value).toBe('first')
  })

  it('leaves everything alone with no keychain, and it still reads', () => {
    const dir = base()
    plain(dir, 'dsv4')
    const before = readFileSync(fileIn(dir, 'dsv4'), 'utf8')
    const store = createSecretsStore({ baseDir: dir, sealer: sealer({ available: () => false }) })
    expect(store.migrate()).toEqual({ sealed: [], failed: [] })
    expect(readFileSync(fileIn(dir, 'dsv4'), 'utf8')).toBe(before)
    expect(store.read('dsv4')?.value).toBe(VALUE)
  })
})

describe('the backups', () => {
  it('are told to leave the directory out, once, when it exists', () => {
    const dir = base()
    const asked: string[] = []
    const store = createSecretsStore({ baseDir: dir, sealer: sealer(), excludeFromBackup: (d) => asked.push(d) })
    store.migrate()
    store.put('a-key', 'v')
    store.put('b-key', 'v')
    expect(asked).toEqual([path.join(dir, 'secrets')])
  })

  it('run tmutil on a Mac, say a failure, and never throw', () => {
    const ran: string[][] = []
    excludeFromBackup('/x/secrets', { platform: 'darwin', run: (bin, args) => ran.push([bin, ...args]), warn: () => undefined })
    expect(ran).toEqual([['tmutil', 'addexclusion', '/x/secrets']])
    const said: string[] = []
    excludeFromBackup('/x/secrets', { platform: 'darwin', run: () => { throw new Error('no') }, warn: (m) => said.push(m) })
    expect(said[0]).toContain('backup')
    const none: string[][] = []
    excludeFromBackup('/x/secrets', { platform: 'linux', run: (bin, args) => none.push([bin, ...args]), warn: () => undefined })
    expect(none).toEqual([])
  })
})

describe('the sealer over safeStorage', () => {
  const safe = (over: Record<string, unknown> = {}) => ({
    isEncryptionAvailable: () => true,
    encryptString: (v: string) => Buffer.from(`c:${v}`),
    decryptString: (b: Buffer) => b.toString().slice(2),
    ...over
  })

  it('seals and opens through it', () => {
    const s = electronSealer(safe(), 'darwin')
    expect(s.available()).toBe(true)
    expect(s.open(s.seal('v'))).toBe('v')
  })

  it("does not take Linux's hardcoded key for a keychain", () => {
    expect(electronSealer(safe({ getSelectedStorageBackend: () => 'basic_text' }), 'linux').available()).toBe(false)
    expect(electronSealer(safe({ getSelectedStorageBackend: () => 'gnome_libsecret' }), 'linux').available()).toBe(true)
  })

  it('reads as unavailable when asking throws', () => {
    expect(electronSealer(safe({ isEncryptionAvailable: () => { throw new Error('early') } }), 'darwin').available()).toBe(false)
  })
})

describe('the app', () => {
  const main = readFileSync('src/main/index.ts', 'utf8')

  it('seals by default, on a Mac with no clear fallback, and moves the old files at boot', () => {
    expect(main).toContain('sealer: electronSealer(safeStorage)')
    expect(main).toContain("requireSealer: process.platform === 'darwin'")
    expect(main).toContain('secrets.migrate()')
  })

  it('has no opt-in left: a value never goes on a command line', () => {
    const store = readFileSync('src/main/secrets-store.ts', 'utf8')
    expect(store).not.toContain('add-generic-password')
    expect(store).not.toContain('COOKREW_SECRETS_KEYCHAIN')
  })
})
