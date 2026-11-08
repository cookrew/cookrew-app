import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type KeyObject } from 'node:crypto'

/**
 * AUTH — THE DEVICE-BOUND TRANSACTION, and nothing else.
 *
 * One browser, one device key, one short window. A transaction is opened with
 * the device's PUBLIC key and two hashes the caller already holds for this
 * browser (its random browser secret and its CSRF token). The device then
 * signs a transcript naming this protocol's fixed purpose, the store's
 * audience origin, this transaction, this challenge, its expiry, its key and
 * the id derived from that key; the browser that opened it then redeems a
 * callback state the server minted, once, and gets back the verified device
 * payload. The audience is fixed when the store is constructed and the expiry
 * is the store's own; no request can choose either.
 *
 * WHAT IT DOES NOT DO. It never attaches a device to an account and never
 * issues a session, a token or a cookie. A redeemed result is a fact — "this
 * browser saw this key prove possession of itself" — and what that is allowed
 * to grant is the caller's policy, written where it can be reviewed.
 *
 * THE PAYLOAD IS FIXED AT CREATION. The key is reduced to its RFC 7638 members,
 * validated as a real point, copied and frozen before anything else happens; a
 * caller mutating the object it passed in changes nothing, and the transcript
 * is computed once from the copy.
 *
 * ATOMIC BY BEING SYNCHRONOUS. Every check and the transition it guards run in
 * one turn of the event loop — node:crypto's verify is synchronous — so two
 * requests cannot both see `created` and both move it on. The one call out of
 * this file (the revocation predicate) is followed by a re-check that the
 * transaction is still the same object in the same phase.
 *
 * BOUNDED. Every external string is length-checked before it is matched,
 * hashed or decoded; the store holds at most `max` transactions, at most
 * `maxPerBrowser` per browser-secret hash and at most `maxPerDevice` per
 * device id, and REFUSES rather than evicting when any limit is reached, so a
 * flood cannot silently cancel a flow in progress. The limits stop one
 * browser or one key from taking the whole store; they do not stop many
 * fresh browsers or keys, which is the caller's per-client rate limit.
 * A restart forgets everything, which is the safe direction.
 *
 * P-256 SIGNATURES are exactly one of two encodings, never guessed between:
 * exactly 64 bytes is WebCrypto's raw r‖s (IEEE P1363); any other length must
 * be canonical DER (short-form lengths, minimal positive integers, nothing
 * trailing), which is re-encoded to r‖s. Either way one verification runs.
 * A canonical DER signature of exactly 64 bytes is possible but vanishingly
 * rare and is read as raw, so it fails. Ed25519 signatures are the 64 raw bytes.
 */

export const DEVICE_TRANSACTION_CONTEXT = 'cookrew-auth/device-transaction/v1'
/** The only purpose a transaction transcript can carry. */
export const DEVICE_TRANSACTION_PURPOSE = 'authenticate-device'
const BROWSER_SECRET_DOMAIN = 'cookrew-auth/browser-secret/v1'
const CSRF_DOMAIN = 'cookrew-auth/csrf-token/v1'
const CALLBACK_STATE_DOMAIN = 'cookrew-auth/callback-state/v1'

const TOKEN_BYTES = 32
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const SECRET_MIN = 43
const SECRET_MAX = 128
const SECRET = /^[A-Za-z0-9_-]+$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const SIGNATURE_MAX = 96
const ED25519_SIGNATURE_BYTES = 64
const DER_SIGNATURE_MIN = 8
const DER_SIGNATURE_MAX = 72
const P256_SIGNATURE_BYTES = 64
const P256_SCALAR_BYTES = 32
const PAYLOAD_MEMBERS_MAX = 8
const JWK_MEMBERS_MAX = 16
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'] as const
const NAME_MAX = 64
const NAME_RAW_MAX = 256
/** Format (bidi controls, zero-widths, tags, BOM), private-use and unassigned: removed. */
const NAME_DROPPED = /[\p{Cf}\p{Co}\p{Cn}]/gu
/** Controls and every separator: one plain space. */
const NAME_SPACE = /[\p{Cc}\p{Z}]+/gu
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

