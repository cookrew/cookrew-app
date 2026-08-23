import { createHash, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FINGERPRINT_WORDS } from '../src/shared/fingerprint-words'
import {
  FINGERPRINT_BITS,
  fingerprintOfDigest,
  rawKeyOfJwk,
  decodeBase64Url
} from '../src/shared/key-fingerprint'
import { parseCallerKey } from '../src/shared/caller-key'

/**
 * THE WORDS ARE THE SECURITY (Velvet's deck §3).
 *
 * The comparison this renders for happens between two humans over a channel we
 * do not control, and it is the ONLY defence against the one wrong paste no
 * parser can catch: a well-formed key belonging to the wrong party. So the
 * properties the list and the phrase must have are asserted, not assumed — a
 * list that quietly lost a word, or a phrase that silently narrowed, would
 * weaken every comparison an owner has ever made without erroring once.
 */

const digestOf = (raw: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(raw).digest())

const fingerprintOf = (raw: Uint8Array): ReturnType<typeof fingerprintOfDigest> =>
  fingerprintOfDigest(digestOf(raw))

describe('the word list holds the properties the fingerprint rests on', () => {
  it('is exactly 2048 words, so a word is exactly 11 bits', () => {
    expect(FINGERPRINT_WORDS).toHaveLength(2048)
    expect(2 ** 11).toBe(2048)
  })

  it('has no duplicates — two keys must not be able to speak one phrase', () => {
    expect(new Set(FINGERPRINT_WORDS).size).toBe(2048)
  })

  it('is unambiguous at four characters, so a misheard word is recoverable', () => {
    expect(new Set(FINGERPRINT_WORDS.map((w) => w.slice(0, 4))).size).toBe(2048)
  })

  it('is speakable: lowercase a-z, 3 to 8 characters, nothing to spell out', () => {
    for (const word of FINGERPRINT_WORDS) {
      expect(word, word).toMatch(/^[a-z]{3,8}$/)
    }
  })
})

describe('the fingerprint', () => {
  it('is six words and carries 66 bits', () => {
    expect(FINGERPRINT_BITS).toBe(66)
    const fp = fingerprintOf(new Uint8Array(32).fill(7))
    expect(fp.words).toHaveLength(6)
    for (const word of fp.words) expect(FINGERPRINT_WORDS).toContain(word)
  })

  it('is stable for one key and different for another', () => {
    const a = fingerprintOf(new Uint8Array(32).fill(1))
    const b = fingerprintOf(new Uint8Array(32).fill(1))
    const c = fingerprintOf(new Uint8Array(32).fill(2))
    expect(a).toEqual(b)
    expect(a.words).not.toEqual(c.words)
    expect(a.hex).not.toEqual(c.hex)
  })

  it('hashes the RAW KEY, so the caller\'s own tooling computes the same phrase', () => {
    // The load-bearing one. If this hashed our JWK encoding, the number would be
    // reproducible only inside Cookrew — there would be nothing on the other end
    // of the phone call to compare it against, and the ceremony would be theatre.
    const { publicKey } = generateKeyPairSync('ed25519')
    const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>
    const raw = rawKeyOfJwk(jwk)
    expect(raw).not.toBeNull()

    // What any counterparty would compute from the key bytes alone.
    const theirs = fingerprintOfDigest(digestOf(raw as Uint8Array))
    // What we compute from the DER an owner would actually paste.
    const der = publicKey.export({ format: 'der', type: 'spki' })
    const parsed = parseCallerKey(der.toString('base64'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(fingerprintOfDigest(digestOf(parsed.raw))).toEqual(theirs)
  })

  it('shows the same 66 bits in hex as in words, not more', () => {
    // Two people comparing different amounts of the hash would conclude they
    // disagree. 66 bits ceils to 9 bytes; the spare 6 are masked off.
    const fp = fingerprintOf(new Uint8Array(32).fill(0xff))
    expect(fp.hex).toHaveLength(18)
    expect(parseInt(fp.hex.slice(-2), 16) & 0b111111).toBe(0)
  })

  it('refuses to fingerprint anything that is not an ed25519 public key', () => {
    // A fingerprint of the wrong bytes is worse than none: it would be compared,
    // and it would appear to work.
    expect(rawKeyOfJwk({ kty: 'RSA', n: 'x', e: 'AQAB' })).toBeNull()
    expect(rawKeyOfJwk({ kty: 'OKP', crv: 'X25519', x: 'aaaa' })).toBeNull()
    expect(rawKeyOfJwk({ kty: 'OKP', crv: 'Ed25519', x: 'tooshort' })).toBeNull()
  })

  it('decodes base64url with or without padding, and refuses junk', () => {
    expect(decodeBase64Url('AAAA')).toEqual(new Uint8Array([0, 0, 0]))
    expect(decodeBase64Url('not base64!')).toBeNull()
    expect(decodeBase64Url('')).toBeNull()
  })
})
