/**
 * THE DIRECT LINK'S BINDING: what keeps the relay out of a WebRTC link it
 * carried the offer and the answer for.
 *
 * DTLS on a data channel is authenticated by the fingerprints in the SDPs, and
 * both SDPs cross the relay in plaintext. A relay that swapped them would sit
 * in the middle of the "direct" link. So the Mac signs the two fingerprint
 * sets it saw — the offer's AS IT RECEIVED IT, and its own answer's — with its
 * account device key, and the console sets the answer only when that
 * signature verifies over ITS OWN offer and the answer it is about to set.
 *
 * WebCrypto only on the checking side, so the page and the Mac run this file.
 *
 * THE SIGNED MESSAGE (UTF-8, `\n` between lines, no trailing newline):
 *
 *   cookrew-rtc-bind/1
 *   <machine device id, lower case>
 *   <offer fingerprints>
 *   <answer fingerprints>
 *
 * A side's fingerprints are every `a=fingerprint:` line of its SDP, session or
 * media level, each `<hash lower case> <HEX UPPER CASE>`, distinct, sorted,
 * joined by `,`. FAIL CLOSED: an SDP with none, with a hash other than
 * sha-256/384/512 at its own length, or with ANY line that mentions a
 * fingerprint and is not a well-formed one, has no binding. A lenient parser
 * elsewhere must never find a fingerprint this one did not sign.
 *
 * THE ONE PROOF is the machine's account device key: Ed25519 over the message
 * whole (account-v2.ts · signWithDevice). The key is held to the machine in
 * scope by its id, which IS a hash of the key (deviceIdOfKey, as deviceIdFor
 * mints it), so nothing the relay sends can name a key for the machine. The
 * machine in scope comes from the registry's device list for the signed-in
 * account — the trust of signing in. With no machine in scope, nothing passes.
 *
 * NEVER A CONNECT CODE (acceptance review, 2026-11-16). A console learns a code
 * from a link's fragment (`<console>/d/<machine>#code=`), and anyone can make
 * such a link. For unlock a wrong code only fails against the real Mac; here
 * whoever planted it, the relay included, could prove a binding of its own. So
 * no code proof is made, sent or read: the check below takes no code at all.
 *
 * The relay can drop a binding (no link, the page stays on the relay) or
 * replay one; a replay fails, a browser's offer carries a fresh certificate
 * per peer connection. Domain separation: every other device-key signature
 * begins `<another label> ` or `{`, never `cookrew-rtc-bind/1\n`.
 */

export const RTC_BIND_LABEL = 'cookrew-rtc-bind/1'

/** What the Mac sends beside its answer SDP. */
export interface RtcBind {
  readonly v: 1
  /** The machine's account device id, lower case. */
  readonly device: string
  /** The device's PUBLIC Ed25519 key, which its id is a hash of. */
  readonly jwk: Ed25519PublicJwk
  /** Ed25519 over the message, base64url. */
  readonly sig: string
}

export interface Ed25519PublicJwk {
  readonly kty: 'OKP'
  readonly crv: 'Ed25519'
  readonly x: string
}

export type RtcBindVerdict = { readonly ok: true; readonly by: 'device' } | { readonly ok: false; readonly why: string }

type Bytes = Uint8Array<ArrayBuffer>

const encoder = new TextEncoder()
const ED25519_KEY_BYTES = 32
const ED25519_SIG_BYTES = 64

/** Strict base64url, no padding; null for anything else. */
const fromBase64Url = (text: unknown, maxLength = 256): Bytes | null => {
  if (typeof text !== 'string' || text.length === 0 || text.length > maxLength || !/^[A-Za-z0-9_-]+$/.test(text)) return null
  try {
    return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))
  } catch {
    return null
  }
}

/** Digest bytes per hash a fingerprint may use; any other hash is no fingerprint. */
const DIGEST_BYTES: Readonly<Record<string, number>> = { 'sha-256': 32, 'sha-384': 48, 'sha-512': 64 }

const FINGERPRINT_LINE = /^a=fingerprint:([A-Za-z0-9-]{1,16}) ((?:[0-9A-Fa-f]{2}:)*[0-9A-Fa-f]{2})[ \t]*$/

/** One `a=fingerprint:` line in canonical form, or null when it is not a well-formed one. */
const readFingerprintLine = (line: string): string | null => {
  const match = FINGERPRINT_LINE.exec(line)
  if (!match) return null
  const hash = match[1].toLowerCase()
  const digest = match[2].toUpperCase()
  const bytes = DIGEST_BYTES[hash]
  if (bytes === undefined || digest.split(':').length !== bytes) return null
  return `${hash} ${digest}`
}

/** The SDP's fingerprints in canonical form, or null when it has none or any it cannot read. */
export const sdpFingerprints = (sdp: string): string | null => {
  const found = new Set<string>()
  for (const line of sdp.split(/\r?\n/)) {
    if (!/fingerprint/i.test(line)) continue
    const fingerprint = readFingerprintLine(line)
    if (fingerprint === null) return null
    found.add(fingerprint)
  }
  return found.size === 0 ? null : [...found].sort().join(',')
}