const DEFAULT_TTL_MS = 5 * 60_000
const TTL_CEILING_MS = 15 * 60_000
const DEFAULT_MAX = 1000
const MAX_CEILING = 100_000
const DEFAULT_PER_BINDING = 3
const PER_BINDING_CEILING = 100
const AUDIENCE_MAX = 256
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
/** Wrong browser secret or CSRF token this many times, across both steps, and the transaction is gone. */
const FAILURE_LIMIT = 5

export type DeviceJwk =
  | { readonly kty: 'OKP'; readonly crv: 'Ed25519'; readonly x: string }
  | { readonly kty: 'EC'; readonly crv: 'P-256'; readonly x: string; readonly y: string }

/** The device as it stood when the transaction was opened. Frozen. */
export interface DevicePayload {
  readonly publicKeyJwk: DeviceJwk
  /** Derived from the key (RFC 7638 thumbprint, hashed again, UUID v8) — never taken from the wire. */
  readonly deviceId: string
  readonly name: string | null
}

/** What one successful redemption hands back, exactly once. Frozen. */
export interface DeviceTransactionResult {
  readonly transactionId: string
  readonly device: DevicePayload
  readonly provenAt: number
}

export type CreateOutcome =
  | {
      readonly ok: true
      readonly transactionId: string
      /** 256 bits, base64url. Public: it is what the device signs, not a secret. */
      readonly challenge: string
      /** 256 bits, base64url, returned ONLY here; the store keeps its hash. */
      readonly callbackState: string
      /** The exact UTF-8 string the device must sign. */
      readonly transcript: string
      readonly deviceId: string
      readonly expiresAt: number
    }
  /** A revoked device, or a revocation check that did not answer `false`, is `invalid` like any malformed input. */
  | { readonly ok: false; readonly reason: 'invalid' | 'capacity' }

export type ProveOutcome =
  | { readonly ok: true; readonly deviceId: string }
  | { readonly ok: false; readonly reason: 'unknown' | 'expired' | 'wrong_phase' | 'mismatch' | 'revoked' | 'bad_proof' }

export type RedeemOutcome =
  | { readonly ok: true; readonly result: DeviceTransactionResult }
  | { readonly ok: false; readonly reason: 'unknown' | 'expired' | 'wrong_phase' | 'mismatch' | 'revoked' }

export interface DeviceTransactionsOptions {
  /** Only `false` means live; `true`, anything else, or a throw is treated as revoked. */
  isDeviceRevoked: (deviceId: string) => boolean
  /** The origin every transcript names: `https://host[:port]`, or `http://` on localhost, 127.0.0.1 or [::1]. Exact serialization, no path. */
  audience: string
  /** Must return integer milliseconds; the expiry is signed. */
  now?: () => number
  ttlMs?: number
  max?: number
  /** Simultaneous open transactions per browser-secret hash. Default 3. */
  maxPerBrowser?: number
  /** Simultaneous open transactions per device id. Default 3. */
  maxPerDevice?: number
}

/** The exact origin, or null: HTTPS anywhere, plain HTTP only on loopback. */
function readAudience(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > AUDIENCE_MAX) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.origin !== value) return null
  if (url.protocol === 'https:') return value
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) ? value : null
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** base64url that round-trips exactly — no padding, no stray trailing bits. */
function canonicalBase64url(value: unknown, maxLength: number): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || !BASE64URL.test(value)) return null
  const bytes = Buffer.from(value, 'base64url')
  return bytes.toString('base64url') === value ? bytes : null
}

const token = (): string => randomBytes(TOKEN_BYTES).toString('base64url')

