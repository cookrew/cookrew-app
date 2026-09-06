import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * ACME — THE KEY AND THE SIGNATURES, with node:crypto and nothing else.
 *
 * RFC 8555 speaks JWS, and every ACME library on npm exists to hide that. The
 * registry bundle carries no dependencies at all (see package.json's
 * registry:build), so the ~130 lines it actually needs live here, apart from
 * the protocol so each half can be read on its own.
 *
 * THE ACCOUNT KEY IS THE ACCOUNT. Whoever holds it can revoke every
 * certificate we have ever issued, so it is written 0600 on the volume, made
 * once, and never printed, logged or returned. ES256 because it is the one
 * algorithm every ACME server must support and the smallest to carry.
 */

export const ACCOUNT_KEY_FILE = 'acme-account.key'

export const b64url = (bytes: Uint8Array | string): string =>
  Buffer.from(bytes as Uint8Array).toString('base64url')

const json = (value: unknown): string => JSON.stringify(value)

export interface AccountKey {
  key: KeyObject
  /** The PUBLIC half, as ACME wants it in a protected header. */
  jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }
  /** base64url(sha256(canonical jwk)) — half of every dns-01 answer. */
  thumbprint: string
}

/**
 * THE THUMBPRINT (RFC 7638): the three members that define a P-256 key, in
 * lexicographic order, with no whitespace. The order is not a style choice —
 * a different one is a different digest, and the CA computes its own.
 */
export function thumbprintOf(jwk: AccountKey['jwk']): string {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`
  return b64url(createHash('sha256').update(canonical, 'utf8').digest())
}

const publicJwkOf = (key: KeyObject): AccountKey['jwk'] => {
  const raw = createPublicKey(key).export({ format: 'jwk' }) as { crv?: string; x?: string; y?: string }
  if (raw.crv !== 'P-256' || typeof raw.x !== 'string' || typeof raw.y !== 'string') {
    throw new Error('acme account key is not P-256')
  }
  return { kty: 'EC', crv: 'P-256', x: raw.x, y: raw.y }
}

/**
 * The account key on the data volume, made on first use.
 *
 * A key that already exists is REUSED even if its mode has drifted — the file
 * is chmodded rather than replaced, because throwing away an ACME account
 * silently orphans every certificate issued under it. Chmodded and not
 * rewritten: `writeFileSync`'s `mode` applies only when it creates the file,
 * so writing the same bytes back left a 0644 key exactly as it was found.
 */
export function accountKey(dataDir: string): AccountKey {
  mkdirSync(dataDir, { recursive: true })
  const file = path.join(dataDir, ACCOUNT_KEY_FILE)
  if (existsSync(file)) {
    const key = createPrivateKey(readFileSync(file, 'utf8'))
    // chmod, NOT a rewrite. `writeFileSync(..., { mode })` applies the mode
    // only when it CREATES the file, so writing the same bytes back left a key
    // that had drifted to 0644 exactly as world-readable as it was — and the
    // check that existed to notice ran on every boot and did nothing.
    if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600)
    const jwk = publicJwkOf(key)
    return { key, jwk, thumbprint: thumbprintOf(jwk) }
  }
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  // Written with the mode, not chmodded after: between the two there is a
  // moment when the account key is world-readable.
  writeFileSync(file, pem, { mode: 0o600, flag: 'wx' })
  const jwk = publicJwkOf(privateKey)
  return { key: privateKey, jwk, thumbprint: thumbprintOf(jwk) }
}

/**
 * ES256 wants r‖s, node signs DER. Two integers out of a SEQUENCE, each left
 * padded to 32 bytes — a signature that skips this is rejected by every CA
 * with a message about the key, which is the wrong place to look.
 */
export function derToRaw(der: Uint8Array, size = 32): Uint8Array | null {
  if (der[0] !== 0x30) return null
  let at = der[1] < 0x80 ? 2 : 2 + (der[1] & 0x7f)
  const out = new Uint8Array(size * 2)
  for (const half of [0, 1]) {
    if (der[at] !== 0x02) return null
    const length = der[at + 1]
    let bytes = der.subarray(at + 2, at + 2 + length)
    at += 2 + length
    while (bytes.length > size && bytes[0] === 0) bytes = bytes.subarray(1)
    if (bytes.length > size) return null
    out.set(bytes, half * size + (size - bytes.length))
  }
  return out
}

export interface JwsHeader {
  alg: 'ES256'
  nonce: string
  url: string
  /** Either the key itself (newAccount) or the account URL (everything else). */
  jwk?: AccountKey['jwk']
  kid?: string
}

/**
 * The flattened JSON serialisation ACME requires. `payload` of `null` is the
 * POST-as-GET form: an empty string, not the string "null".
 */
export function signJws(key: KeyObject, header: JwsHeader, payload: unknown | null): string {
  const protectedPart = b64url(json(header))
  const payloadPart = payload === null ? '' : b64url(json(payload))
  const der = sign('sha256', Buffer.from(`${protectedPart}.${payloadPart}`, 'utf8'), key)
  const raw = derToRaw(der)
  if (raw === null) throw new Error('acme signature was not a DER ECDSA pair')
  return json({ protected: protectedPart, payload: payloadPart, signature: b64url(raw) })
}

/**
 * EXTERNAL ACCOUNT BINDING (RFC 8555 §7.3.4) — a second JWS, HS256 over our
 * own public key with a secret the CA handed out beforehand. Let's Encrypt
 * needs none; ZeroSSL and the commercial CAs do, and the failover to one of
 * them is the reason this is here before it is used.
 */
export function externalAccountBinding(
  eab: { kid: string; hmacKey: string },
  jwk: AccountKey['jwk'],
  url: string
): Record<string, string> {
  const header = b64url(json({ alg: 'HS256', kid: eab.kid, url }))
  const payload = b64url(json(jwk))
  const mac = createHmac('sha256', Buffer.from(eab.hmacKey, 'base64url'))
    .update(`${header}.${payload}`, 'utf8')
    .digest()
  return { protected: header, payload, signature: b64url(mac) }
}

/**
 * THE dns-01 ANSWER: base64url(sha256(token "." thumbprint)). The TXT record
 * is the digest, not the key authorisation itself — a mistake that validates
 * against a fake server and fails against every real one.
 */
export const keyAuthorization = (token: string, thumbprint: string): string => `${token}.${thumbprint}`

export const dns01Digest = (token: string, thumbprint: string): string =>
  b64url(createHash('sha256').update(keyAuthorization(token, thumbprint), 'utf8').digest())
