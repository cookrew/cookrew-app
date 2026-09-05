import { uuidFromDigest } from '../../shared/device-id'
/**
 * THE PHONE'S OWN KEY, and the one moment it is bound (D2).
 *
 * The companion used to have no identity of its own: it WAS the desktop, over
 * a pairing token. That is fine for the owner's own canvas and useless for
 * anything else — there is nothing it can present to a door or to cookrew.dev,
 * and it stops working the moment the desktop sleeps.
 *
 * So on first load it mints a key in IndexedDB (non-extractable, like the
 * site's), and at pairing it posts the PUBLIC half to the desktop, which
 * countersigns it into the owner's account. From then on the phone signs for
 * the account itself. The person sees nothing: pairing already proved the
 * phone is theirs, and asking again would be a ceremony that establishes
 * nothing new.
 *
 * WHAT IS PURE HERE AND WHY. The bind decision — already bound? refused? what
 * does the person read? — is a function of values, so it is tested without a
 * browser. The key material and IndexedDB are a thin layer beneath it.
 */

export type DeviceAlg = 'Ed25519' | 'P-256'

export interface PhoneDeviceKey {
  id: string
  alg: DeviceAlg
  /** The public half, as sent. The private half never leaves IndexedDB. */
  jwk: Record<string, unknown>
}

export interface PhoneBinding {
  handle: string
  deviceId: string
}

export interface PhoneDeviceRecord extends PhoneDeviceKey {
  keys: CryptoKeyPair
  bound: PhoneBinding | null
}

export type BindOutcome =
  | { state: 'bound'; handle: string; deviceId: string }
  | { state: 'already'; handle: string }
  | { state: 'refused'; reason: string }

/** RFC 7638's member set, lexicographic, no whitespace. Must match the desktop. */
export function canonicalJwk(jwk: Record<string, unknown>): string {
  const members =
    jwk.kty === 'OKP'
      ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x }
      : jwk.kty === 'EC'
        ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }
        : { e: jwk.e, kty: jwk.kty, n: jwk.n }
  return `{${Object.keys(members)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${JSON.stringify((members as Record<string, unknown>)[key])}`
    )
    .join(',')}}`
}

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let raw = ''
  for (const byte of view) raw += String.fromCharCode(byte)
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * A device id derived from the key itself.
 *
 * Not a random uuid: a phone that loses its stored id but keeps its key would
 * otherwise ask the registry to bind the SAME key under a second name, and the
 * owner's devices list would grow a duplicate nobody can tell apart. Derived,
 * the second bind is the same device.
 */
export function deviceIdFromDigest(digest: ArrayBuffer | Uint8Array): string {
  // UUID-shaped, because that is the only shape the registry admits — and
  // still a pure function of the key (src/shared/device-id.ts).
  return uuidFromDigest(digest)
}

/**
 * Announce at every pairing. `known` is what the phone already stored and is
 * sent along; the desktop confirms it (no write when nothing changed) or
 * replaces it when the account no longer lists this device.
 */
export async function bindPhoneDevice(input: {
  device: PhoneDeviceKey
  known: PhoneBinding | null
  /**
   * POST the claim. The caller owns the URL — remote-api.ts scopes every path
   * through apiPath(), and a literal route here would be a second, unscoped
   * copy of it (the api-base conformance sweep refuses exactly that).
   */
  post: (body: unknown) => Promise<{ status: number; body: unknown }>
  remember: (bound: PhoneBinding) => void | Promise<void>
  name?: string
}): Promise<BindOutcome> {
  // ANNOUNCED ON EVERY PAIRING, bound or not. A phone that stayed silent once
  // bound was signed in to nothing after the owner deleted and re-minted the
  // account: the handle came back, the devices did not, and the phone kept a
  // binding to a device that no longer existed. The desktop confirms a device
  // its account still lists without binding it again, so the cost of
  // announcing is one read; and it rebinds one that is missing.
  let answer: { status: number; body: unknown }
  try {
    answer = await input.post({
      id: input.device.id,
      jwk: input.device.jwk,
      kind: 'phone',
      name: input.name ?? 'a phone',
      ...(input.known === null ? {} : { known: input.known })
    })
  } catch {
    return input.known === null
      ? { state: 'refused', reason: 'the desktop did not answer — try again in a moment' }
      : { state: 'already', handle: input.known.handle }
  }
  const body = (answer.body ?? {}) as { handle?: unknown; deviceId?: unknown; error?: unknown }
  if (
    answer.status === 200 &&
    typeof body.handle === 'string' &&
    typeof body.deviceId === 'string'
  ) {
    const bound: PhoneBinding = { handle: body.handle, deviceId: body.deviceId }
    const unchanged =
      input.known !== null &&
      input.known.handle === bound.handle &&
      input.known.deviceId === bound.deviceId
    if (unchanged) return { state: 'already', handle: bound.handle }
    await input.remember(bound)
    return { state: 'bound', ...bound }
  }
  // THE DESKTOP'S OWN SENTENCE, verbatim. The 409 says "pick a username on the
  // desktop first", and rewriting that here into "binding failed" would take
  // away the only instruction the person can act on.
  return {
    state: 'refused',
    reason:
      typeof body.error === 'string' && body.error.length > 0
        ? body.error
        : `this phone could not be signed in (${answer.status})`
  }
}

/* ── the browser half: WebCrypto + IndexedDB ─────────────────────────────── */

const DB_NAME = 'cookrew-phone-device'
const STORE = 'device'
const RECORD = 'self'

/**
 * Ed25519 where the browser has it — the algorithm the desktop and the
 * registry both speak — and P-256 where it does not. A P-256 device can still
 * be bound and still sign the registry's ceremony; it simply cannot do the
 * door's own key form, which is the older path anyway.
 */
export async function mintDeviceKeys(): Promise<{ alg: DeviceAlg; keys: CryptoKeyPair }> {
  try {
    const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
      'sign',
      'verify'
    ])) as CryptoKeyPair
    return { alg: 'Ed25519', keys }
  } catch {
    const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify'
    ])) as CryptoKeyPair
    return { alg: 'P-256', keys }
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const request = run(tx.objectStore(STORE))
        request.onsuccess = () => resolve(request.result as T)
        request.onerror = () => reject(request.error)
        tx.oncomplete = () => db.close()
      })
  )
}

/** The phone's device record, minted on first load and reused after. */
export async function loadOrMintPhoneDevice(): Promise<PhoneDeviceRecord> {
  const held = await idb<PhoneDeviceRecord | undefined>('readonly', (store) => store.get(RECORD))
  if (held) return held
  const { alg, keys } = await mintDeviceKeys()
  const jwk = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as Record<string, unknown>
  // Only the members the thumbprint is over: a JWK carrying `key_ops` or `ext`
  // is the same key described differently, and the desktop's thumbprint would
  // not match what this device calls itself.
  const publicJwk =
    jwk.kty === 'OKP'
      ? { kty: jwk.kty, crv: jwk.crv, x: jwk.x }
      : { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJwk(publicJwk))
  )
  const record: PhoneDeviceRecord = {
    id: deviceIdFromDigest(digest),
    alg,
    jwk: publicJwk,
    keys,
    bound: null
  }
  await idb('readwrite', (store) => store.put(record, RECORD))
  return record
}

export async function rememberBinding(bound: PhoneBinding): Promise<void> {
  const held = await idb<PhoneDeviceRecord | undefined>('readonly', (store) => store.get(RECORD))
  if (!held) return
  await idb('readwrite', (store) => store.put({ ...held, bound }, RECORD))
}