const isToken = (value: unknown): value is string => typeof value === 'string' && value.length === 43 && TOKEN.test(value)

const domainHash = (domain: string, value: string): string =>
  createHash('sha256').update(domain, 'utf8').update(Buffer.from([0])).update(value, 'utf8').digest('base64url')

function hashSecret(domain: string, value: unknown): string | null {
  if (typeof value !== 'string' || value.length < SECRET_MIN || value.length > SECRET_MAX || !SECRET.test(value)) return null
  return domainHash(domain, value)
}

/** The hash a transaction is bound to for the browser's random secret (≥ 43 base64url chars). */
export const hashBrowserSecret = (secret: unknown): string | null => hashSecret(BROWSER_SECRET_DOMAIN, secret)

/** The hash a transaction is bound to for the browser's CSRF token (≥ 43 base64url chars). */
export const hashCsrfToken = (csrfToken: unknown): string | null => hashSecret(CSRF_DOMAIN, csrfToken)

function digestOf(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length !== 43) return null
  const bytes = canonicalBase64url(value, 43)
  return bytes !== null && bytes.byteLength === 32 ? bytes : null
}

/** Timing-safe; a malformed candidate is still compared, against the stored value itself, then refused. */
function sameDigest(candidate: string | null, stored: Buffer): boolean {
  const bytes = candidate === null ? null : Buffer.from(candidate, 'base64url')
  const comparable = bytes !== null && bytes.byteLength === stored.byteLength
  const equal = timingSafeEqual(comparable ? bytes : stored, stored)
  return comparable && equal
}

// ── keys ────────────────────────────────────────────────────────────────────

const mod = (value: bigint, modulus: bigint): bigint => ((value % modulus) + modulus) % modulus

function power(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let b = mod(base, modulus)
  let e = exponent
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus
    b = (b * b) % modulus
    e >>= 1n
  }
  return result
}

const bigEndian = (bytes: Buffer): bigint => BigInt(`0x${bytes.toString('hex')}`)
const littleEndian = (bytes: Buffer): bigint => bigEndian(Buffer.from(bytes).reverse())

const ED_P = (1n << 255n) - 19n
const ED_D = mod(-121665n * power(121666n, ED_P - 2n, ED_P), ED_P)
/** The y of an order-8 point; with 0, 1 and p-1 these are every small-order y (libsodium's blocklist). */
const ED_ORDER_8_Y = littleEndian(Buffer.from('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', 'hex'))
const ED_SMALL_ORDER_Y = new Set([0n, 1n, ED_P - 1n, ED_ORDER_8_Y, ED_P - ED_ORDER_8_Y])

/**
 * A canonical encoding of a point on the curve outside the small-order
 * subgroup. A small-order key verifies forgeries anyone can make, so it is not
 * a key a device can be said to possess.
 */
function ed25519PointAcceptable(encoded: Buffer): boolean {
  if (encoded.byteLength !== 32) return false
  const sign = encoded[31] >> 7
  const yBytes = Buffer.from(encoded)
  yBytes[31] &= 0x7f
  const y = littleEndian(yBytes)
  if (y >= ED_P || ED_SMALL_ORDER_Y.has(y)) return false
  const y2 = (y * y) % ED_P
  const u = mod(y2 - 1n, ED_P)
  const v = mod(ED_D * y2 + 1n, ED_P)
  const x2 = (u * power(v, ED_P - 2n, ED_P)) % ED_P
  if (x2 === 0n) return sign === 0
  return power(x2, (ED_P - 1n) / 2n, ED_P) === 1n
}

const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn

/** On y² = x³ − 3x + b with both coordinates reduced. Cofactor 1, so on-curve is enough. */
function p256PointAcceptable(xBytes: Buffer, yBytes: Buffer): boolean {
  if (xBytes.byteLength !== 32 || yBytes.byteLength !== 32) return false
  const x = bigEndian(xBytes)
  const y = bigEndian(yBytes)
  if (x >= P256_P || y >= P256_P) return false
  return mod(y * y - (x * x * x - 3n * x + P256_B), P256_P) === 0n
}

