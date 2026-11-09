/**
 * THIS BROWSER AS A DEVICE OF THE ACCOUNT — read, never made, here.
 *
 * cookrew.dev's own page (registry/assets/site.js) mints the browser's device
 * key when it signs in and keeps it in IndexedDB `cookrew-device`, store
 * `keys`, entry `device`: `{ id, kind, name, jwk, pair: { privateKey } }`, the
 * private half NON-EXTRACTABLE. The companion is served under the same origin
 * (cookrew.dev/relay/@user/desktop/<id>/), so it can SIGN with that key without
 * ever holding its bytes — and the id it signs as is the id the relay stamps
 * and the id a revoke at cookrew.dev prunes.
 *
 * A browser that never signed in to cookrew.dev has no such entry, and that is
 * an answer ("sign in first"), not a reason to mint one: a key minted here
 * would be a device the account has never heard of.
 */

export interface AccountDevice {
  readonly id: string
  readonly name: string
  readonly jwk: Record<string, string>
  /** Signs exactly these bytes: Ed25519 whole, P-256 as ECDSA-SHA256 r‖s. */
  readonly sign: (bytes: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>
}

const DB = 'cookrew-device'
const STORE = 'keys'
const ENTRY = 'device'

interface Stored {
  id?: unknown
  name?: unknown
  jwk?: unknown
  pair?: { privateKey?: unknown }
}

const isKey = (value: unknown): value is CryptoKey =>
  typeof CryptoKey !== 'undefined' && value instanceof CryptoKey

/** Open WITHOUT creating: a missing database is a browser that never signed in. */
function readStored(factory: IDBFactory): Promise<Stored | null> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = factory.open(DB)
    } catch {
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      // The database did not exist: abort the creation so nothing is left behind.
      request.transaction?.abort()
      resolve(null)
    }
    request.onerror = () => resolve(null)
    request.onsuccess = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.close()
        resolve(null)
        return
      }
      const read = db.transaction(STORE, 'readonly').objectStore(STORE).get(ENTRY)
      read.onsuccess = () => {
        db.close()
        resolve((read.result as Stored | undefined) ?? null)
      }
      read.onerror = () => {
        db.close()
        resolve(null)
      }
    }
  })
}

export function deviceFromStored(stored: Stored | null): AccountDevice | null {
  if (stored === null || typeof stored.id !== 'string' || typeof stored.jwk !== 'object' || stored.jwk === null) return null
  const key = stored.pair?.privateKey
  if (!isKey(key)) return null
  const jwk = stored.jwk as Record<string, string>
  const algorithm = key.algorithm.name === 'Ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', hash: 'SHA-256' }
  return {
    id: stored.id,
    name: typeof stored.name === 'string' ? stored.name : 'This browser',
    jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, ...(jwk.y ? { y: jwk.y } : {}) },
    sign: (bytes) => crypto.subtle.sign(algorithm, key, bytes)
  }
}

/** This browser's account device, or null when it has none. */
export async function accountDevice(factory: IDBFactory | undefined = globalThis.indexedDB): Promise<AccountDevice | null> {
  if (factory === undefined) return null
  try {
    return deviceFromStored(await readStored(factory))
  } catch {
    return null
  }
}
