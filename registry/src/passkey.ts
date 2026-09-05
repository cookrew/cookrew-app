import { CborError, cborMap, decodeCbor, decodeCborExact, type CborValue } from './cbor'
import { publicJwk, type Jwk } from './jwk'

/**
 * PASSKEY ENROLMENT — reading what an authenticator produced, and no more.
 *
 * A registration response carries an `attestationObject`: a CBOR map of
 * `{ fmt, attStmt, authData }` whose `authData` holds the credential id and the
 * new public key. This file parses that, and DELIBERATELY DOES NOT VERIFY THE
 * ATTESTATION — same trade M1 wrote down for `register`: the first sight of a
 * key is trusted, every later assertion is checked against it. Verifying
 * attestation means shipping a root store and a policy about which
 * manufacturers count, which is a different decision from "can this device sign
 * for this account".
 *
 * What it does insist on is a STRICT, BOUNDED parse. TOFU means the bytes here
 * decide what key an account will trust forever, so a parser that guessed at a
 * short buffer would be enrolling whatever followed it in memory.
 */

export type PasskeyFailure =
  | 'bad_cbor'
  | 'no_auth_data'
  | 'short_auth_data'
  | 'no_attested_credential'
  | 'bad_credential_id'
  | 'unsupported_key'

export interface ParsedPasskey {
  /** base64url, exactly as the browser will send it back in an assertion. */
  credentialId: string
  jwk: Jwk
  /** base64url; recorded for the devices list, never used as a decision. */
  aaguid: string
  signCount: number
  /** base64url of the rpIdHash the authenticator wrote. */
  rpIdHash: string
  userPresent: boolean
}

export type PasskeyParse =
  | { ok: true; passkey: ParsedPasskey }
  | { ok: false; reason: PasskeyFailure }

/** WebAuthn's own ceiling for a credential id. */
const MAX_CREDENTIAL_ID = 1023

/**
 * COSE_Key → JWK, for the two algorithms this registry verifies.
 *
 * The label numbers are the whole specification here: 1 is `kty`, -1 is `crv`
 * for both families, and then -2/-3 are x/y for EC2 while -2 alone is x for
 * OKP. Anything else is refused rather than coerced — an RSA passkey enrolled
 * as if it were a curve point is a device that can never sign again.
 */
export function coseToJwk(cose: CborValue): Jwk | null {
  const map = cborMap(cose)
  if (map === null) return null
  const kty = map.get(1)
  const x = map.get(-2)
  const crv = map.get(-1)
  if (kty === 2) {
    const y = map.get(-3)
    if (crv !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array)) return null
    if (x.byteLength !== 32 || y.byteLength !== 32) return null
    return publicJwk({
      kty: 'EC',
      crv: 'P-256',
      x: Buffer.from(x).toString('base64url'),
      y: Buffer.from(y).toString('base64url')
    })
  }
  if (kty === 1) {
    if (crv !== 6 || !(x instanceof Uint8Array) || x.byteLength !== 32) return null
    return publicJwk({ kty: 'OKP', crv: 'Ed25519', x: Buffer.from(x).toString('base64url') })
  }
  return null
}

/**
 * Parse an attestation object into the one device this account will trust.
 *
 * Every offset below is checked against the buffer before it is read, and the
 * COSE key is decoded by an item decoder that reports where it ended — so a
 * credential id length that overruns, or a key that claims more bytes than
 * arrived, is a refusal rather than a read past the end.
 */
export function parseAttestationObject(bytes: Uint8Array): PasskeyParse {
  let decoded: CborValue
  try {
    decoded = decodeCborExact(bytes)
  } catch (error) {
    if (error instanceof CborError || error instanceof TypeError) return { ok: false, reason: 'bad_cbor' }
    throw error
  }
  const top = cborMap(decoded)
  if (top === null) return { ok: false, reason: 'bad_cbor' }
  const authData = top.get('authData')
  if (!(authData instanceof Uint8Array)) return { ok: false, reason: 'no_auth_data' }
  // rpIdHash(32) + flags(1) + signCount(4)
  if (authData.byteLength < 37) return { ok: false, reason: 'short_auth_data' }
  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength)
  const flags = authData[32]
  const signCount = view.getUint32(33)
  // Bit 6 (AT): attested credential data is present. Without it there is no key
  // in here at all, whatever else the map said.
  if ((flags & 0x40) === 0) return { ok: false, reason: 'no_attested_credential' }
  if (authData.byteLength < 55) return { ok: false, reason: 'short_auth_data' }
  const idLength = view.getUint16(53)
  if (idLength === 0 || idLength > MAX_CREDENTIAL_ID) return { ok: false, reason: 'bad_credential_id' }
  const idAt = 55
  if (authData.byteLength < idAt + idLength) return { ok: false, reason: 'short_auth_data' }
  const credentialId = authData.slice(idAt, idAt + idLength)
  let key: CborValue
  try {
    key = decodeCbor(authData, idAt + idLength).value
  } catch (error) {
    if (error instanceof CborError || error instanceof TypeError) return { ok: false, reason: 'unsupported_key' }
    throw error
  }
  const jwk = coseToJwk(key)
  if (jwk === null) return { ok: false, reason: 'unsupported_key' }
  return {
    ok: true,
    passkey: {
      credentialId: Buffer.from(credentialId).toString('base64url'),
      jwk,
      aaguid: Buffer.from(authData.slice(37, 53)).toString('base64url'),
      signCount,
      rpIdHash: Buffer.from(authData.slice(0, 32)).toString('base64url'),
      userPresent: (flags & 0x01) !== 0
    }
  }
}
