import { createPublicKey, verify } from 'node:crypto'
import { fromB64u, verifyAssertion } from '../../registry/src/v2-passkeys'
import type { PasskeyAssertionWire } from '../shared/account-pair'

/**
 * THE ACCOUNT'S ANCHORS, AS THIS MACHINE READS THEM.
 *
 * Two facts the registry holds (shared/account-pair.ts): the account's passkeys
 * and which device keys are the account's. Read with the machine's own
 * credentials (account-v2.ts · pairAnchors) and parsed strictly here. The
 * passkeys are then PINNED by the machine (account-pair-pins.ts); no password
 * record ever comes from the registry — the machine checks a password against
 * its own verifier, so cookrew.dev cannot hand it one it chose.
 *
 * THE PASSKEY VERIFIER IS THE REGISTRY'S OWN (registry/src/v2-passkeys.ts),
 * imported rather than copied. It is pure node:crypto plus a bounded CBOR
 * reader, and one WebAuthn checker is one place to get WebAuthn right.
 */

const B64U = /^[A-Za-z0-9_-]+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

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
  /** "Not me" was pressed: nothing may enter with this account until the password changes. */
  readonly locked: boolean
  readonly passkeys: readonly PasskeyAnchor[]
  readonly devices: readonly AccountDevice[]
}

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

/** The registry's answer, or null when it is not one. Unknown members are dropped. */
export function readAnchors(body: unknown, username: string): PairAnchors | null {
  if (!isRecord(body)) return null
  if (body.username !== username || typeof body.rpId !== 'string' || body.rpId.length === 0) return null
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
  return { username, rpId: body.rpId, locked: body.locked === true, passkeys, devices }
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
 * THE ANCHORS, FRESH WITHIN HALF A MINUTE. A passkey removed at cookrew.dev
 * stops opening within that. When the registry cannot be reached the last good
 * answer is used for ten minutes, so a short outage does not shut the door.
 */
export interface AnchorSource {
  /** `fresh` skips the short cache: a re-pin must read what the registry says now. */
  readonly get: (options?: { fresh?: boolean }) => Promise<PairAnchors | null>
}

export const ANCHORS_STALE_MS = 10 * 60_000
/**
 * How long one read answers every ask. An unauthenticated GET /api/pair must
 * not become one registry call per request — that is a way to spend the
 * machine's own budget at cookrew.dev and shut the owner out.
 */
export const ANCHORS_FRESH_MS = 30_000

export function createAnchorSource(deps: {
  readonly fetch: () => Promise<unknown | null>
  readonly username: () => string | null
  readonly now?: () => number
}): AnchorSource {
  const now = deps.now ?? Date.now
  let last: { anchors: PairAnchors; at: number } | null = null
  /** One read at a time: callers arriving together share it. */
  let flying: Promise<unknown | null> | null = null
  /** After a failed read, the registry is not asked again for a while. */
  let failedAt = -Infinity
  const read = (): Promise<unknown | null> => {
    flying ??= deps
      .fetch()
      .catch(() => null)
      .finally(() => {
        flying = null
      })
    return flying
  }
  return {
    get: async (options = {}) => {
      const username = deps.username()
      if (username === null) return null
      const cached = last !== null && last.anchors.username === username ? last : null
      if (options.fresh !== true && cached !== null && now() - cached.at < ANCHORS_FRESH_MS) return cached.anchors
      const resting = options.fresh !== true && now() - failedAt < ANCHORS_FRESH_MS
      const body = resting ? null : await read()
      const fresh = body === null ? null : readAnchors(body, username)
      if (fresh === null && !resting) failedAt = now()
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
