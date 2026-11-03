// THE KEYCHAIN OPT-IN: the value goes to `security`, the file keeps the
// facts, and everything above the store is unchanged. A fake `security`
// stands in for the real one and records exactly what it was asked.
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSecretsStore, KEYCHAIN_ENV, keychainService } from '../src/main/secrets-store'
import { cmdSecret, SECRET_EXIT, SecretCliError, type SecretAudit } from '../src/main/secret-cli'
import type { CliRequest, TerminalNodeData } from '../src/shared/model'

const VALUE = 'sk_live_51Hx9QxKEYCHAINONLY0000'

/** A `security` that keeps generic passwords in a JSON file and logs its argv. */
const fakeSecurity = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-fake-security-'))
  const db = path.join(dir, 'keychain.json')
  const log = path.join(dir, 'calls.jsonl')
  const bin = path.join(dir, 'security')
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs')
const db = ${JSON.stringify(db)}
const log = ${JSON.stringify(log)}
const argv = process.argv.slice(2)
fs.appendFileSync(log, JSON.stringify(argv) + '\\n')
const items = fs.existsSync(db) ? JSON.parse(fs.readFileSync(db, 'utf8')) : {}
const flag = (f) => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1] }
const key = flag('-a') + '|' + flag('-s')
const [cmd] = argv
if (cmd === 'add-generic-password') {
  if (items[key] !== undefined && !argv.includes('-U')) { process.stderr.write('exists'); process.exit(45) }
  items[key] = flag('-w'); fs.writeFileSync(db, JSON.stringify(items)); process.exit(0)
}
if (cmd === 'find-generic-password') {
  if (items[key] === undefined) { process.stderr.write('not found'); process.exit(44) }
  if (argv.includes('-w')) process.stdout.write(items[key] + '\\n')
  process.exit(0)
}
if (cmd === 'delete-generic-password') {
  if (items[key] === undefined) process.exit(44)
  delete items[key]; fs.writeFileSync(db, JSON.stringify(items)); process.exit(0)
}
process.exit(2)
`
  )
  chmodSync(bin, 0o755)
  return {
    bin,
    items: () => (readFileSync(db, 'utf8') ? (JSON.parse(readFileSync(db, 'utf8')) as Record<string, string>) : {}),
    calls: () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[])
  }
}

const fresh = (keychain: boolean | undefined, env?: NodeJS.ProcessEnv) => {
  const base = mkdtempSync(path.join(tmpdir(), 'cookrew-secrets-kc-'))
  const security = fakeSecurity()
  const store = createSecretsStore({ baseDir: base, keychain, security: security.bin, env: env ?? {} })
  return { base, security, store }
}

describe('the keychain backend', () => {
  it('puts the value in the keychain and only the facts in the 0600 file', () => {
    const { base, security, store } = fresh(true)
    store.put('stripe-key', VALUE, { served: true })
    expect(security.items()[`cookrew|${keychainService('stripe-key')}`]).toBe(VALUE)
    expect(security.calls()[0].slice(0, 7)).toEqual(['add-generic-password', '-U', '-a', 'cookrew', '-s', 'cookrew-secret-stripe-key', '-w'])
    const file = path.join(base, 'secrets', 'stripe-key')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain(VALUE)
    expect(JSON.parse(text)).toMatchObject({ keychain: true, served: true })
  })

  it('reads it back through `security -w`, lists without asking the keychain, removes both', () => {
    const { security, store } = fresh(true)
    store.put('stripe-key', VALUE)
    expect(store.read('stripe-key')).toMatchObject({ value: VALUE, served: false })
    const before = security.calls().length
    expect(store.list()).toEqual([{ name: 'stripe-key', served: false, updatedAt: expect.any(Number) }])
    expect(security.calls().length).toBe(before)
    expect(store.remove('stripe-key')).toBe(true)
    expect(security.items()).toEqual({})
    expect(store.read('stripe-key')).toBeNull()
    expect(readdirSync(path.join(store.dir))).toEqual([])
  })

  it('a file that says keychain with no item behind it is a secret that is gone', () => {
    const { security, store } = fresh(true)
    store.put('stripe-key', VALUE)
    // Someone removed the item from Keychain Access.
    writeFileSync(path.join(security.bin, '..', 'keychain.json'), '{}')
    expect(store.read('stripe-key')).toBeNull()
  })

  it('is opted into by COOKREW_SECRETS_KEYCHAIN=1 and off by default', () => {
    const off = fresh(undefined, {})
    off.store.put('a-key', VALUE)
    expect(readFileSync(path.join(off.base, 'secrets', 'a-key'), 'utf8')).toContain(VALUE)
    const on = fresh(undefined, { [KEYCHAIN_ENV]: '1' })
    on.store.put('a-key', VALUE)
    expect(readFileSync(path.join(on.base, 'secrets', 'a-key'), 'utf8')).not.toContain(VALUE)
    expect(on.security.items()).toHaveProperty(`cookrew|${keychainService('a-key')}`)
  })

  it('a keychain that refuses the write leaves no file behind', () => {
    const { base, store } = createSecretsStoreWithBrokenSecurity()
    expect(() => store.put('stripe-key', VALUE)).toThrow()
    expect(readdirSync(path.join(base, 'secrets'))).toEqual([])
  })

  it('above the store nothing changes: the same audit line, the same served refusal', () => {
    const { store } = fresh(true)
    store.put('stripe-key', VALUE, { served: true })
    const audits: SecretAudit[] = []
    const owner = { kind: 'terminal', id: 't-owner', name: 'Tinker' } as TerminalNodeData
    const seat = { kind: 'terminal', id: 't-seat', name: 'Seat', servedSession: { door: 'x' } } as unknown as TerminalNodeData
    const run = (me: TerminalNodeData) =>
      cmdSecret({ id: 'r', cmd: 'secret', args: ['read', 'stripe-key'], flags: {}, terminalId: me.id } as unknown as CliRequest, { secrets: store, self: () => me, audit: (e) => audits.push(e) })
    expect(run(owner)).toBe(VALUE)
    expect(audits).toEqual([{ type: 'secret.read', terminalId: 't-owner', name: 'stripe-key' }])
    let refused: SecretCliError | null = null
    try {
      run(seat)
    } catch (error) {
      refused = error as SecretCliError
    }
    expect(refused?.exitCode).toBe(SECRET_EXIT.refused)
    expect(audits).toHaveLength(1)
  })
})

const createSecretsStoreWithBrokenSecurity = () => {
  const base = mkdtempSync(path.join(tmpdir(), 'cookrew-secrets-kc-broken-'))
  const bin = path.join(base, 'security')
  writeFileSync(bin, '#!/bin/sh\nexit 1\n')
  chmodSync(bin, 0o755)
  return { base, store: createSecretsStore({ baseDir: base, keychain: true, security: bin }) }
}
