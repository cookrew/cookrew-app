/**
 * WHAT THIS DEVICE REMEMBERS ABOUT A MAC, and nothing leaves it.
 *
 * The Mac's key is pinned, so a relay cannot swap it later. A saved password is
 * encrypted under a key the browser holds as non-extractable: the page can use
 * it but nothing can read it out. That protects the stored bytes, not the phone:
 * anyone who can open this page on it can use the saved password.
 */

export interface VaultStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  del(key: string): Promise<void>
}

export type KeyTrust = 'new' | 'same' | 'changed'

export interface UnlockVault {
  trust(machine: string, key: string): Promise<KeyTrust>
  pin(machine: string, key: string): Promise<void>
  remember(machine: string, password: string): Promise<void>
  recall(machine: string): Promise<string | null>
  forgetPassword(machine: string): Promise<void>
  /** Starts over with this Mac: for a key its owner has checked and knows changed. */
  forgetMac(machine: string): Promise<void>
}

const AES_KEY = 'key'
const pinOf = (machine: string): string => `pin:${machine}`
const secretOf = (machine: string): string => `secret:${machine}`

interface Sealed {
  iv: Uint8Array<ArrayBuffer>
  box: ArrayBuffer
}

export function createUnlockVault(store: VaultStore): UnlockVault {
  const aesKey = async (): Promise<CryptoKey> => {
    const held = (await store.get(AES_KEY)) as CryptoKey | undefined
    if (held) return held
    const made = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    await store.set(AES_KEY, made)
    return made
  }

  return {
    async trust(machine, key) {
      const pinned = await store.get(pinOf(machine))
      if (pinned === undefined) return 'new'
      return pinned === key ? 'same' : 'changed'
    },
    pin: (machine, key) => store.set(pinOf(machine), key),
    async remember(machine, password) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const box = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(), new TextEncoder().encode(password))
      await store.set(secretOf(machine), { iv, box } satisfies Sealed)
    },
    async recall(machine) {
      const saved = (await store.get(secretOf(machine))) as Sealed | undefined
      const key = (await store.get(AES_KEY)) as CryptoKey | undefined
      if (!saved || !key) return null
      try {
        return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: saved.iv }, key, saved.box))
      } catch {
        return null
      }
    },
    forgetPassword: (machine) => store.del(secretOf(machine)),
    async forgetMac(machine) {
      await store.del(secretOf(machine))
      await store.del(pinOf(machine))
    }
  }
}

const DATABASE = 'cookrew-unlock'
const TABLE = 'vault'

const opened = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(TABLE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('This browser would not open its storage'))
  })

const inTable = async <T>(mode: IDBTransactionMode, act: (table: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const database = await opened()
  return new Promise<T>((resolve, reject) => {
    const request = act(database.transaction(TABLE, mode).objectStore(TABLE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('This browser would not use its storage'))
  }).finally(() => database.close())
}

/** IndexedDB, the one store that can hold a CryptoKey without exposing it. */
export const browserVaultStore = (): VaultStore => ({
  get: (key) => inTable('readonly', (table) => table.get(key)),
  set: async (key, value) => void (await inTable('readwrite', (table) => table.put(value, key))),
  del: async (key) => void (await inTable('readwrite', (table) => table.delete(key)))
})
