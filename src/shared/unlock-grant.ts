import { decodeBase64Url, fingerprintOfDigest } from './key-fingerprint'

/**
 * SETTING UP UNLOCK FROM A NEW DEVICE, WITH NOTHING FOR cookrew.dev TO READ OR SWAP.
 *
 * A device needs the Mac's connect code before it can send the Mac a password
 * (shared/remote-unlock.ts). The code must never be sealed to a key that only
 * cookrew.dev vouches for (main/connect-code.ts): whoever serves the relay could
 * hand in a key of its own. So the key is vouched for by a PERSON, comparing a
 * few words on two screens, as Bluetooth pairing does:
 *
 *   1. ask     the device commits to a fresh X25519 key and nonce (a hash of them).
 *   2.         the Mac answers with its own fresh key, a nonce, and its unlock key.
 *   3. reveal  the device opens its commitment. Both ends now hold the same record
 *              and say it as words.
 *   4. approve someone compares the words: at the Mac (with Touch ID), or on a
 *              device that can already unlock it, which reads them from the Mac
 *              inside its sealed session. Only then does the Mac seal the code to
 *              the device's key, under a key only the two fresh keys make.
 *
 * WHY THE COMMITMENT, AND WHY FOUR WORDS ARE ENOUGH. A relay in the middle runs
 * one exchange with each end and needs both to say the same words. The device
 * has committed before it sees the Mac's values, and the Mac's values are fixed
 * before the device reveals; neither side's words can be steered once the other
 * has spoken, so each try is one guess at 44 bits, and every try puts a prompt
 * in front of the owner.
 *
 * The device also pins the Mac's unlock key from the same record, so the six
 * words of the first unlock are already checked.
 */

export const UNLOCK_GRANT_PATH = '/api/unlock-grants'
export const UNLOCK_GRANT_EVENT = 'unlock-grants'
export const UNLOCK_GRANT_LABEL = 'cookrew-unlock-grant/1'
export const UNLOCK_GRANT_WORDS = 4

export type GrantState = 'waiting' | 'allowed' | 'denied' | 'expired'

export type GrantRefusal = { readonly ok: false; readonly error: string }
export type GrantAsked = { readonly ok: true; readonly id: string; readonly macKey: string; readonly macNonce: string; readonly unlockKey: string; readonly until: number }
export type GrantStatus = { readonly ok: true; readonly state: GrantState; readonly sealed?: string; readonly by?: string }
export type GrantDone = { readonly ok: true }

/** What a device that can already unlock the Mac is shown, read from the Mac inside its sealed session. */
export interface GrantPending {
  readonly id: string
  readonly name: string
  readonly words: readonly string[]
  readonly askedAt: number
  readonly until: number
}

export type GrantList = { readonly ok: true; readonly pending: readonly GrantPending[] }

/** The record both ends hash: every value either of them chose. */
export interface GrantRecord {
  readonly id: string
  readonly macKey: string
  readonly macNonce: string
  readonly unlockKey: string
  readonly phoneKey: string
  readonly phoneNonce: string
}

const encoder = new TextEncoder()
const ZERO_IV = new Uint8Array(12)
/** An X25519 public key as SPKI DER: twelve bytes of header and the 32-byte key. */
const X25519_SPKI_BYTES = 44

export const b64u = (bytes: ArrayBuffer | Uint8Array): string => {
  let text = ''
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const bytesOf = (text: string): Uint8Array<ArrayBuffer> | null => {
  const bytes = decodeBase64Url(text)
  return bytes === null ? null : new Uint8Array(bytes)
}

const sha256 = async (text: string): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))

/** A public key in the shape both ends make, before anything is asked of it. */
export const isGrantKey = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 80) return false
  return bytesOf(value)?.length === X25519_SPKI_BYTES
}

export const isGrantNonce = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)

export const grantNonce = (): string => b64u(crypto.getRandomValues(new Uint8Array(32)))

export const commitmentOf = async (phoneKey: string, phoneNonce: string): Promise<string> => b64u(await sha256(`${UNLOCK_GRANT_LABEL} commit ${phoneKey} ${phoneNonce}`))

export const grantDigest = (record: GrantRecord): Promise<Uint8Array<ArrayBuffer>> =>
  sha256(`${UNLOCK_GRANT_LABEL} record ${record.id} ${record.macKey} ${record.macNonce} ${record.unlockKey} ${record.phoneKey} ${record.phoneNonce}`)

export const wordsOfGrant = (digest: Uint8Array): readonly string[] => fingerprintOfDigest(digest).words.slice(0, UNLOCK_GRANT_WORDS)

/** A fresh key for one exchange. The private half cannot be read out of the page or the process. */
export async function mintGrantKey(): Promise<{ readonly publicKey: string; readonly privateKey: CryptoKey }> {
  const made = (await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair
  return { publicKey: b64u(await crypto.subtle.exportKey('spki', made.publicKey)), privateKey: made.privateKey }
}

/** The one AES key this pair of fresh keys makes for this record. */
async function codeKey(mine: CryptoKey, theirs: string, digest: Uint8Array<ArrayBuffer>, use: KeyUsage): Promise<CryptoKey> {
  const raw = bytesOf(theirs)
  if (raw === null) throw new Error('not a key')
  const other = await crypto.subtle.importKey('spki', raw, { name: 'X25519' }, false, [])
  const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: other }, mine, 256)
  const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: digest, info: encoder.encode(`${UNLOCK_GRANT_LABEL} code`) }, ikm, 256)
  return crypto.subtle.importKey('raw', bits, 'AES-GCM', false, [use])
}

/** The Mac's side. A zero nonce is sound: the key is new for this record and seals one message. */
export async function sealGrantCode(macPrivate: CryptoKey, phoneKey: string, digest: Uint8Array<ArrayBuffer>, code: string): Promise<string> {
  const key = await codeKey(macPrivate, phoneKey, digest, 'encrypt')
  return b64u(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ZERO_IV, tagLength: 128 }, key, encoder.encode(code)))
}

/** The device's side. Null for anything the Mac of this record did not seal. */
export async function openGrantCode(phonePrivate: CryptoKey, macKey: string, digest: Uint8Array<ArrayBuffer>, sealed: string): Promise<string | null> {
  try {
    const box = bytesOf(sealed)
    if (box === null) return null
    const key = await codeKey(phonePrivate, macKey, digest, 'decrypt')
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ZERO_IV, tagLength: 128 }, key, box))
  } catch {
    return null
  }
}
