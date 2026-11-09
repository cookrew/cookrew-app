import { createPublicKey, scrypt, timingSafeEqual, verify } from 'node:crypto'
import { fromB64u, verifyAssertion } from '../../registry/src/v2-passkeys'
import type { PasskeyAssertionWire } from '../shared/account-pair'

/**
 * THE ACCOUNT'S ANCHORS, AS THIS MACHINE CHECKS THEM.
 *
 * Three facts the registry holds and the machine needs in order to decide an
 * entry itself (shared/account-pair.ts): the password's scrypt record, the
 * account's passkeys, and which device keys are the account's. Read with the
 * machine's own credentials (account-v2.ts · pairAnchors), parsed strictly
 * here, never written to disk: a restart reads them again.
 *
 * THE PASSKEY VERIFIER IS THE REGISTRY'S OWN (registry/src/v2-passkeys.ts),
 * imported rather than copied. It is pure node:crypto plus a bounded CBOR
 * reader, and one WebAuthn checker is one place to get WebAuthn right.
 */

const B64U = /^[A-Za-z0-9_-]+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The registry's scrypt record (registry/src/v2-secrets.ts), with its cost. */
export interface PasswordRecord {
  readonly N: number
  readonly r: number
  readonly p: number
  readonly keylen: number
  readonly salt: string
  readonly hash: string
}

export interface PasskeyAnchor {
  readonly credentialId: string
  readonly jwk: Record<string, string>
  readonly signCount: number
}

export interface AccountDevice {
  readonly id: string
  readonly jwk: Record<string, string>
}

export interface PairAnchors {
  readonly username: string
  readonly rpId: string
  readonly password: PasswordRecord | null
  readonly passkeys: readonly PasskeyAnchor[]
  readonly devices: readonly AccountDevice[]
}

/**
 * THE COST A RECORD MAY ASK FOR. The registry stretches at N=2^15, r=8, p=1;
 * anything far past that is a record that would stall this machine for every
 * guess, so it reads as no password at all rather than as a slow one.
 */
const MAX_N = 1 << 17
const MAX_R = 16
const MAX_P = 4

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stringJwk = (value: unknown): Record<string, string> | null => {
  if (!isRecord(value)) return null
  const out: Record<string, string> = {}
  for (const key of ['kty', 'crv', 'x', 'y'] as const) {
    const held = value[key]
    if (held === undefined) continue
    if (typeof held !== 'string' || held.length > 256) return null
    out[key] = held
  }
  if (out.kty === 'OKP' && out.crv === 'Ed25519' && typeof out.x === 'string') return out
  if (out.kty === 'EC' && out.crv === 'P-256' && typeof out.x === 'string' && typeof out.y === 'string') return out
  return null
}

const readPassword = (value: unknown): PasswordRecord | null => {
  if (!isRecord(value)) return null
  const { N, r, p, keylen, salt, hash } = value
  if (typeof N !== 'number' || !Number.isInteger(N) || N < 2 || N > MAX_N || (N & (N - 1)) !== 0) return null
  if (typeof r !== 'number' || !Number.isInteger(r) || r < 1 || r > MAX_R) return null
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > MAX_P) return null
  if (keylen !== 32) return null
  if (typeof salt !== 'string' || !B64U.test(salt) || salt.length > 128) return null
  if (typeof hash !== 'string' || !B64U.test(hash) || Buffer.from(hash, 'base64url').length !== 32) return null
  return { N, r, p, keylen, salt, hash }
}

/** The registry's answer, or null when it is not one. Unknown members are dropped. */
export function readAnchors(body: unknown, username: string): PairAnchors | null {
  if (!isRecord(body)) return null
  if (body.username !== username || typeof body.rpId !== 'string' || body.rpId.length === 0) return null
  const password = body.password === null ? null : readPassword(body.password)
  if (body.password !== null && password === null) return null
  const passkeys: PasskeyAnchor[] = []
  for (const raw of Array.isArray(body.passkeys) ? body.passkeys.slice(0, 32) : []) {
    if (!isRecord(raw) || typeof raw.credentialId !== 'string' || !B64U.test(raw.credentialId)) continue
    const jwk = stringJwk(raw.jwk)
    if (jwk === null) continue
    const signCount = typeof raw.signCount === 'number' && raw.signCount >= 0 ? raw.signCount : 0
    passkeys.push({ credentialId: raw.credentialId, jwk, signCount })
  }
  const devices: AccountDevice[] = []
  for (const raw of Array.isArray(body.devices) ? body.devices.slice(0, 256) : []) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !UUID.test(raw.id)) continue
    const jwk = stringJwk(raw.jwk)
    if (jwk !== null) devices.push({ id: raw.id, jwk })
  }
  return { username, rpId: body.rpId, password, passkeys, devices }
}

/**
 * THE PASSWORD, CHECKED HERE. Async scrypt: the event loop carries every
 * terminal this machine serves, and a guess must not stall them.
 */
