import { FINGERPRINT_WORDS } from './fingerprint-words'

/**
 * A caller's public key, spoken in six words (Velvet's deck §3).
 *
 * WHAT THIS IS DEFENDING AGAINST, and it is worth being exact because five of
 * the six ways a paste goes wrong are caught by a parser and this one is not.
 * A well-formed ed25519 key belonging to the WRONG PARTY survives every check
 * we can write, and is precisely what an attacker supplies. No error exists for
 * it. The only defence is a human comparing this fingerprint against what the
 * other person sees, over a channel we have no access to.
 *
 * So the rendering is chosen for that comparison and not for the screen:
 *
 *   SIX WORDS, because the comparison is SPOKEN. Six words read aloud in three
 *   seconds and confirm with certainty; sixteen hex characters get read aloud
 *   wrongly, and a comparison people perform badly is not a comparison.
 *
 *   66 BITS — six words × 11 bits, exactly. Far past what an attacker can grind
 *   a colliding key for, and the number falls out of the word count rather than
 *   being chosen to sound sufficient.
 *
 *   THE RAW KEY, not the JWK. The bytes hashed are the ed25519 public key
 *   itself, so the owner's fingerprint and the caller's own tooling compute the
 *   SAME phrase. Hashing our JSON encoding would produce a number only Cookrew
 *   can reproduce, which cannot be compared against anything and would make the
 *   whole ceremony theatre.
 *
 * The hex is offered underneath for anyone who prefers to compare text; it is
 * the same 66 bits, not a second fingerprint.
 */

/** Six words at 11 bits each — the width the word list was chosen to give. */
const WORDS_IN_FINGERPRINT = 6
const BITS_PER_WORD = 11
export const FINGERPRINT_BITS = WORDS_IN_FINGERPRINT * BITS_PER_WORD

export interface KeyFingerprint {
  /** The six words, in order. Rendered large — this is what gets read aloud. */
  words: readonly string[]
  /** The same bits as hex, for anyone comparing text instead of speech. */
  hex: string
}

/** Base64url (and base64) → bytes, without assuming padding is present. */
export function decodeBase64Url(value: string): Uint8Array | null {
  const normalised = value.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '')
  if (normalised.length === 0 || !/^[A-Za-z0-9+/]+=*$/.test(normalised)) return null
  try {
    const binary = atob(normalised.padEnd(Math.ceil(normalised.length / 4) * 4, '='))
    return Uint8Array.from(binary, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/**
 * Take the first `FINGERPRINT_BITS` of a digest as word indices.
 *
 * Big-endian across the digest, most significant bit first, so the phrase is a
 * prefix of the hash in the ordinary reading — the same convention every other
 * tool that speaks a key uses, which matters when the person on the other end
 * of the call is not running Cookrew.
 */
function wordsOf(digest: Uint8Array): string[] {
  const words: string[] = []
  for (let word = 0; word < WORDS_IN_FINGERPRINT; word += 1) {
    let index = 0
    for (let bit = 0; bit < BITS_PER_WORD; bit += 1) {
      const position = word * BITS_PER_WORD + bit
      const byte = digest[position >> 3] ?? 0
      index = (index << 1) | ((byte >> (7 - (position & 7))) & 1)
    }
    words.push(FINGERPRINT_WORDS[index])
  }
  return words
}

function hexOf(digest: Uint8Array): string {
  // Ceil to whole bytes, then mask the tail so the hex shows the SAME 66 bits
  // the words do. Printing more would invite two people comparing different
  // amounts of the hash and concluding they disagree.
  const bytes = Math.ceil(FINGERPRINT_BITS / 8)
  const out = Array.from(digest.slice(0, bytes))
  const spare = bytes * 8 - FINGERPRINT_BITS
  if (spare > 0) out[bytes - 1] = out[bytes - 1] & (0xff << spare)
  return out.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The fingerprint of an already-hashed key. Exported for the async wrappers. */
export function fingerprintOfDigest(digest: Uint8Array): KeyFingerprint {
  return { words: wordsOf(digest), hex: hexOf(digest) }
}

/**
 * The raw ed25519 public key inside a JWK, or null.
 *
 * `x` is the 32-byte public key, base64url. Anything that is not an OKP
 * Ed25519 key with a 32-byte `x` returns null rather than a fingerprint over
 * whatever bytes happened to be there — a fingerprint of the wrong thing is
 * worse than none, because it would be compared and would appear to work.
 */
export function rawKeyOfJwk(jwk: Record<string, unknown>): Uint8Array | null {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') return null
  if (typeof jwk.x !== 'string') return null
  const raw = decodeBase64Url(jwk.x)
  return raw && raw.length === 32 ? raw : null
}
