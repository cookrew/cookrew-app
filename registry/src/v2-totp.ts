import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * IDENTITY v2 — THE AUTHENTICATOR (RFC 6238, over RFC 4226).
 *
 * Six digits, thirty seconds, SHA-1 — not because SHA-1 is a good hash in
 * 2026 but because it is what every authenticator app on a person's phone
 * computes, and a factor nobody's phone can produce is not a factor. The
 * secret carries 160 bits from a CSPRNG and lives one HMAC away from the
 * code; the hash's collision weakness is not in the path.
 *
 * node:crypto only. The registry ships as one dependency-free bundle, so a
 * package that does this in forty lines is not worth what it would change
 * about what the registry IS (the same reasoning as scrypt in v2-secrets.ts).
 */

/** Thirty seconds, the interval every authenticator app assumes. */
export const TOTP_STEP_MS = 30_000
export const TOTP_DIGITS = 6
/** One step either side: phones drift, and people finish typing late. */
export const TOTP_WINDOW = 1
/** 160 bits, the length RFC 4226 recommends and what apps expect to be handed. */
const SECRET_BYTES = 20

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32, unpadded — what an otpauth:// URL carries. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/**
 * Base32 back to bytes, or null.
 *
 * FORGIVING ABOUT SHAPE, STRICT ABOUT CONTENT: spaces and lower case and
 * padding are how the secret is written down and read back, so they are
 * absorbed — but a character outside the alphabet is a typo, and a typo is a
 * refusal rather than a silently different secret.
 */
export function base32Decode(text: unknown): Buffer | null {
  if (typeof text !== 'string') return null
  const clean = text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
  if (clean.length === 0) return null
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const character of clean) {
    const at = ALPHABET.indexOf(character)
    if (at < 0) return null
    value = (value << 5) | at
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export const mintTotpSecret = (): string => base32Encode(randomBytes(SECRET_BYTES))

/** The eight-byte big-endian counter RFC 4226 signs. */
function counterBytes(step: number): Buffer {
  const out = Buffer.alloc(8)
  out.writeBigUInt64BE(BigInt(step))
  return out
}

/** The code for one moment, as digits with their leading zeros kept. */
export function totpAt(secret: Uint8Array, atMs: number, digits = TOTP_DIGITS): string {
  const step = Math.floor(atMs / TOTP_STEP_MS)
  const mac = createHmac('sha1', secret).update(counterBytes(step)).digest()
  // Dynamic truncation (RFC 4226 §5.3): the low nibble of the last byte says
  // where to read four bytes from, and the top bit of those is dropped.
  const offset = mac[mac.length - 1] & 0x0f
  const binary =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]
  return String(binary % 10 ** digits).padStart(digits, '0')
}

/**
 * Does this code open this secret, now?
 *
 * Every candidate in the window is compared and the loop is not cut short on
 * the first match: the answer takes the same time whichever step matched, so
 * the timing says nothing about how far a phone's clock has drifted.
 */
export function totpMatches(secretBase32: unknown, code: unknown, atMs: number, window = TOTP_WINDOW): boolean {
  return totpStepFor(secretBase32, code, atMs, window) !== null
}

/**
 * WHICH STEP a code belongs to, or null — so a verifier can remember it.
 *
 * RFC 6238 §5.2: a code that has been accepted must not be accepted again.
 * Ninety seconds of validity is ninety seconds in which a code read over
 * somebody's shoulder, or relayed by a page pretending to be us, is still
 * good — unless the step it names is written down and refused next time.
 * Returning the step is what makes that possible.
 */
export function totpStepFor(
  secretBase32: unknown,
  code: unknown,
  atMs: number,
  window = TOTP_WINDOW
): number | null {
  const secret = base32Decode(secretBase32)
  if (secret === null) return null
  const typed = typeof code === 'string' ? code.replace(/\s/g, '') : ''
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(typed)) return null
  const given = Buffer.from(typed, 'utf8')
  let matched: number | null = null
  for (let shift = -window; shift <= window; shift++) {
    const at = atMs + shift * TOTP_STEP_MS
    const candidate = Buffer.from(totpAt(secret, at), 'utf8')
    // Every candidate is compared and the loop is not cut short: the answer
    // takes the same time whichever step matched.
    if (candidate.byteLength === given.byteLength && timingSafeEqual(candidate, given)) {
      matched = Math.floor(at / TOTP_STEP_MS)
    }
  }
  return matched
}

/** The issuer a person sees in their authenticator, and the label under it. */
export const TOTP_ISSUER = 'cookrew.dev'

/**
 * The URL behind the QR — and the string we ALSO print as text, because a
 * registry that cannot draw a QR without a dependency can still be read by a
 * person with a keyboard.
 */
export function otpauthUrl(username: string, secret: string): string {
  // The colon between issuer and account is part of the label's SHAPE, so it
  // is not escaped; the two halves around it are.
  const label = `${encodeURIComponent(TOTP_ISSUER)}:${encodeURIComponent(username)}`
  const query = new URLSearchParams({
    secret,
    issuer: TOTP_ISSUER,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_MS / 1000)
  })
  return `otpauth://totp/${label}?${query.toString()}`
}