export function passwordMatches(record: PasswordRecord, password: string): Promise<boolean> {
  const salt = Buffer.from(record.salt, 'base64url')
  const stored = Buffer.from(record.hash, 'base64url')
  // scrypt's memory is 128 * N * r bytes; give it that and a little more.
  const maxmem = 128 * record.N * record.r * 2
  return new Promise((resolve) => {
    scrypt(password, salt, record.keylen, { N: record.N, r: record.r, p: record.p, maxmem }, (error, derived) => {
      if (error) {
        resolve(false)
        return
      }
      resolve(derived.length === stored.length && timingSafeEqual(derived, stored))
    })
  })
}

/** The device key is the account's, byte for byte, under that id. */
export function deviceOnAccount(anchors: PairAnchors, deviceId: string, jwk: unknown): boolean {
  const presented = stringJwk(jwk)
  if (presented === null) return false
  const held = anchors.devices.find((device) => device.id === deviceId)
  if (held === undefined) return false
  return (
    held.jwk.kty === presented.kty &&
    held.jwk.crv === presented.crv &&
    held.jwk.x === presented.x &&
    held.jwk.y === presented.y
  )
}

/**
 * A DEVICE KEY'S SIGNATURE. Ed25519 signs the message whole; a browser's P-256
 * key signs SHA-256 of it and WebCrypto writes r‖s (64 bytes), while the site
 * converts to DER for the registry — both are read.
 */
export function deviceSignatureValid(jwk: Record<string, string>, message: string, sig: string): boolean {
  const signature = fromB64u(sig, 160)
  if (signature === null) return false
  try {
    const key = createPublicKey({ key: jwk as never, format: 'jwk' })
    const data = Buffer.from(message, 'utf8')
    if (jwk.kty === 'OKP') return verify(null, data, key, signature)
    const dsaEncoding = signature.length === 64 ? 'ieee-p1363' : 'der'
    return verify('sha256', data, { key, dsaEncoding }, signature)
  } catch {
    return false
  }
}

const MAX_CLIENT_DATA = 4 * 1024

/** The origin a browser wrote into its own clientDataJSON, or null. */
const clientOrigin = (encoded: string): string | null => {
  const raw = fromB64u(encoded, MAX_CLIENT_DATA)
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'))
    return isRecord(parsed) && typeof parsed.origin === 'string' ? parsed.origin : null
  } catch {
    return null
  }
}

export type PasskeyCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * A PASSKEY'S ANSWER TO THIS MACHINE'S CHALLENGE.
 *
 * The origin must be one this machine names (the registry's, where the relay
 * serves the page, or one of its own published addresses); the registry's
 * checker then demands equality with it, the right rpId, presence AND user
 * verification — the passkey is the whole proof here, so a tap is not enough.
 */
export function passkeyMatches(
  anchors: PairAnchors,
  credential: PasskeyAssertionWire,
  expected: { readonly challenge: string; readonly origins: readonly string[] }
): PasskeyCheck {
  const held = anchors.passkeys.find((passkey) => passkey.credentialId === credential.id)
  if (held === undefined) return { ok: false, reason: 'not_this_account' }
  const origin = clientOrigin(credential.clientDataJSON)
  if (origin === null || !expected.origins.includes(origin)) return { ok: false, reason: 'bad_origin' }
  const asserted = verifyAssertion(
    {
      clientDataJSON: credential.clientDataJSON,
      authenticatorData: credential.authenticatorData,
      signature: credential.signature
    },
    { jwk: held.jwk, signCount: held.signCount },
    { challenge: expected.challenge, origin, rpId: anchors.rpId, requireUserVerification: true }
  )
  return asserted.ok ? { ok: true } : { ok: false, reason: asserted.reason }
}

/**
 * THE ANCHORS, FRESH WHEN THEY CAN BE. Each challenge asks the registry again,
 * so a password changed a minute ago is the one that works. When the registry
 * cannot be reached the last good answer is used for a while, and said so in
 * the trust model: an old password keeps opening only for that while.
 */
export interface AnchorSource {
  readonly get: () => Promise<PairAnchors | null>
}

export const ANCHORS_STALE_MS = 10 * 60_000

export function createAnchorSource(deps: {
  readonly fetch: () => Promise<unknown | null>
  readonly username: () => string | null
  readonly now?: () => number
}): AnchorSource {
  const now = deps.now ?? Date.now
  let last: { anchors: PairAnchors; at: number } | null = null
  return {
    get: async () => {
      const username = deps.username()
      if (username === null) return null
      let body: unknown = null
      try {
        body = await deps.fetch()
      } catch {
        body = null
      }
      const fresh = body === null ? null : readAnchors(body, username)
      if (fresh !== null) {
        last = { anchors: fresh, at: now() }
        return fresh
      }
      if (last !== null && last.anchors.username === username && now() - last.at <= ANCHORS_STALE_MS) {
        return last.anchors
      }
      return null
    }
  }
}
