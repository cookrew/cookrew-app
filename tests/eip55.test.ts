import { describe, expect, it } from 'vitest'
import { checkPayoutAddress, toChecksumAddress } from '../src/shared/eip55'

// A MISTYPED-BUT-WELL-FORMED ADDRESS SENDS MONEY NOWHERE RECOVERABLE.
//
// Publish is the only place that can catch it: the registry never holds funds,
// so payTo is the author's own address and nothing downstream will ever
// question it. Today's validation is format-only — 0x plus 40 hex — which
// accepts every single-character typo an author can make.
//
// The refusal below is the part worth arguing about, so it is pinned hardest:
// an all-lowercase address carries NO checksum information at all, so we
// cannot verify it, and "cannot verify" must not resolve to "accept". That is
// the same rule this codebase already reached twice — an unreachable
// facilitator is not an invalid payment, an unobservable terminal is not a
// dropped brief — arriving a third time at money that cannot be undone.

// The canonical vectors from EIP-55 itself.
const OFFICIAL = [
  '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
  '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb'
]

describe('toChecksumAddress — the EIP-55 vectors', () => {
  it('produces the canonical mixed case from a lowercase address', () => {
    for (const address of OFFICIAL) {
      expect(toChecksumAddress(address.toLowerCase())).toBe(address)
    }
  })

  it('is idempotent on an already-checksummed address', () => {
    for (const address of OFFICIAL) {
      expect(toChecksumAddress(address)).toBe(address)
    }
  })
})

describe('checkPayoutAddress — accepts only what it can VERIFY', () => {
  it('accepts a correctly checksummed address', () => {
    for (const address of OFFICIAL) {
      expect(checkPayoutAddress(address)).toEqual({ ok: true, address })
    }
  })

  it('REFUSES a single-character typo that keeps the format valid', () => {
    // The whole point. This address is 0x + 40 hex and passes every
    // format-only check ever written; the checksum is what notices.
    const typo = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'
    const result = checkPayoutAddress(typo)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('checksum-mismatch')
  })

  it('REFUSES an all-lowercase address rather than accepting it unverified', () => {
    // EIP-55 encodes the checksum IN THE CASE, so a lowercase address carries
    // none. Accepting it would be accept-and-hope on the one field that moves
    // money — and lowercase is the form authors paste most often, which is
    // exactly why this must be a loud refusal with a fix, not a silent pass.
    const result = checkPayoutAddress(OFFICIAL[0].toLowerCase())
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('unverifiable-case')
  })

  it('REFUSES all-uppercase for the same reason', () => {
    const upper = `0x${OFFICIAL[0].slice(2).toUpperCase()}`
    const result = checkPayoutAddress(upper)
    expect(result.ok === false && result.reason).toBe('unverifiable-case')
  })

  it('hands back the CHECKSUMMED form so the author can just paste it', () => {
    // A refusal that only says no costs the author a web search. The fix is
    // computable from what they typed, so it ships with the refusal.
    const result = checkPayoutAddress(OFFICIAL[0].toLowerCase())
    expect(result.ok === false && result.suggestion).toBe(OFFICIAL[0])
  })

  it('offers NO suggestion for a checksum mismatch — we do not know the intent', () => {
    // A mismatch means one of two things: a typo in the hex, or a typo in the
    // case. Re-checksumming the hex would "fix" the case of an address whose
    // DIGITS are wrong and hand back a confidently wrong address. Silence is
    // the honest answer.
    const typo = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'
    const result = checkPayoutAddress(typo)
    expect(result.ok === false && result.suggestion).toBeUndefined()
  })

  it('refuses malformed input as malformed, not as a checksum problem', () => {
    const cases = ['', '0x', 'not-an-address', '5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xZZ']
    for (const bad of cases) {
      const result = checkPayoutAddress(bad)
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.reason).toBe('malformed')
    }
  })

  it('refuses the wrong LENGTH, which a typo can also produce', () => {
    expect(checkPayoutAddress(`${OFFICIAL[0]}a`).ok).toBe(false)
    expect(checkPayoutAddress(OFFICIAL[0].slice(0, -1)).ok).toBe(false)
  })

  it('refuses the zero address — well-formed, checksummed, and a black hole', () => {
    // Passes the checksum perfectly. Money sent here is gone, and it is a
    // plausible value for an uninitialised field to carry.
    const zero = toChecksumAddress(`0x${'0'.repeat(40)}`)
    const result = checkPayoutAddress(zero)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('burn-address')
  })

  it('every refusal explains itself, because the author has to act on it', () => {
    for (const bad of ['0xZZ', OFFICIAL[0].toLowerCase(), `0x${'0'.repeat(40)}`]) {
      const result = checkPayoutAddress(bad)
      expect(result.ok === false && result.message.length).toBeGreaterThan(20)
    }
  })
})

// ---------------------------------------------------------------------------
// Tinker's M1/L1/L2/L3.
// ---------------------------------------------------------------------------

describe('the address that can never carry a checksum (M1)', () => {
  // Found by search, not argument: ~1 in 3,704 valid addresses has a canonical
  // EIP-55 form that is entirely lowercase, because every letter lands on a
  // hash nibble under 8. Refusing it is right; suggesting the string just
  // refused is a product bug the author cannot escape.
  const UNCHECKABLE = '0x0a7384019ee13ed132e70549512345383e6e9e01'

  it('is genuinely one of them — its checksum form is its input', () => {
    expect(toChecksumAddress(UNCHECKABLE)).toBe(UNCHECKABLE)
  })

  it('is refused as uncheckable, not as a case mistake', () => {
    const result = checkPayoutAddress(UNCHECKABLE)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('uncheckable-address')
  })

  it('offers NO suggestion, because handing back the input reads as a bug', () => {
    const result = checkPayoutAddress(UNCHECKABLE)
    expect(result.ok === false && result.suggestion).toBeUndefined()
  })

  it('says plainly that no assurance is available here', () => {
    const result = checkPayoutAddress(UNCHECKABLE)
    expect(result.ok === false && result.message).toMatch(/cannot (confirm|carry)/i)
    expect(result.ok === false && result.message).toMatch(/wallet/i)
  })
})

describe('the low findings', () => {
  it('L3: an uppercase 0X prefix is a paste artefact, not malformed', () => {
    const upper0X = `0X${OFFICIAL[0].slice(2)}`
    const result = checkPayoutAddress(upper0X)
    expect(result.ok).toBe(true)
    // Normalised to a lowercase 0x on the way out, so nothing downstream —
    // manifest, terms, receipt — ever differs over a prefix nobody checksums.
    expect(result.ok === true && result.address).toBe(OFFICIAL[0])
  })

  it('L1: toChecksumAddress REJECTS an unprefixed address instead of slicing it', () => {
    // The old slice(2) dropped two hex digits and returned a well-formed,
    // wrong, 38-digit address — from an exported helper, next to money.
    expect(() => toChecksumAddress(OFFICIAL[0].slice(2))).toThrow(/0x-prefixed/)
    expect(() => toChecksumAddress('nonsense')).toThrow()
  })

  it('L2: burn-address is scoped to the zero address, and says so', () => {
    // 0x…dEaD and friends are conventions, not protocol. A guessed blocklist
    // that misses one is worse than a named limit.
    const dead = toChecksumAddress(`0x${'0'.repeat(36)}dead`)
    expect(checkPayoutAddress(dead).ok).toBe(true)
  })
})
