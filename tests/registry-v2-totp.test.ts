import { describe, expect, it } from 'vitest'
import {
  base32Decode,
  base32Encode,
  mintTotpSecret,
  otpauthUrl,
  totpAt,
  totpMatches,
  TOTP_STEP_MS
} from '../registry/src/v2-totp'

/**
 * RFC 6238 — the authenticator's six digits.
 *
 * The vectors are the RFC's own (Appendix B, SHA-1, K = "12345678901234567890"),
 * which are published as EIGHT digits. Six is the same value taken mod 10^6, so
 * the last six of each published number is what a phone shows — and proving our
 * digits against a published number is the only way to know that "the code is
 * wrong" is never our arithmetic.
 */

const SEED = Buffer.from('12345678901234567890', 'utf8')
const SEED_B32 = base32Encode(SEED)

/** seconds → the RFC's published eight digits. */
const VECTORS: readonly [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130']
]

describe('base32', () => {
  it('round-trips the RFC seed', () => {
    expect(SEED_B32).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    expect(base32Decode(SEED_B32)?.equals(SEED)).toBe(true)
  })

  it('reads a secret back however it was typed — spaces, lower case, padding', () => {
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')?.equals(SEED)).toBe(true)
    expect(base32Decode('MZXW6===')?.toString('utf8')).toBe('foo')
  })

  it('refuses what is not base32', () => {
    expect(base32Decode('not-base-32!')).toBeNull()
    expect(base32Decode('')).toBeNull()
    // '1', '8' and '9' are not in the alphabet; a typo is a refusal, not a guess.
    expect(base32Decode('GEZDGNBV1')).toBeNull()
  })

  it('mints a 160-bit secret', () => {
    const secret = mintTotpSecret()
    expect(base32Decode(secret)?.byteLength).toBe(20)
    expect(secret).not.toBe(mintTotpSecret())
  })
})

describe('totp digits', () => {
  for (const [seconds, eight] of VECTORS) {
    it(`matches RFC 6238 at t=${seconds}`, () => {
      expect(totpAt(SEED, seconds * 1000)).toBe(eight.slice(-6))
    })
  }

  it('is the same for every moment inside one 30-second step', () => {
    expect(totpAt(SEED, 30_000)).toBe(totpAt(SEED, 59_999))
    expect(totpAt(SEED, 60_000)).not.toBe(totpAt(SEED, 59_999))
  })
})

describe('totp window', () => {
  const at = 1111111109_000

  it('takes the step before, the step itself and the step after', () => {
    for (const shift of [-1, 0, 1]) {
      expect(totpMatches(SEED_B32, totpAt(SEED, at + shift * TOTP_STEP_MS), at)).toBe(true)
    }
  })

  it('refuses two steps out in either direction', () => {
    for (const shift of [-2, 2, 40]) {
      expect(totpMatches(SEED_B32, totpAt(SEED, at + shift * TOTP_STEP_MS), at)).toBe(false)
    }
  })

  it('reads a code the way a person types it, and refuses one that is not six digits', () => {
    expect(totpMatches(SEED_B32, ` ${totpAt(SEED, at)} `, at)).toBe(true)
    expect(totpMatches(SEED_B32, '12345', at)).toBe(false)
    expect(totpMatches(SEED_B32, '', at)).toBe(false)
    expect(totpMatches(SEED_B32, '00000o', at)).toBe(false)
    expect(totpMatches('not-a-secret', '123456', at)).toBe(false)
  })
})

describe('otpauth url', () => {
  it('names cookrew.dev as the issuer and the account', () => {
    const url = new URL(otpauthUrl('mira', SEED_B32))
    expect(url.protocol).toBe('otpauth:')
    expect(url.host).toBe('totp')
    expect(url.pathname).toBe('/cookrew.dev:mira')
    expect(url.searchParams.get('secret')).toBe(SEED_B32)
    expect(url.searchParams.get('issuer')).toBe('cookrew.dev')
    expect(url.searchParams.get('algorithm')).toBe('SHA1')
    expect(url.searchParams.get('digits')).toBe('6')
    expect(url.searchParams.get('period')).toBe('30')
  })
})
