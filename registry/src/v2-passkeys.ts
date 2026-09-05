import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type KeyObject } from 'node:crypto'
import { cborMapGet, decodeCbor, decodeCborItem, type CborValue } from './v2-cbor'

/**
 * IDENTITY v2 — PASSKEYS, written from the WebAuthn specification.
 *
 * The recommended factor (owner's ruling, 2026-09-05): Touch ID and Face ID
 * first, an authenticator app second. What that means on this side is small
 * and unforgiving — read a public key out of an attestation the browser made,
 * then later check that a signature over `authenticatorData ‖ sha256(clientDataJSON)`
 * was made by it, and that the ceremony around it named US.
 *
 * WHAT IS CHECKED, AND WHY EACH ONE MATTERS:
 *   type         'webauthn.get' for a sign-in. A `create` reply replayed as a
 *                sign-in is a different ceremony with the same bytes.
 *   challenge    ours, and spent — single use is the whole anti-replay story.
 *   origin       string-equal to this registry's. `cookrew.dev.evil.test`
 *                contains our name and is not us; only equality knows that.
 *   rpIdHash     sha256 of our rpId, from the authenticator's own bytes.
 *   UP           the person was there. Without it a key sitting in a drawer
 *                signs on its own.
 *   signCount    when the authenticator keeps one, it must move. A counter
 *                that stands still is the signature of a cloned credential.
 *
 * ATTESTATION IS TRUSTED ON FIRST USE. We do not check a manufacturer's
 * certificate chain: the question this registry asks is "is this the same
 * authenticator as last time", and TOFU answers that with the key itself. So
 * `attStmt` is read past and never interpreted — which also means no format's
 * quirks can reach the parser.
 */

export interface StoredPasskey {
  /** Our id for the row — what DELETE /v2/me/passkeys/:id names. */
  id: string
  /** base64url of the raw credential id the authenticator gave itself. */
  credentialId: string
  jwk: Record<string, string>
  name: string
  signCount: number
  addedAt: number
}

export interface PasskeyExpectation {
  /** base64url, exactly as it was issued. */
  challenge: string
  /** scheme://host — string equality, never a suffix test. */
  origin: string
  rpId: string
}

export type PasskeyRefusal =
  | 'malformed'
  | 'bad_client_data'
  | 'bad_type'
  | 'bad_challenge'
  | 'bad_origin'
  | 'bad_rp'
  | 'not_present'
  | 'no_credential'
  | 'unsupported_key'
  | 'bad_signature'
  | 'clone_warning'

export type Registered =
  | { ok: true; credentialId: string; jwk: Record<string, string>; signCount: number }
  | { ok: false; reason: PasskeyRefusal }

export type Asserted = { ok: true; signCount: number } | { ok: false; reason: PasskeyRefusal }

/** An attestation object is a few hundred bytes; a megabyte of it is an attack. */
const MAX_ATTESTATION = 8 * 1024
const MAX_CLIENT_DATA = 4 * 1024
const MAX_SIGNATURE = 1024
const B64U = /^[A-Za-z0-9_-]*$/

const FLAG_UP = 0x01
const FLAG_AT = 0x40

/** base64url in, bytes out — or null, because a stranger typed it. */
export function fromB64u(value: unknown, max: number): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > max * 2) return null
  if (!B64U.test(value)) return null
  const out = Buffer.from(value, 'base64url')
  return out.byteLength === 0 || out.byteLength > max ? null : out
}

const sha256 = (bytes: Uint8Array | string): Buffer => createHash('sha256').update(bytes as never).digest()

/** Equal length and equal bytes, in constant time. */
const same = (a: Buffer, b: Buffer): boolean => a.byteLength === b.byteLength && timingSafeEqual(a, b)

interface ClientData {
  type: string
  challenge: string
  origin: string
}

/**
 * The browser's account of the ceremony. Parsed strictly: it is JSON a caller
 * wrote, so a missing field is a refusal rather than `undefined` flowing on.
 */
function readClientData(encoded: unknown, expected: PasskeyExpectation, type: string): PasskeyRefusal | ClientData {
  const raw = fromB64u(encoded, MAX_CLIENT_DATA)
  if (raw === null) return 'malformed'
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return 'bad_client_data'
  }
  if (typeof parsed !== 'object' || parsed === null) return 'bad_client_data'
  const held = parsed as Partial<ClientData>
  if (typeof held.type !== 'string' || typeof held.challenge !== 'string' || typeof held.origin !== 'string') {
    return 'bad_client_data'
  }
  if (held.type !== type) return 'bad_type'
  const given = Buffer.from(held.challenge, 'base64url')
  const wanted = Buffer.from(expected.challenge, 'base64url')
  if (!B64U.test(held.challenge) || !same(given, wanted)) return 'bad_challenge'
  if (held.origin !== expected.origin) return 'bad_origin'
  return { type: held.type, challenge: held.challenge, origin: held.origin }
}

