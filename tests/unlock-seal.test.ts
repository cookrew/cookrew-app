// THE PHONE'S HALF, proved against the Mac's: WebCrypto seals, Node opens.
import { describe, expect, it } from 'vitest'
import { generateSealKeyPair, openBody } from '../src/shared/relay-seal'
import { UNLOCK_INFO } from '../src/shared/remote-unlock'
import { createUnlockVault, type VaultStore } from '../src/renderer/src/use/unlock-vault'
import { sealForMac, wordsOfKey } from '../src/renderer/src/use/unlock-seal'

const memory = (): VaultStore & { rows: Map<string, unknown> } => {
  const rows = new Map<string, unknown>()
  return {
    rows,
    get: async (key) => rows.get(key),
    set: async (key, value) => void rows.set(key, value),
    del: async (key) => void rows.delete(key)
  }
}

describe('sealForMac', () => {
  it('opens on the Mac, and only there', async () => {
    const mac = generateSealKeyPair()
    const wire = await sealForMac(mac.publicKey, JSON.stringify({ c: 'x', p: 'pässword' }))
    expect(JSON.parse(openBody(mac.privateKey, UNLOCK_INFO, wire) ?? '{}')).toEqual({ c: 'x', p: 'pässword' })
    expect(openBody(generateSealKeyPair().privateKey, UNLOCK_INFO, wire)).toBeNull()
    expect(wire).not.toContain('password')
  })

  it('never seals the same way twice', async () => {
    const { publicKey } = generateSealKeyPair()
    expect(await sealForMac(publicKey, 'same')).not.toBe(await sealForMac(publicKey, 'same'))
  })
})

describe('wordsOfKey', () => {
  it('speaks a key in six words, the same each time, and differently for another key', async () => {
    const a = generateSealKeyPair().publicKey
    const words = await wordsOfKey(a)
    expect(words).toHaveLength(6)
    expect(await wordsOfKey(a)).toEqual(words)
    expect(await wordsOfKey(generateSealKeyPair().publicKey)).not.toEqual(words)
  })
})

describe('the vault', () => {
  it('trusts a key the first time it is told to, and notices a new one', async () => {
    const vault = createUnlockVault(memory())
    expect(await vault.trust('m', 'key-a')).toBe('new')
    await vault.pin('m', 'key-a')
    expect(await vault.trust('m', 'key-a')).toBe('same')
    expect(await vault.trust('m', 'key-b')).toBe('changed')
    expect(await vault.trust('other-mac', 'key-b')).toBe('new')
  })

  it('keeps a password on this device, and never as the password', async () => {
    const store = memory()
    const vault = createUnlockVault(store)
    await vault.remember('m', 'correct horse')
    expect(await vault.recall('m')).toBe('correct horse')
    const raw = JSON.stringify([...store.rows.entries()].filter(([key]) => key.startsWith('secret:')), (_k, v) => (v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? Buffer.from(v as Uint8Array).toString('latin1') : v))
    expect(raw).not.toContain('correct horse')
  })

  it('its key cannot be read out, only used', async () => {
    const store = memory()
    await createUnlockVault(store).remember('m', 'x')
    const key = store.rows.get('key') as CryptoKey
    expect(key.extractable).toBe(false)
  })

  it('forgets a saved password, and a forgotten Mac starts over', async () => {
    const vault = createUnlockVault(memory())
    await vault.pin('m', 'key-a')
    await vault.remember('m', 'x')
    await vault.forgetPassword('m')
    expect(await vault.recall('m')).toBeNull()
    expect(await vault.trust('m', 'key-a')).toBe('same')
    await vault.remember('m', 'x')
    await vault.forgetMac('m')
    expect(await vault.recall('m')).toBeNull()
    expect(await vault.trust('m', 'key-b')).toBe('new')
  })

  it('a saved password that will not open reads as none', async () => {
    const store = memory()
    const vault = createUnlockVault(store)
    await vault.remember('m', 'x')
    store.rows.delete('key')
    expect(await vault.recall('m')).toBeNull()
  })
})
