import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject
} from 'node:crypto'

/**
 * SEALED TO ONE DEVICE — a secret cookrew.dev carries but must not be able to
 * read (identity v3, R2: the reach handoff).
 *
 * A Mac says ALLOW and a pairing URL has to reach the phone that asked. It
 * travels through this registry, and the registry is exactly the party that
 * must not hold it: a pairing token is that Mac's keyboard. So the URL is
 * sealed to the ASKING DEVICE's key — the very jwk the account already holds
 * for that device — with the same construction the relay uses between a
 * caller and a door (src/shared/relay-seal.ts): X25519 → HKDF-SHA256 →
 * AES-256-GCM, one ephemeral per message, tag appended, base64url. Only the
 * device holding the matching private key can open it; a second device of the
 * same account cannot, and neither can this process once the ephemeral's
 * private half is dropped at the end of `sealToDevice`.
 *
 * THE DEVICE KEY IS A SIGNING KEY. Devices attach with Ed25519 (or P-256, for
 * browsers without it — `sanitiseJwk` admits the same two). Ed25519 cannot do
 * Diffie-Hellman as it stands, so the public point is mapped to its X25519
 * twin (RFC 7748 §4.1's birational map, u = (1+y)/(1−y)), and the device maps
 * its private seed the way libsodium's crypto_sign_ed25519_sk_to_curve25519
 * does — SHA-512 of the seed, clamped. Both halves live here, so the sealer
 * and the opener cannot drift, and a test can prove the map by opening what
 * was sealed. P-256 keys do ECDH directly.
 *
 * WHY NOT ASK THE DEVICE FOR A SEPARATE ENCRYPTION KEY. It would be a second
 * key to attach, revoke and trust — and the trust in the signing key is
 * already the thing the whole account rests on.
 */

const B64 = 'base64url' as const
const KEY_BYTES = 32
const TAG_BYTES = 16
const NONCE_BYTES = 12

/** What the asking device receives. `alg` says which curve the ephemeral is on. */
export interface SealedToDevice {
  alg: 'x25519' | 'p256'
  /** The sealer's ephemeral public key: raw X25519 (32 bytes) or a P-256 JWK's x‖y, base64url. */
  e: string
  /** AES-256-GCM ciphertext with the tag appended, base64url. */
  sealed: string
}

// ── Ed25519 → X25519 ──────────────────────────────────────────────────────

const P = (1n << 255n) - 19n

const modPow = (base: bigint, exp: bigint): bigint => {
  let out = 1n
  let b = ((base % P) + P) % P
  let e = exp
  while (e > 0n) {
    if (e & 1n) out = (out * b) % P
    b = (b * b) % P
    e >>= 1n
  }
  return out
}

const inverse = (value: bigint): bigint => modPow(value, P - 2n)

const fromLittleEndian = (bytes: Buffer): bigint => {
  let out = 0n
  for (let i = bytes.length - 1; i >= 0; i -= 1) out = (out << 8n) | BigInt(bytes[i])
  return out
}

const toLittleEndian = (value: bigint): Buffer => {
  const out = Buffer.alloc(KEY_BYTES)
  let v = value
  for (let i = 0; i < KEY_BYTES; i += 1) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/** The Ed25519 public point's Montgomery u-coordinate, as X25519 wants it. */
export function ed25519PublicToX25519(ed: Buffer): Buffer {
  if (ed.length !== KEY_BYTES) throw new Error('an Ed25519 public key is 32 bytes')
  const y = fromLittleEndian(ed) & ((1n << 255n) - 1n)
  const u = ((1n + y) * inverse((1n - y + P) % P)) % P
  return toLittleEndian(u)
}

/** The Ed25519 seed's X25519 scalar: SHA-512, first half, clamped. */
export function ed25519SeedToX25519(seed: Buffer): Buffer {
  if (seed.length !== KEY_BYTES) throw new Error('an Ed25519 seed is 32 bytes')
  const h = createHash('sha512').update(seed).digest().subarray(0, KEY_BYTES)
  h[0] &= 248
  h[31] &= 127
  h[31] |= 64
  return h
}

/** DER wrappers for a raw X25519 key, so Node's key objects can hold one. */
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex')
const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex')

const x25519Public = (raw: Buffer): KeyObject =>
  createPublicKey({ key: Buffer.concat([X25519_SPKI, raw]), type: 'spki', format: 'der' })
const x25519Private = (raw: Buffer): KeyObject =>
  createPrivateKey({ key: Buffer.concat([X25519_PKCS8, raw]), type: 'pkcs8', format: 'der' })

// ── the seal ──────────────────────────────────────────────────────────────

/** One key, one message: the label keeps this secret from ever doing another job. */
function messageKey(shared: Buffer, info: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from(`cookrew-device/1 ${info}`), KEY_BYTES)
  )
}