const coordinate = (value: unknown): Buffer | null => {
  if (typeof value !== 'string' || value.length !== 43) return null
  const bytes = canonicalBase64url(value, 43)
  return bytes !== null && bytes.byteLength === 32 ? bytes : null
}

function importKey(jwk: DeviceJwk): KeyObject | null {
  try {
    return createPublicKey({ key: { ...jwk }, format: 'jwk' })
  } catch {
    return null
  }
}

/** The public members and nothing else; a key carrying any private member is refused, not trimmed. */
function readPublicJwk(input: unknown): DeviceJwk | null {
  if (!isRecord(input) || Object.keys(input).length > JWK_MEMBERS_MAX) return null
  for (const member of PRIVATE_JWK_MEMBERS) if (Object.hasOwn(input, member)) return null
  const kty = input.kty
  const crv = input.crv
  const xText = input.x
  if (kty === 'OKP' && crv === 'Ed25519') {
    const x = coordinate(xText)
    if (x === null || !ed25519PointAcceptable(x)) return null
    const jwk: DeviceJwk = { kty: 'OKP', crv: 'Ed25519', x: xText as string }
    return Object.freeze(jwk)
  }
  if (kty === 'EC' && crv === 'P-256') {
    const yText = input.y
    const x = coordinate(xText)
    const y = coordinate(yText)
    if (x === null || y === null || !p256PointAcceptable(x, y)) return null
    const jwk: DeviceJwk = { kty: 'EC', crv: 'P-256', x: xText as string, y: yText as string }
    return Object.freeze(jwk)
  }
  return null
}

/** RFC 7638: the required members, lexicographic, no whitespace. */
export function canonicalDeviceKey(jwk: DeviceJwk): string {
  return jwk.kty === 'OKP'
    ? JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })
    : JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
}

/** The same derivation as device-id.js and v2-migrate-routes.ts · legacyDeviceId. */
export function deviceIdOf(jwk: DeviceJwk): string {
  const thumbprint = createHash('sha256').update(canonicalDeviceKey(jwk), 'utf8').digest()
  const bytes = Buffer.from(createHash('sha256').update(thumbprint).digest().subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-')
}

const NO_NAME = Symbol('no name')

/**
 * The name as it will be signed and shown: format, private-use and unassigned
 * characters removed, controls and separators collapsed to one space, trimmed,
 * NFC. Idempotent. Malformed UTF-16, or nothing left, refuses the payload.
 */
function readName(value: unknown): string | null | typeof NO_NAME {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > NAME_RAW_MAX || LONE_SURROGATE.test(value)) return NO_NAME
  const name = value.replace(NAME_DROPPED, '').replace(NAME_SPACE, ' ').trim().normalize('NFC')
  return name.length === 0 || name.length > NAME_MAX ? NO_NAME : name
}

/**
 * A device payload, or null. `deviceId` may be sent but is never believed:
 * it is accepted only when it is exactly the id this key derives to.
 */
export function readDevicePayload(input: unknown): DevicePayload | null {
  if (!isRecord(input) || Object.keys(input).length > PAYLOAD_MEMBERS_MAX) return null
  const claimedId = input.deviceId
  const rawName = input.name
  const jwk = readPublicJwk(input.publicKeyJwk)
  if (jwk === null || importKey(jwk) === null) return null
  const deviceId = deviceIdOf(jwk)
  if (claimedId !== undefined && claimedId !== deviceId) return null
  const name = readName(rawName)
  if (name === NO_NAME) return null
  const payload: DevicePayload = { publicKeyJwk: jwk, deviceId, name }
  return Object.freeze(payload)
}