interface AuthData {
  rpIdHash: Buffer
  flags: number
  signCount: number
  credentialId: Buffer | null
  cose: CborValue | null
}

/**
 * authenticatorData, by the specification's own layout:
 *   rpIdHash(32) ‖ flags(1) ‖ signCount(4) [ ‖ aaguid(16) ‖ len(2) ‖ id ‖ COSE ]
 * Every length is checked against the buffer before it is used as one.
 */
function readAuthData(bytes: Buffer): AuthData | null {
  if (bytes.byteLength < 37) return null
  const rpIdHash = bytes.subarray(0, 32)
  const flags = bytes[32]
  const signCount = bytes.readUInt32BE(33)
  if ((flags & FLAG_AT) === 0) return { rpIdHash, flags, signCount, credentialId: null, cose: null }
  if (bytes.byteLength < 55) return null
  const length = bytes.readUInt16BE(53)
  // A credential id is at most 1023 bytes by the specification; more than that
  // is a length somebody made up.
  if (length === 0 || length > 1023 || bytes.byteLength < 55 + length) return null
  const credentialId = bytes.subarray(55, 55 + length)
  const rest = bytes.subarray(55 + length)
  // The COSE key is followed by extensions when there are any, so the item is
  // read on its own terms rather than as "everything left".
  const key = decodeCborItem(rest)
  if (!key.ok) return null
  return { rpIdHash, flags, signCount, credentialId, cose: key.value }
}

/**
 * A COSE key reduced to the JWK the rest of this registry speaks — and only
 * for the two algorithms it can verify with. An RSA key or a curve we do not
 * check signatures on is refused at enrolment, not at the sign-in it would
 * have failed at months later.
 */
export function coseToJwk(cose: CborValue | null): Record<string, string> | null {
  if (!(cose instanceof Map)) return null
  const kty = cborMapGet(cose, 1)
  const alg = cborMapGet(cose, 3)
  const bytes = (key: number, length: number): string | null => {
    const value = cborMapGet(cose, key)
    return value instanceof Uint8Array && value.byteLength === length
      ? Buffer.from(value).toString('base64url')
      : null
  }
  if (kty === 2 && alg === -7 && cborMapGet(cose, -1) === 1) {
    const x = bytes(-2, 32)
    const y = bytes(-3, 32)
    return x === null || y === null ? null : { kty: 'EC', crv: 'P-256', x, y }
  }
  if (kty === 1 && alg === -8 && cborMapGet(cose, -1) === 6) {
    const x = bytes(-2, 32)
    return x === null ? null : { kty: 'OKP', crv: 'Ed25519', x }
  }
  return null
}

/** The registration ceremony: an attestation object in, a public key out. */
export function parseRegistration(
  input: { clientDataJSON: unknown; attestationObject: unknown },
  expected: PasskeyExpectation
): Registered {
  const client = readClientData(input.clientDataJSON, expected, 'webauthn.create')
  if (typeof client === 'string') return { ok: false, reason: client }
  const raw = fromB64u(input.attestationObject, MAX_ATTESTATION)
  if (raw === null) return { ok: false, reason: 'malformed' }
  const attestation = decodeCbor(raw)
  if (!attestation.ok) return { ok: false, reason: 'malformed' }
  const data = cborMapGet(attestation.value, 'authData')
  if (!(data instanceof Uint8Array)) return { ok: false, reason: 'malformed' }
  const auth = readAuthData(Buffer.from(data))
  if (auth === null) return { ok: false, reason: 'malformed' }
  if (!same(auth.rpIdHash, sha256(expected.rpId))) return { ok: false, reason: 'bad_rp' }
  if ((auth.flags & FLAG_UP) === 0) return { ok: false, reason: 'not_present' }
  if (auth.credentialId === null) return { ok: false, reason: 'no_credential' }
  const jwk = coseToJwk(auth.cose)
  if (jwk === null) return { ok: false, reason: 'unsupported_key' }
  return {
    ok: true,
    credentialId: auth.credentialId.toString('base64url'),
    jwk,
    signCount: auth.signCount
  }
}

function publicKeyOf(jwk: Record<string, string>): KeyObject | null {
  try {
    return createPublicKey({ key: jwk as never, format: 'jwk' })
  } catch {
    return null
  }
}

