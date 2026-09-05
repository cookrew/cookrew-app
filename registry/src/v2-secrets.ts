import { randomBytes, randomInt, scryptSync, createHash, timingSafeEqual } from 'node:crypto'

/**
 * IDENTITY v2 — THE SECRETS, and nothing else.
 *
 * One file for every value that must never be readable from the disk: the
 * password hash, the recovery codes, and the public half of a device key. It
 * holds no state and no policy, so the store above it can be read as rules
 * about people while this stays a place to check the cryptography.
 *
 * scrypt rather than argon2id, which the architecture note names. The registry
 * ships as ONE dependency-free esbuild bundle — a ConfigMap on the cluster —
 * and argon2 is a native module, so taking it would change what the registry
 * IS in order to change how a password is stretched. node:crypto's scrypt at
 * N=2^15 is the strongest thing available without that trade, and it is stated
 * here rather than in a commit message because a later reader deserves to know
 * it was a choice.
 */

/** N=2^15, r=8, p=1 — and the memory ceiling scrypt needs to be allowed to use it. */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const
const KEY_LEN = 32
const SALT_LEN = 16

export interface Hashed {
  /** base64url. */
  salt: string
  /** base64url. */
  hash: string
}

export const MIN_PASSWORD = 12
export const MAX_PASSWORD = 256

export function passwordIsAcceptable(password: unknown): password is string {
  return typeof password === 'string' && password.length >= MIN_PASSWORD && password.length <= MAX_PASSWORD
}

export function hashPassword(password: string): Hashed {
  const salt = randomBytes(SALT_LEN)
  return {
    salt: salt.toString('base64url'),
    hash: scryptSync(password, salt, KEY_LEN, SCRYPT).toString('base64url')
  }
}

/**
 * A CONSTANT-COST NO. An unknown username and a wrong password must be the
 * same answer AND the same wait — otherwise the timing is a directory of who
 * has an account here, which is exactly what the site refuses to publish.
 * `null` means "no such account": it is still stretched, against a salt that
 * belongs to nobody.
 */
const DECOY: Hashed = hashPassword(randomBytes(24).toString('base64url'))

export function verifyPassword(stored: Hashed | null, password: string): boolean {
  const against = stored ?? DECOY
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(against.salt, 'base64url')
    expected = Buffer.from(against.hash, 'base64url')
  } catch {
    return false
  }
  if (expected.byteLength !== KEY_LEN) return false
  let computed: Buffer
  try {
    computed = scryptSync(password, salt, KEY_LEN, SCRYPT)
  } catch {
    return false
  }
  const same = timingSafeEqual(computed, expected)
  return stored !== null && same
}

/**
 * RECOVERY CODES. Unambiguous by construction: no 0/O, no 1/I/L, because these
 * are read off a screen once and typed back months later, possibly from paper.
 */
export const RECOVERY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

export function mintRecoveryCode(): string {
  const block = (): string =>
    Array.from({ length: 4 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('')
  return `${block()}-${block()}`
}

/** Codes are compared case-insensitively and without their dash: people retype them. */
export const normaliseRecoveryCode = (code: string): string => code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')

/**
 * sha256 over a per-code salt rather than scrypt. Eight codes are minted at
 * once and one sign-in may have to try all eight; at scrypt's cost that is
 * most of a second per attempt for a value that already carries 40 bits from
 * a CSPRNG and sits behind the same limiter as a password.
 */
export function hashRecoveryCode(code: string): Hashed {
  const salt = randomBytes(SALT_LEN)
  return { salt: salt.toString('base64url'), hash: digest(salt, code) }
}

export function recoveryCodeMatches(stored: Hashed, code: string): boolean {
  let salt: Buffer
  try {
    salt = Buffer.from(stored.salt, 'base64url')
  } catch {
    return false
  }
  const a = Buffer.from(digest(salt, code), 'base64url')
  const b = Buffer.from(stored.hash, 'base64url')
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

const digest = (salt: Buffer, code: string): string =>
  createHash('sha256').update(salt).update(normaliseRecoveryCode(code), 'utf8').digest('base64url')

/**
 * A DEVICE KEY, reduced to its public members.
 *
 * Whatever a device sends, only the fields that make a public key survive —
 * so a `d` (the private half), a `key_ops` or anything else a browser's
 * exportKey happens to include is never written to our disk. A key carrying a
 * private half is refused outright rather than trimmed: a device that sent us
 * its secret has made a mistake we must not absorb silently.
 */
export function sanitiseJwk(input: unknown): Record<string, string> | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const jwk = input as Record<string, unknown>
  if (jwk.d !== undefined) return null
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null
  if (jwk.kty === 'OKP') {
    const x = text(jwk.x)
    if (jwk.crv !== 'Ed25519' || x === null) return null
    return { kty: 'OKP', crv: 'Ed25519', x }
  }
  if (jwk.kty === 'EC') {
    const x = text(jwk.x)
    const y = text(jwk.y)
    if (jwk.crv !== 'P-256' || x === null || y === null) return null
    return { kty: 'EC', crv: 'P-256', x, y }
  }
  return null
}