/**
 * THE SIGNED BYTES. Line-separated, one labelled field per line, and every
 * field is either a constant, a serialized origin, a 43-character base64url
 * token, a decimal safe integer, a UUID, RFC 7638 JSON of base64url members,
 * or a JSON string with no raw line breaks — so no field can contain the
 * separator and the parse is unambiguous. The first line is this protocol's
 * alone, so a hello or a reach-card signature is never one. The purpose is a
 * constant, not an input.
 */
export function deviceTransactionTranscript(input: {
  audience: string
  transactionId: string
  challenge: string
  expiresAt: number
  device: DevicePayload
}): string {
  const audience = readAudience(input.audience)
  if (audience === null || !isToken(input.transactionId) || !isToken(input.challenge)) throw new Error('Invalid transaction transcript')
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0) throw new Error('Invalid transaction transcript')
  const jwk = readPublicJwk(input.device.publicKeyJwk)
  const name = readName(input.device.name)
  if (jwk === null || name === NO_NAME || name !== input.device.name) throw new Error('Invalid transaction transcript')
  return [
    DEVICE_TRANSACTION_CONTEXT,
    `purpose:${DEVICE_TRANSACTION_PURPOSE}`,
    `audience:${audience}`,
    `transaction:${input.transactionId}`,
    `challenge:${input.challenge}`,
    `expires:${input.expiresAt}`,
    `device:${deviceIdOf(jwk)}`,
    `key:${canonicalDeviceKey(jwk)}`,
    `name:${JSON.stringify(name)}`
  ].join('\n')
}

// ── the store ───────────────────────────────────────────────────────────────

interface Held {
  readonly id: string
  readonly device: DevicePayload
  readonly key: KeyObject
  readonly transcript: Buffer
  readonly browserSecretHash: Buffer
  readonly csrfHash: Buffer
  readonly browserKey: string
  readonly stateHash: Buffer
  readonly stateKey: string
  readonly expiresAt: number
  phase: 'created' | 'proven'
  failures: number
  provenAt: number
}

function signatureValid(held: Held, signature: unknown): boolean {
  const bytes = canonicalBase64url(signature, SIGNATURE_MAX)
  if (bytes === null) return false
  try {
    if (held.device.publicKeyJwk.kty === 'OKP') {
      return bytes.byteLength === ED25519_SIGNATURE_BYTES && verify(null, held.transcript, held.key, bytes)
    }
    const raw = bytes.byteLength === P256_SIGNATURE_BYTES ? bytes : p1363FromDer(bytes)
    return raw !== null && verify('sha256', held.transcript, { key: held.key, dsaEncoding: 'ieee-p1363' }, raw)
  } catch {
    return false
  }
}

/** One DER INTEGER at `at`: minimal, non-negative, at most 32 value bytes. Returned left-padded to 32. */
function derInteger(bytes: Buffer, at: number): { value: Buffer; next: number } | null {
  if (at + 2 > bytes.byteLength || bytes[at] !== 0x02) return null
  const length = bytes[at + 1]
  const start = at + 2
  const next = start + length
  if (length === 0 || length > P256_SCALAR_BYTES + 1 || next > bytes.byteLength) return null
  if (bytes[start] & 0x80) return null
  if (length > 1 && bytes[start] === 0 && !(bytes[start + 1] & 0x80)) return null
  const content = length > 1 && bytes[start] === 0 ? bytes.subarray(start + 1, next) : bytes.subarray(start, next)
  if (content.byteLength > P256_SCALAR_BYTES) return null
  const value = Buffer.alloc(P256_SCALAR_BYTES)
  content.copy(value, P256_SCALAR_BYTES - content.byteLength)
  return { value, next }
}

