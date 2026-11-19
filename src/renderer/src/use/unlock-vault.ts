/**
 * WHAT THIS DEVICE REMEMBERS ABOUT A MAC, and nothing leaves it.
 *
 * The Mac's key is pinned, so a relay cannot swap it later. A saved password is
 * encrypted under a key the browser holds as non-extractable: the page can use
 * it but nothing can read it out. That protects the stored bytes, not the phone:
 * anyone who can open this page on it can use the saved password.
 *
 * ON THE CONSOLE (Remember over cookrew-seal/2) the password is not what is kept. The Mac
 * issues an id for it, and the page keeps a BOX: the password and that id, sealed to the
 * Mac's unlock key (main/remote-unlock.ts · REMEMBER_INFO). Only the Mac opens it, and the
 * Mac can refuse it (its id dropped) without this device. Kept here under the same
 * non-extractable key, with the connect code's id it was remembered under: a page holding
 * another code drops it, since the Mac's ids went with the old code.
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
  /** Trusts exactly this key in place of the pinned one, and drops what the old one held. */
  repin(machine: string, key: string): Promise<void>
  /** A remembered box for this Mac, under the connect code (its id) it was remembered under. */
  keepBox(machine: string, kept: RememberedBox & { readonly code: string }): Promise<void>
  /** The box for this Mac under this code; one kept under another code is dropped. */
  boxFor(machine: string, code: string): Promise<RememberedBox | null>
  /** Forgets this Mac's box; the id to give back to the Mac, if there was one. */
  dropBox(machine: string): Promise<string | null>
}

export interface RememberedBox {
  /** Sealed to the Mac's unlock key: only the Mac opens it. */
  readonly box: string
  /** The id the Mac issued for it. */
  readonly id: string
}

const AES_KEY = 'key'
const pinOf = (machine: string): string => `pin:${machine}`
const secretOf = (machine: string): string => `secret:${machine}`
const boxOf = (machine: string): string => `box:${machine}`

interface Sealed {
  iv: Uint8Array<ArrayBuffer>
  box: ArrayBuffer
}

const readKept = (text: string): Partial<RememberedBox & { code: string }> | null => {
  try {
    const raw = JSON.parse(text) as unknown
    return typeof raw === 'object' && raw !== null ? (raw as Partial<RememberedBox & { code: string }>) : null
  } catch {
    return null
  }
}

export function createUnlockVault(store: VaultStore): UnlockVault {
  const aesKey = async (): Promise<CryptoKey> => {
    const held = (await store.get(AES_KEY)) as CryptoKey | undefined
    if (held) return held
    const made = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    await store.set(AES_KEY, made)
    return made
  }

  const sealed = async (text: string): Promise<Sealed> => {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    return { iv, box: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(), new TextEncoder().encode(text)) }
  }
  const opened = async (row: string): Promise<string | null> => {
    const saved = (await store.get(row)) as Sealed | undefined
    const key = (await store.get(AES_KEY)) as CryptoKey | undefined
    if (!saved || !key) return null
    try {
      return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: saved.iv }, key, saved.box))
    } catch {
      return null
    }
  }
  /** The kept box, or null; one that does not open or read is dropped. */
  const keptBox = async (machine: string): Promise<(RememberedBox & { code: string }) | null> => {
    const text = await opened(boxOf(machine))
    const kept = text === null ? null : readKept(text)
    if (kept && typeof kept.box === 'string' && typeof kept.id === 'string' && typeof kept.code === 'string') return { box: kept.box, id: kept.id, code: kept.code }
    await store.del(boxOf(machine))
    return null
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
    async repin(machine, key) {
      await store.del(secretOf(machine))
      await store.del(boxOf(machine))
      await store.set(pinOf(machine), key)
    },
    async keepBox(machine, kept) {
      await store.set(boxOf(machine), await sealed(JSON.stringify({ box: kept.box, id: kept.id, code: kept.code })))
    },
    async boxFor(machine, code) {
      const kept = await keptBox(machine)
      if (kept === null) return null
      if (kept.code !== code) {
        await store.del(boxOf(machine))
        return null
      }
      return { box: kept.box, id: kept.id }
    },
    async dropBox(machine) {
      const kept = await keptBox(machine)
      await store.del(boxOf(machine))
      return kept?.id ?? null
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