/** The signed message, or null when either SDP has no readable fingerprint. */
export const bindMessage = (device: string, offerSdp: string, answerSdp: string): string | null => {
  const offer = sdpFingerprints(offerSdp)
  const answer = sdpFingerprints(answerSdp)
  if (offer === null || answer === null) return null
  return [RTC_BIND_LABEL, device.toLowerCase(), offer, answer].join('\n')
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The Ed25519 public members alone (never a private half sent by mistake), or null for any other key. */
const ed25519PublicKey = (jwk: unknown): Ed25519PublicJwk | null => {
  if (!isRecord(jwk) || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') return null
  const raw = fromBase64Url(jwk.x)
  if (raw === null || raw.length !== ED25519_KEY_BYTES) return null
  return { kty: 'OKP', crv: 'Ed25519', x: jwk.x as string }
}

/**
 * The account device id an Ed25519 public key hashes to: SHA-256 of the
 * SHA-256 of its RFC 7638 members, the first 16 bytes as a version 8 UUID —
 * exactly as the Mac mints it (account-v2.ts · deviceIdFor). Null for any other key.
 */
export const deviceIdOfKey = async (jwk: unknown): Promise<string | null> => {
  const key = ed25519PublicKey(jwk)
  if (key === null) return null
  const canonical = JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x })
  const thumbprint = await crypto.subtle.digest('SHA-256', encoder.encode(canonical))
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', thumbprint)).slice(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-')
}

/** True only for this Ed25519 key's signature over this message. Anything else, of any shape, is false. */
export const checkBindSignature = async (jwk: unknown, message: string, sig: unknown): Promise<boolean> => {
  const key = ed25519PublicKey(jwk)
  const raw = fromBase64Url(sig)
  if (key === null || raw === null || raw.length !== ED25519_SIG_BYTES) return false
  try {
    const imported = await crypto.subtle.importKey('jwk', { ...key }, { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'Ed25519' }, imported, raw, encoder.encode(message))
  } catch {
    return false
  }
}

export interface RtcBindSigner {
  readonly jwk: Record<string, unknown>
  readonly sign: (message: string) => string
}

export interface MakeRtcBindInput {
  readonly device: string
  /** The offer exactly as it arrived: what the Mac's DTLS will check the peer against. */
  readonly offerSdp: string
  readonly answerSdp: string
  readonly signer: RtcBindSigner | null
}

/** The Mac's side. Null when there is no key to sign by, or nothing to bind. */
export const makeRtcBind = (input: MakeRtcBindInput): RtcBind | null => {
  if (input.signer === null) return null
  const jwk = ed25519PublicKey(input.signer.jwk)
  const message = bindMessage(input.device, input.offerSdp, input.answerSdp)
  if (jwk === null || message === null) return null
  try {
    return { v: 1, device: input.device.toLowerCase(), jwk, sig: input.signer.sign(message) }
  } catch {
    return null
  }
}

export interface CheckRtcBindInput {
  /** What the Mac sent beside its answer, unread: undefined from an older Mac. */
  readonly bind: unknown
  /** THIS BROWSER'S OWN offer, never one the Mac says it saw. */
  readonly offerSdp: string
  /** The answer exactly as it will be set. */
  readonly answerSdp: string
  /** The machine the console is in, by the registry's id; null where none is. */
  readonly machineId: string | null
}

/** Why an answer from a Mac that sends no binding (one older than the binding, or the relay) is refused. */
export const RTC_NO_BINDING = 'no binding'
/** Why an answer is refused by a browser whose WebCrypto has no Ed25519 (Safari before 17, older Chrome). */
export const RTC_NO_ED25519 = 'browser has no Ed25519'

/** RFC 8032 section 7.1, test 1: a public key every Ed25519 implementation must import. */
const KNOWN_ED25519_KEY: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' }

/**
 * Can this WebCrypto check an Ed25519 signature at all? Asked of a key it
 * must accept, so a no here is the browser's and never the Mac's. A page that
 * cannot check sends no offer: the relay then never sees its addresses.
 */
export const ed25519Available = async (): Promise<boolean> => {
  try {
    await crypto.subtle.importKey('jwk', { ...KNOWN_ED25519_KEY }, { name: 'Ed25519' }, false, ['verify'])
    return true
  } catch {
    return false
  }
}

/** The console's side: may this answer be set? */
export const checkRtcBind = async (input: CheckRtcBindInput): Promise<RtcBindVerdict> => {
  const expected = input.machineId?.toLowerCase() ?? null
  // No machine in scope, no key to hold the Mac to: nothing here tells the Mac from the relay.
  if (expected === null) return { ok: false, why: 'no machine in scope' }
  const bind = input.bind
  if (!isRecord(bind)) return { ok: false, why: RTC_NO_BINDING }
  // Said apart from a forgery: a browser that cannot check is not under attack, and the badge says which.
  if (!(await ed25519Available())) return { ok: false, why: RTC_NO_ED25519 }
  if (bind.v !== 1 || typeof bind.device !== 'string') return { ok: false, why: 'unreadable binding' }
  if (bind.device.toLowerCase() !== expected) return { ok: false, why: 'binding for another machine' }
  const message = bindMessage(expected, input.offerSdp, input.answerSdp)
  if (message === null) return { ok: false, why: 'no fingerprint' }
  if ((await deviceIdOfKey(bind.jwk)) !== expected) return { ok: false, why: 'key is not the machine in scope' }
  if (!(await checkBindSignature(bind.jwk, message, bind.sig))) return { ok: false, why: 'binding did not verify' }
  return { ok: true, by: 'device' }
}