/** Canonical DER ECDSA-Sig-Value to r‖s: one short-form SEQUENCE of exactly two INTEGERs and nothing else. */
function p1363FromDer(bytes: Buffer): Buffer | null {
  if (bytes.byteLength < DER_SIGNATURE_MIN || bytes.byteLength > DER_SIGNATURE_MAX) return null
  if (bytes[0] !== 0x30 || bytes[1] !== bytes.byteLength - 2) return null
  const r = derInteger(bytes, 2)
  const s = r === null ? null : derInteger(bytes, r.next)
  if (r === null || s === null || s.next !== bytes.byteLength) return null
  return Buffer.concat([r.value, s.value])
}

function adjust(counts: Map<string, number>, key: string, delta: 1 | -1): void {
  const next = (counts.get(key) ?? 0) + delta
  if (next > 0) counts.set(key, next)
  else counts.delete(key)
}

/** Short-lived, bounded, single-use. A restart invalidates every open transaction. */
export class DeviceTransactions {
  private readonly isDeviceRevoked: (deviceId: string) => boolean
  private readonly origin: string
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly max: number
  private readonly maxPerBrowser: number
  private readonly maxPerDevice: number
  private readonly held = new Map<string, Held>()
  private readonly byState = new Map<string, string>()
  private readonly perBrowser = new Map<string, number>()
  private readonly perDevice = new Map<string, number>()

