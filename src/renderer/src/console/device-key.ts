/**
 * THE CONSOLE IS A DEVICE OF THE ACCOUNT, WITH A KEY OF ITS OWN (0.6.0).
 *
 * console.cookrew.dev is its own origin, so the key cookrew.dev's page used to
 * mint is not here and never will be: the console mints one the first time it
 * is needed and keeps it in IndexedDB `cookrew-device`, store `keys`, entry
 * `device`, which is where account-device.ts reads it for every signature the
 * page makes (sign-in, renewal, each machine's door).
 *
 * P-256, NON-EXTRACTABLE. The pair is generated extractable only so its
 * private half can be imported once as a signing key that is not; the
 * exportable original is dropped before this returns and is persisted in no
 * form. A script on this page can ask the key to sign. It cannot take the key
 * away, which is what makes a stolen session token worth fifteen minutes and
 * not a device.
 *
 * THE ID IS DERIVED FROM THE KEY (RFC 7638 thumbprint, hashed again into a
 * version 8 UUID), exactly as the registry (auth-device-transaction.ts) and
 * the desktop (main/account-v2.ts) derive it: one key is one device wherever
 * it is seen, and a cleared store that still held the key would not have been
 * a second device.
 */
import { deviceFromStored, type AccountDevice } from '../account-device'

export type DeviceKind = 'browser' | 'phone'

export interface StoredDevice {
  readonly id: string
  readonly kind: DeviceKind
  readonly name: string
  readonly jwk: Record<string, string>
  readonly pair: { readonly privateKey: CryptoKey; readonly publicKey: CryptoKey }
}

export interface DevicePayload {
  readonly id: string
  readonly kind: DeviceKind
  readonly name: string
  readonly jwk: Record<string, string>
}

/** This browser as the registry and each machine's door know it: who it is, and its signature. */
export interface ConsoleDevice extends AccountDevice {
  readonly payload: DevicePayload
}

const encoder = new TextEncoder()

/** The exact bytes RFC 7638 hashes: the members that say WHICH key, in order, and none that only label it. */
function canonicalKey(jwk: Record<string, unknown>): string {
  if (jwk.kty === 'EC') return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
  if (jwk.kty === 'OKP') return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })
  throw new Error('not a device key')
}

export async function deviceIdFrom(jwk: Record<string, unknown>): Promise<string> {
  const thumbprint = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalKey(jwk)))
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', thumbprint)).slice(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-')
}

export async function mintDeviceKey(): Promise<Pick<StoredDevice, 'jwk' | 'pair'>> {
  const made = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const secret = await crypto.subtle.exportKey('jwk', made.privateKey)
  // Rebuilt member by member: an exported JWK carries `key_ops` and `ext`, and importing those back is refused.
  const seed = { kty: secret.kty, crv: secret.crv, x: secret.x, y: secret.y, d: secret.d }
  const privateKey = await crypto.subtle.importKey('jwk', seed, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  return {
    jwk: { kty: String(secret.kty), crv: String(secret.crv), x: String(secret.x), y: String(secret.y) },
    pair: { privateKey, publicKey: made.publicKey }
  }
}

const PHONE = /iPhone|Android/

/** A phone is a thing in a pocket; a tablet or a desktop browser is a window on a desk. */
export const deviceKindOf = (userAgent: string): DeviceKind => (PHONE.test(userAgent) ? 'phone' : 'browser')

/** What the account's device list calls this one: it says "Console", so it is told apart from a sign-in page's key. */
export function deviceNameOf(userAgent: string): string {
  if (/iPad/.test(userAgent)) return 'Console on iPad'
  if (/iPhone/.test(userAgent)) return 'Console on iPhone'
  if (/Android/.test(userAgent)) return 'Console on Android phone'
  const engine = /Firefox\//.test(userAgent) ? 'Firefox' : /Edg\//.test(userAgent) ? 'Edge' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : 'Browser'
  const os = /Mac OS X/.test(userAgent) ? 'macOS' : /Windows/.test(userAgent) ? 'Windows' : /Linux/.test(userAgent) ? 'Linux' : 'this computer'
  return `Console in ${engine} on ${os}`
}

export interface DeviceStore {
  readonly load: () => Promise<StoredDevice | null>
  readonly save: (device: StoredDevice) => Promise<void>
}

const DB = 'cookrew-device'
const STORE = 'keys'
const ENTRY = 'device'

/** IndexedDB, where a CryptoKey can be kept without its bytes ever being readable. */
export function browserDeviceStore(factory: IDBFactory = indexedDB): DeviceStore {
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const request = factory.open(DB, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  const run = async <T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open()
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode)
      const request = act(transaction.objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      transaction.oncomplete = () => db.close()
      transaction.onabort = () => db.close()
    })
  }
  return {
    load: async () => ((await run<StoredDevice | undefined>('readonly', (store) => store.get(ENTRY))) ?? null),
    save: async (device) => void (await run('readwrite', (store) => store.put(device, ENTRY)))
  }
}

/** This browser's device: the one it holds, or one minted now and kept. */
export async function consoleDevice(deps: DeviceStore & { readonly userAgent: string }): Promise<ConsoleDevice> {
  const held = await deps.load().catch(() => null)
  const usable = held === null ? null : deviceFromStored(held)
  if (held !== null && usable !== null) return { ...usable, payload: { id: held.id, kind: held.kind === 'phone' ? 'phone' : 'browser', name: usable.name, jwk: usable.jwk } }
  const key = await mintDeviceKey()
  const minted: StoredDevice = { id: await deviceIdFrom(key.jwk), kind: deviceKindOf(deps.userAgent), name: deviceNameOf(deps.userAgent), jwk: key.jwk, pair: key.pair }
  await deps.save(minted)
  const device = deviceFromStored(minted)
  if (device === null) throw new Error('this browser cannot keep a device key')
  return { ...device, payload: { id: minted.id, kind: minted.kind, name: minted.name, jwk: minted.jwk } }
}
