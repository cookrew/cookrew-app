// THE OLD KEYCHAIN OPT-IN, ON ITS WAY OUT: a file marked `keychain` still reads,
// `migrate` seals it and takes the item, and nothing writes that way again. A
// fake `security` stands in for the real one and records what it was asked.
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSecretsStore, keychainService, type SecretSealer } from '../src/main/secrets-store'
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

const SEALER: SecretSealer = {
  available: () => true,
  seal: (value) => Buffer.from(`v10:${Buffer.from(value).toString('hex')}`),
  open: (box) => Buffer.from(box.toString().replace(/^v10:/, ''), 'hex').toString()
}

const KEY = `cookrew|${keychainService('stripe-key')}`

/** A secret as COOKREW_SECRETS_KEYCHAIN=1 left it: the facts in the file, the value in an item. */
const legacy = (withItem = true) => {
  const base = mkdtempSync(path.join(tmpdir(), 'cookrew-secrets-kc-'))
  const security = fakeSecurity()
  mkdirSync(path.join(base, 'secrets'), { recursive: true, mode: 0o700 })
  writeFileSync(path.join(base, 'secrets', 'stripe-key'), JSON.stringify({ keychain: true, served: true, createdAt: 5, updatedAt: 9 }), { mode: 0o600 })
  if (withItem) writeFileSync(path.join(security.bin, '..', 'keychain.json'), JSON.stringify({ [KEY]: VALUE }))
  else writeFileSync(path.join(security.bin, '..', 'keychain.json'), '{}')
  const store = createSecretsStore({ baseDir: base, sealer: SEALER, security: security.bin })
  return { base, security, store }
}

describe('a value in the old keychain item', () => {
  it('still reads, and lists without asking the keychain', () => {
    const { security, store } = legacy()
    expect(store.read('stripe-key')).toMatchObject({ value: VALUE, served: true })
    const before = security.calls().length
    expect(store.list()).toEqual([{ name: 'stripe-key', served: true, updatedAt: 9 }])
    expect(security.calls().length).toBe(before)
  })

  it('is sealed by migrate, and the item goes', () => {
    const { base, security, store } = legacy()
    expect(store.migrate()).toEqual({ sealed: ['stripe-key'], failed: [] })
    expect(security.items()).toEqual({})
    const stored = JSON.parse(readFileSync(path.join(base, 'secrets', 'stripe-key'), 'utf8')) as Record<string, unknown>
    expect(stored.keychain).toBeUndefined()
    expect(typeof stored.sealed).toBe('string')
    expect(store.read('stripe-key')).toEqual({ value: VALUE, served: true, createdAt: 5, updatedAt: 9 })
  })

  it('a mark with no item behind it stays as it was, and is named', () => {
    const { base, store } = legacy(false)
    const before = readFileSync(path.join(base, 'secrets', 'stripe-key'), 'utf8')
    expect(store.read('stripe-key')).toBeNull()
    expect(store.migrate()).toEqual({ sealed: [], failed: ['stripe-key'] })
    expect(readFileSync(path.join(base, 'secrets', 'stripe-key'), 'utf8')).toBe(before)
  })

  it('a new seal replaces it and takes the item, and no value is ever passed to `security`', () => {
    const { security, store } = legacy()
    store.put('stripe-key', 'sk_new_value')
    expect(security.items()).toEqual({})
    expect(store.read('stripe-key')?.value).toBe('sk_new_value')
    expect(security.calls().flat().join(' ')).not.toContain('sk_new_value')
    expect(security.calls().some((argv) => argv[0] === 'add-generic-password')).toBe(false)
  })

  it('remove takes the file and the item', () => {
    const { security, store } = legacy()
    expect(store.remove('stripe-key')).toBe(true)
    expect(security.items()).toEqual({})
    expect(readdirSync(store.dir)).toEqual([])
  })
})

describe('above the store', () => {
  it('nothing changes: the same audit line, the same served refusal', () => {
    const { store } = legacy()
    store.migrate()
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
