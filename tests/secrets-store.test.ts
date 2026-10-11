// ONE FILE PER SECRET, UNDER A DIRECTORY NOBODY ELSE CAN LIST — and the
// value comes out of exactly one call.
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSecretsStore } from '../src/main/secrets-store'

const fresh = () => {
  const base = mkdtempSync(path.join(tmpdir(), 'cookrew-secrets-'))
  let t = 1_760_000_000_000
  const store = createSecretsStore({ baseDir: base, now: () => (t += 1000) })
  return { base, store }
}
const VALUE = 'sk_live_51Hx9QxTESTVALUE0000'

describe('createSecretsStore', () => {
  it('keeps the directory 0700 and each file 0600, written whole', () => {
    const { base, store } = fresh()
    store.put('stripe-key', VALUE)
    const dir = path.join(base, 'secrets')
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(path.join(dir, 'stripe-key')).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['stripe-key'])
    expect(JSON.parse(readFileSync(path.join(dir, 'stripe-key'), 'utf8'))).toMatchObject({
      value: VALUE,
      served: false
    })
  })

  it('reads back the value, the flag and both dates; an update keeps createdAt', () => {
    const { store } = fresh()
    const first = store.put('stripe-key', VALUE)
    const again = store.put('stripe-key', `${VALUE}2`, { served: true })
    const record = store.read('stripe-key')
    expect(record).toEqual({ value: `${VALUE}2`, served: true, createdAt: first.updatedAt, updatedAt: again.updatedAt })
    expect(again.updatedAt).toBeGreaterThan(first.updatedAt)
    expect(store.read('nothing-here')).toBeNull()
  })

  it('refuses a name that is not a slot name, and an empty value', () => {
    const { store } = fresh()
    for (const bad of ['Stripe', '-x', 'a b', 'a'.repeat(65), '../etc', '']) {
      expect(() => store.put(bad, VALUE)).toThrow(/not a secret name|value/)
      expect(() => store.read(bad)).toThrow(/not a secret name/)
    }
    expect(() => store.put('ok-name', '')).toThrow(/needs a value/)
  })

  it('list() carries names, flags and dates — NEVER a value', () => {
    const { store } = fresh()
    store.put('b-key', VALUE, { served: true })
    store.put('a-key', `${VALUE}A`)
    const rows = store.list()
    expect(rows.map((row) => row.name)).toEqual(['a-key', 'b-key'])
    expect(rows[1]).toEqual({ name: 'b-key', served: true, updatedAt: expect.any(Number) })
    expect(JSON.stringify(rows)).not.toContain('sk_live')
    expect(Object.keys(rows[0])).toEqual(['name', 'served', 'updatedAt'])
  })

  it('remove() forgets one secret and says whether there was one', () => {
    const { store } = fresh()
    store.put('a-key', VALUE)
    expect(store.remove('a-key')).toBe(true)
    expect(store.remove('a-key')).toBe(false)
    expect(store.read('a-key')).toBeNull()
    expect(store.list()).toEqual([])
  })

  it('an empty or missing directory lists nothing and reads null', () => {
    const { store } = fresh()
    expect(store.list()).toEqual([])
    expect(store.read('a-key')).toBeNull()
  })
})

describe('the write is wx: a planted file at the tmp path takes nothing', () => {
  it('fails the put rather than writing the value into someone else\'s file, and the sweep removes it', () => {
    const { base, store } = fresh()
    const dir = path.join(base, 'secrets')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const planted = path.join(dir, `stripe-key.${process.pid}.tmp`)
    writeFileSync(planted, 'planted', { mode: 0o644 })
    expect(() => store.put('stripe-key', VALUE)).toThrow(/EEXIST/)
    expect(readFileSync(planted, 'utf8')).toBe('planted')
    expect(store.read('stripe-key')).toBeNull()
    // list() and remove() sweep a stale tmp file; then the put lands.
    store.list()
    expect(readdirSync(dir)).toEqual([])
    store.put('stripe-key', VALUE)
    expect(store.read('stripe-key')?.value).toBe(VALUE)
    expect(statSync(path.join(dir, 'stripe-key')).mode & 0o777).toBe(0o600)
  })
})