/** Sequence 0 of a channel that only ever carries one frame — as relay-seal's body does. */
const NONCE_0 = Buffer.alloc(NONCE_BYTES)

function sealWith(key: Buffer, plaintext: string): string {
  const cipher = createCipheriv('aes-256-gcm', key, NONCE_0)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([body, cipher.getAuthTag()]).toString(B64)
}

function openWith(key: Buffer, sealed: string): string | null {
  try {
    const raw = Buffer.from(sealed, B64)
    if (raw.length < TAG_BYTES) return null
    const decipher = createDecipheriv('aes-256-gcm', key, NONCE_0)
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES))
    return Buffer.concat([decipher.update(raw.subarray(0, raw.length - TAG_BYTES)), decipher.final()]).toString('utf8')
  } catch {
    // Tampered, replayed to the wrong device, or not ours: one silence for all.
    return null
  }
}

/**
 * Seal a short secret to a device's attached public key. Throws only on a key
 * this registry never admits — the store already refused those at attach.
 */
export function sealToDevice(jwk: Record<string, string>, info: string, plaintext: string): SealedToDevice {
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') {
    const theirs = x25519Public(ed25519PublicToX25519(Buffer.from(jwk.x, B64)))
    const ephemeral = generateKeyPairSync('x25519')
    const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: theirs })
    const e = ephemeral.publicKey.export({ type: 'spki', format: 'der' }).subarray(X25519_SPKI.length)
    return { alg: 'x25519', e: e.toString(B64), sealed: sealWith(messageKey(shared, info), plaintext) }
  }
  if (jwk.kty === 'EC' && jwk.crv === 'P-256') {
    const theirs = createPublicKey({ key: jwk as never, format: 'jwk' })
    const ephemeral = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: theirs })
    const pub = ephemeral.publicKey.export({ format: 'jwk' }) as { x: string; y: string }
    return { alg: 'p256', e: `${pub.x}.${pub.y}`, sealed: sealWith(messageKey(shared, info), plaintext) }
  }
  throw new Error('a device key is Ed25519 or P-256')
}

/**
 * THE DEVICE'S HALF. Opened with the device's own private JWK — the Ed25519
 * seed `d` or the P-256 scalar — and null for anything that does not verify,
 * including a message sealed to a different device of the same account.
 * Exported so the app can use exactly this and not a re-derivation of it.
 */
export function openAtDevice(
  privateJwk: Record<string, string>,
  info: string,
  sealed: SealedToDevice
): string | null {
  try {
    if (sealed.alg === 'x25519' && privateJwk.kty === 'OKP' && privateJwk.crv === 'Ed25519') {
      const mine = x25519Private(ed25519SeedToX25519(Buffer.from(privateJwk.d, B64)))
      const theirs = x25519Public(Buffer.from(sealed.e, B64))
      return openWith(messageKey(diffieHellman({ privateKey: mine, publicKey: theirs }), info), sealed.sealed)
    }
    if (sealed.alg === 'p256' && privateJwk.kty === 'EC' && privateJwk.crv === 'P-256') {
      const [x, y] = sealed.e.split('.')
      if (!x || !y) return null
      const mine = createPrivateKey({ key: privateJwk as never, format: 'jwk' })
      const theirs = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x, y } as never, format: 'jwk' })
      return openWith(messageKey(diffieHellman({ privateKey: mine, publicKey: theirs }), info), sealed.sealed)
    }
    return null
  } catch {
    return null
  }
}

/** Is this the shape a device hands back? For a route reading a body. */
export function isSealedToDevice(value: unknown): value is SealedToDevice {
  if (typeof value !== 'object' || value === null) return false
  const raw = value as Record<string, unknown>
  return (
    (raw.alg === 'x25519' || raw.alg === 'p256') &&
    typeof raw.e === 'string' &&
    raw.e.length > 0 &&
    raw.e.length <= 256 &&
    typeof raw.sealed === 'string' &&
    raw.sealed.length > 0 &&
    raw.sealed.length <= 8192
  )
}