/** The sign-in ceremony: is this signature this credential's, over these bytes? */
export function verifyAssertion(
  input: { clientDataJSON: unknown; authenticatorData: unknown; signature: unknown },
  passkey: Pick<StoredPasskey, 'jwk' | 'signCount'>,
  expected: PasskeyExpectation
): Asserted {
  const client = readClientData(input.clientDataJSON, expected, 'webauthn.get')
  if (typeof client === 'string') return { ok: false, reason: client }
  const raw = fromB64u(input.authenticatorData, MAX_ATTESTATION)
  const signature = fromB64u(input.signature, MAX_SIGNATURE)
  const clientDataJSON = fromB64u(input.clientDataJSON, MAX_CLIENT_DATA)
  if (raw === null || signature === null || clientDataJSON === null) return { ok: false, reason: 'malformed' }
  const auth = readAuthData(raw)
  if (auth === null) return { ok: false, reason: 'malformed' }
  if (!same(auth.rpIdHash, sha256(expected.rpId))) return { ok: false, reason: 'bad_rp' }
  if ((auth.flags & FLAG_UP) === 0) return { ok: false, reason: 'not_present' }
  const key = publicKeyOf(passkey.jwk)
  if (key === null) return { ok: false, reason: 'unsupported_key' }
  const signed = Buffer.concat([raw, sha256(clientDataJSON)])
  let right = false
  try {
    // Ed25519 signs the message itself; ES256 hashes it first and hands node
    // a DER signature, which is what WebAuthn's `signature` already is.
    right =
      passkey.jwk.kty === 'OKP'
        ? verify(null, signed, key, signature)
        : verify('sha256', signed, key, signature)
  } catch {
    return { ok: false, reason: 'bad_signature' }
  }
  if (!right) return { ok: false, reason: 'bad_signature' }
  /**
   * THE COUNTER. An authenticator that keeps one increments it on every
   * assertion, so a value that did not move means two copies of a credential
   * that should have exactly one. Platform passkeys — Touch ID, Face ID —
   * keep no counter and report zero forever; refusing those would refuse the
   * factor this whole ladder recommends first, so zero means "no counter" and
   * the stored value is left where it is.
   */
  if (auth.signCount === 0) return { ok: true, signCount: passkey.signCount }
  if (auth.signCount <= passkey.signCount) return { ok: false, reason: 'clone_warning' }
  return { ok: true, signCount: auth.signCount }
}

/**
 * CHALLENGES, in memory and single use.
 *
 * A challenge is the only thing standing between a captured assertion and a
 * replay of it, so it is spent the first time it is presented, bound to the
 * key it was issued against (a pending sign-in, an address, an account), and
 * forgotten when it expires. In memory on purpose: a restart invalidates
 * every one of them, which is exactly what a restart should mean here.
 */
export class ChallengeStore {
  private readonly ttlMs: number
  private readonly perKey: number
  private readonly now: () => number
  private readonly held = new Map<string, { challenge: string; at: number }[]>()

  constructor(ttlMs = 120_000, perKey = 4, now: () => number = Date.now) {
    this.ttlMs = ttlMs
    this.perKey = perKey
    this.now = now
  }

  issue(key: string): string {
    const challenge = randomBytes(32).toString('base64url')
    const at = this.now()
    // Only the last few per key: a caller may open two tabs, and neither may
    // grow this into a place to put memory.
    const kept = [...(this.held.get(key) ?? []).filter((c) => at - c.at < this.ttlMs), { challenge, at }].slice(
      -this.perKey
    )
    this.held.set(key, kept)
    this.sweep(at)
    return challenge
  }

  /** True once per issued challenge, and only for the key it was issued to. */
  take(key: string, challenge: unknown): boolean {
    if (typeof challenge !== 'string' || challenge === '') return false
    const at = this.now()
    const held = this.held.get(key) ?? []
    const found = held.find((c) => c.challenge === challenge && at - c.at < this.ttlMs)
    if (found === undefined) return false
    const rest = held.filter((c) => c !== found)
    if (rest.length === 0) this.held.delete(key)
    else this.held.set(key, rest)
    return true
  }

  forget(key: string): void {
    this.held.delete(key)
  }

  private sweep(at: number): void {
    if (this.held.size < 2048) return
    for (const [key, entries] of this.held) {
      const alive = entries.filter((c) => at - c.at < this.ttlMs)
      if (alive.length === 0) this.held.delete(key)
      else this.held.set(key, alive)
    }
  }
}
