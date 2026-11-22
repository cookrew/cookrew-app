// WHAT A CONSOLE KEEPS FOR A REMEMBERED PASSWORD (renderer use/unlock-vault.ts): a box only the Mac opens, the id
// the Mac issued, and the connect code it was remembered under. Encrypted at rest under a non-extractable key.
import { describe, expect, it } from 'vitest'
import { createUnlockVault, type VaultStore } from '../src/renderer/src/use/unlock-vault'

const memory = () => {
  const rows = new Map<string, unknown>()
  const store: VaultStore = { get: async (k) => rows.get(k), set: async (k, v) => void rows.set(k, v), del: async (k) => void rows.delete(k) }
  return { rows, store }
}

const BOX = 'spki-part.sealed-part-canary-box-7c1e'

/** Everything a store row holds, bytes as text, a key as nothing (it cannot be read out). */
const dump = (value: unknown): string => {
  if (value instanceof CryptoKey) return ''
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return Buffer.from(value instanceof ArrayBuffer ? value : (value as Uint8Array).buffer).toString('latin1')
  if (typeof value === 'object' && value !== null) return Object.values(value).map(dump).join('|')
  return String(value)
}

describe('a remembered box in the vault', () => {
  it('is kept for one Mac under one code, and handed back only for that code', async () => {
    const { store } = memory()
    const vault = createUnlockVault(store)
    await vault.keepBox('m', { box: BOX, id: 'id-1', code: 'code-1' })
    expect(await vault.boxFor('m', 'code-1')).toEqual({ box: BOX, id: 'id-1' })
    expect(await vault.boxFor('other-mac', 'code-1')).toBeNull()
  })

  it('a page holding another code (re-paired, or the Mac rotated) drops the box for good', async () => {
    const { store } = memory()
    const vault = createUnlockVault(store)
    await vault.keepBox('m', { box: BOX, id: 'id-1', code: 'code-1' })
    expect(await vault.boxFor('m', 'code-2')).toBeNull()
    expect(await vault.boxFor('m', 'code-1')).toBeNull()
  })

  it('is encrypted at rest: neither the box nor its id is in what the store holds', async () => {
    const { rows, store } = memory()
    const vault = createUnlockVault(store)
    await vault.keepBox('m', { box: BOX, id: 'id-canary-9f', code: 'code-1' })
    const raw = [...rows.entries()].map(([k, v]) => `${k}=${dump(v)}`).join('\n')
    expect(raw).not.toContain('canary-box')
    expect(raw).not.toContain('id-canary')
    const key = [...rows.values()].find((v) => v instanceof CryptoKey) as CryptoKey
    expect(key.extractable).toBe(false)
  })

  it('Forget drops it and says which id to give back; a changed key drops it too', async () => {
    const { store } = memory()
    const vault = createUnlockVault(store)
    await vault.keepBox('m', { box: BOX, id: 'id-1', code: 'code-1' })
    expect(await vault.dropBox('m')).toBe('id-1')
    expect(await vault.boxFor('m', 'code-1')).toBeNull()
    expect(await vault.dropBox('m')).toBeNull()
    await vault.keepBox('m', { box: BOX, id: 'id-2', code: 'code-1' })
    await vault.repin('m', 'a-new-key')
    expect(await vault.boxFor('m', 'code-1')).toBeNull()
  })

  it('a box that does not decrypt (the key lost, or the bytes changed) is no box', async () => {
    const { rows, store } = memory()
    const vault = createUnlockVault(store)
    await vault.keepBox('m', { box: BOX, id: 'id-1', code: 'code-1' })
    rows.delete('key')
    expect(await vault.boxFor('m', 'code-1')).toBeNull()
  })
})