  constructor(options: DeviceTransactionsOptions) {
    if (typeof options !== 'object' || options === null) throw new Error('Invalid device transaction options')
    const {
      isDeviceRevoked,
      audience,
      now,
      ttlMs = DEFAULT_TTL_MS,
      max = DEFAULT_MAX,
      maxPerBrowser = DEFAULT_PER_BINDING,
      maxPerDevice = DEFAULT_PER_BINDING
    } = options
    if (typeof isDeviceRevoked !== 'function') throw new Error('Device transactions need a revocation check')
    const origin = readAudience(audience)
    if (origin === null) throw new Error('Device transactions need an HTTPS or loopback origin as audience')
    if (now !== undefined && typeof now !== 'function') throw new Error('Invalid device transaction clock')
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > TTL_CEILING_MS) throw new Error('Invalid device transaction lifetime')
    if (!Number.isInteger(max) || max < 1 || max > MAX_CEILING) throw new Error('Invalid device transaction capacity')
    for (const limit of [maxPerBrowser, maxPerDevice]) {
      if (!Number.isInteger(limit) || limit < 1 || limit > PER_BINDING_CEILING) throw new Error('Invalid device transaction capacity')
    }
    this.isDeviceRevoked = isDeviceRevoked
    this.origin = origin
    this.now = now ?? Date.now
    this.ttlMs = ttlMs
    this.max = max
    this.maxPerBrowser = maxPerBrowser
    this.maxPerDevice = maxPerDevice
  }

  /** The origin every transcript from this store names. Fixed at construction. */
  get audience(): string {
    return this.origin
  }

  /** Open transactions, including any expired ones not yet swept. */
  get size(): number {
    return this.held.size
  }

  create(input: { device: unknown; browserSecretHash: unknown; csrfHash: unknown }): CreateOutcome {
    if (!isRecord(input)) return { ok: false, reason: 'invalid' }
    const { device: rawDevice, browserSecretHash: rawBrowser, csrfHash: rawCsrf } = input
    const device = readDevicePayload(rawDevice)
    const browserSecretHash = digestOf(rawBrowser)
    const csrfHash = digestOf(rawCsrf)
    if (device === null || browserSecretHash === null || csrfHash === null || browserSecretHash.equals(csrfHash)) {
      return { ok: false, reason: 'invalid' }
    }
    const key = importKey(device.publicKeyJwk)
    if (key === null) return { ok: false, reason: 'invalid' }
    if (this.revoked(device.deviceId)) return { ok: false, reason: 'invalid' }
    const now = this.clock()
    this.sweep(now)
    const browserKey = browserSecretHash.toString('base64url')
    if (
      this.held.size >= this.max ||
      (this.perBrowser.get(browserKey) ?? 0) >= this.maxPerBrowser ||
      (this.perDevice.get(device.deviceId) ?? 0) >= this.maxPerDevice
    ) {
      return { ok: false, reason: 'capacity' }
    }

    let id = token()
    while (this.held.has(id)) id = token()
    const challenge = token()
    let callbackState = token()
    let stateKey = domainHash(CALLBACK_STATE_DOMAIN, callbackState)
    while (this.byState.has(stateKey) || callbackState === id || callbackState === challenge) {
      callbackState = token()
      stateKey = domainHash(CALLBACK_STATE_DOMAIN, callbackState)
    }
    const expiresAt = now + this.ttlMs
    const transcript = deviceTransactionTranscript({ audience: this.origin, transactionId: id, challenge, expiresAt, device })
    this.held.set(id, {
      id,
      device,
      key,
      transcript: Buffer.from(transcript, 'utf8'),
      browserSecretHash,
      csrfHash,
      browserKey,
      stateHash: Buffer.from(stateKey, 'base64url'),
      stateKey,
      expiresAt,
      phase: 'created',
      failures: 0,
      provenAt: 0
    })
    this.byState.set(stateKey, id)
    adjust(this.perBrowser, browserKey, 1)
    adjust(this.perDevice, device.deviceId, 1)
    const created: CreateOutcome = { ok: true, transactionId: id, challenge, callbackState, transcript, deviceId: device.deviceId, expiresAt }
    return Object.freeze(created)
  }

  /**
   * The device's proof. The browser binding is checked BEFORE the signature,
   * so a holder of the transaction id alone learns nothing about the key; a
   * bad signature from inside the binding burns the transaction outright,
   * because an honest device never produces one.
   */
  prove(transactionId: unknown, presented: { signature: unknown; browserSecret: unknown; csrfToken: unknown }): ProveOutcome {
    const now = this.clock()
    const found = this.lookup(transactionId, now)
    if (!found.ok) return found
    const held = found.held
    if (held.phase !== 'created') return { ok: false, reason: 'wrong_phase' }
    const { signature, browserSecret, csrfToken } = isRecord(presented) ? presented : ({} as Record<string, unknown>)
    const browserMatches = sameDigest(hashBrowserSecret(browserSecret), held.browserSecretHash)
    const csrfMatches = sameDigest(hashCsrfToken(csrfToken), held.csrfHash)
    if (!(browserMatches && csrfMatches)) return this.fail(held)
    const revoked = this.revoked(held.device.deviceId)
    if (this.held.get(held.id) !== held || held.phase !== 'created') return { ok: false, reason: 'unknown' }
    if (revoked) {
      this.drop(held)
      return { ok: false, reason: 'revoked' }
    }
    if (!signatureValid(held, signature)) {
      this.drop(held)
      return { ok: false, reason: 'bad_proof' }
    }
    held.phase = 'proven'
    held.provenAt = now
    const proven: ProveOutcome = { ok: true, deviceId: held.device.deviceId }
    return Object.freeze(proven)
  }

  /**
   * The callback. The state is the server's own 256-bit secret, distinct from
   * the browser's secret, the CSRF token, the id and the challenge, and only
   * its hash is held. A redemption before the proof is refused WITHOUT
   * spending the state; a successful one deletes the transaction.
   */
  redeem(presented: { state: unknown; browserSecret: unknown }): RedeemOutcome {
    const now = this.clock()
    if (!isRecord(presented)) return { ok: false, reason: 'unknown' }
    const { state, browserSecret } = presented
    if (!isToken(state)) return { ok: false, reason: 'unknown' }
    const stateKey = domainHash(CALLBACK_STATE_DOMAIN, state)
    const id = this.byState.get(stateKey)
    const held = id === undefined ? undefined : this.held.get(id)
    if (held === undefined || !sameDigest(stateKey, held.stateHash)) return { ok: false, reason: 'unknown' }
    if (!(now < held.expiresAt)) {
      this.drop(held)
      return { ok: false, reason: 'expired' }
    }
    if (held.phase !== 'proven') return { ok: false, reason: 'wrong_phase' }
    if (!sameDigest(hashBrowserSecret(browserSecret), held.browserSecretHash)) return this.fail(held)
    const revoked = this.revoked(held.device.deviceId)
    if (this.held.get(held.id) !== held || held.phase !== 'proven') return { ok: false, reason: 'unknown' }
    this.drop(held)
    if (revoked) return { ok: false, reason: 'revoked' }
    const result: DeviceTransactionResult = Object.freeze({
      transactionId: held.id,
      device: held.device,
      provenAt: held.provenAt
    })
    const redeemed: RedeemOutcome = { ok: true, result }
    return Object.freeze(redeemed)
  }

  /** Consume a proven device only inside the browser and CSRF binding that opened it. */
  takeForProvider(presented: { transactionId: unknown; browserSecret: unknown; csrfToken: unknown }): RedeemOutcome & ({ ok: false } | { ok: true; expiresAt: number }) {
    if (!isRecord(presented)) return { ok: false, reason: 'unknown' }
    const found = this.lookup(presented.transactionId, this.clock())
    if (!found.ok) return found
    const held = found.held
    if (held.phase !== 'proven') return { ok: false, reason: 'wrong_phase' }
    const browserMatches = sameDigest(hashBrowserSecret(presented.browserSecret), held.browserSecretHash)
    const csrfMatches = sameDigest(hashCsrfToken(presented.csrfToken), held.csrfHash)
    if (!(browserMatches && csrfMatches)) return this.fail(held)
    const revoked = this.revoked(held.device.deviceId)
    if (this.held.get(held.id) !== held || held.phase !== 'proven') return { ok: false, reason: 'unknown' }
    this.drop(held)
    if (revoked) return { ok: false, reason: 'revoked' }
    return Object.freeze({
      ok: true,
      result: Object.freeze({ transactionId: held.id, device: held.device, provenAt: held.provenAt }),
      expiresAt: held.expiresAt
    })
  }

  /** Cancel an open transaction. True only if there was one to cancel. */
  revoke(transactionId: unknown): boolean {
    if (!isToken(transactionId)) return false
    const held = this.held.get(transactionId)
    if (held === undefined) return false
    this.drop(held)
    return true
  }

  private lookup(
    transactionId: unknown,
    now: number
  ): { ok: true; held: Held } | { ok: false; reason: 'unknown' | 'expired' } {
    if (!isToken(transactionId)) return { ok: false, reason: 'unknown' }
    const held = this.held.get(transactionId)
    if (held === undefined) return { ok: false, reason: 'unknown' }
    if (!(now < held.expiresAt)) {
      this.drop(held)
      return { ok: false, reason: 'expired' }
    }
    return { ok: true, held }
  }

  private fail(held: Held): { ok: false; reason: 'mismatch' } {
    held.failures += 1
    if (held.failures >= FAILURE_LIMIT) this.drop(held)
    return { ok: false, reason: 'mismatch' }
  }

  private revoked(deviceId: string): boolean {
    try {
      return this.isDeviceRevoked(deviceId) !== false
    } catch {
      return true
    }
  }

  private clock(): number {
    const now = this.now()
    if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Invalid device transaction clock')
    return now
  }

  private sweep(now: number): void {
    for (const held of [...this.held.values()]) if (!(now < held.expiresAt)) this.drop(held)
  }

  /** Idempotent: only the first drop of a held transaction releases its slots. */
  private drop(held: Held): void {
    if (this.held.get(held.id) !== held) return
    this.held.delete(held.id)
    if (this.byState.get(held.stateKey) === held.id) this.byState.delete(held.stateKey)
    adjust(this.perBrowser, held.browserKey, -1)
    adjust(this.perDevice, held.device.deviceId, -1)
  }
}
