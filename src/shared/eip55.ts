// The payout address check, at the one place that can make it.
//
// The registry NEVER holds funds (R27): payTo is the author's own address and
// the buyer pays them directly. Nothing downstream ever questions it — there
// is no settlement step that could bounce, no support desk that could reverse
// it. A mistyped-but-well-formed address is money sent nowhere recoverable,
// and publish is the only moment the product is looking at the address with a
// human present to fix it.
//
// Validation today is format-only — `0x` plus 40 hex — which accepts every
// single-character typo an author can make. EIP-55 encodes a keccak256
// checksum in the CASE of the hex digits, so a mixed-case address can be
// verified and a single-character change detected.
//
// "CANNOT VERIFY" DOES NOT RESOLVE TO "ACCEPT". This codebase has now reached
// that rule three times, and the third one is the one that cannot be undone:
//
//   1. A facilitator we cannot reach is our outage, not an invalid payment.
//   2. A terminal we cannot observe is our blindness, not a dropped brief.
//   3. An address we cannot check is unverified, not verified.
//
// The first two protect a report. This one protects an author's money, so the
// refusal is louder: an all-lowercase address is REFUSED rather than accepted
// unchecked, even though lowercase is the form authors paste most often —
// precisely because it is the common form, and a silent pass there is the
// whole exposure. The refusal carries the checksummed form so the fix is a
// paste, not a search.

import { keccak256Hex } from './keccak'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const ALL_LOWER_RE = /^0x[0-9a-f]{40}$/
const ALL_UPPER_RE = /^0x[0-9A-F]{40}$/

/** Why an address was refused. Each one implies a different fix. */
export type PayoutRefusal =
  /** Not an address at all: wrong prefix, wrong length, non-hex. */
  | 'malformed'
  /**
   * All one case, so it carries NO checksum information. We cannot verify it
   * and will not pretend otherwise — the checksummed form is suggested.
   */
  | 'unverifiable-case'
  /** Mixed case that does not match its own checksum: a typo, somewhere. */
  | 'checksum-mismatch'
  /** Well-formed, correctly checksummed, and a hole money never comes out of. */
  | 'burn-address'

export type PayoutCheck =
  | { ok: true; address: string }
  | {
      ok: false
      reason: PayoutRefusal
      message: string
      /**
       * The address the author probably meant, when that is COMPUTABLE. Only
       * offered for `unverifiable-case`, where the hex is taken as given and
       * just needs its checksum case applied. Never offered for a checksum
       * mismatch: a mismatch means either the hex or the case is wrong, and
       * re-checksumming wrong hex hands back a confidently wrong address.
       */
      suggestion?: string
    }

/** The EIP-55 mixed-case form of an address. Input case is ignored. */
export function toChecksumAddress(address: string): string {
  const hex = address.slice(2).toLowerCase()
  const hash = keccak256Hex(new TextEncoder().encode(hex))
  let out = '0x'
  for (let i = 0; i < hex.length; i += 1) {
    // A digit has no case, so only letters carry checksum bits.
    out += parseInt(hash[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i]
  }
  return out
}

/**
 * Check an address a publish is about to bind money to.
 *
 * Ordered so each refusal is the most specific true thing: shape, then the
 * burn address (true in any case form, and it masquerades as a case problem
 * because it has no letters), then whether a checksum EXISTS to verify, then
 * whether it matches.
 */
export function checkPayoutAddress(address: string): PayoutCheck {
  const candidate = address.trim()

  if (!ADDRESS_RE.test(candidate)) {
    return {
      ok: false,
      reason: 'malformed',
      message:
        'A payout address must be 0x followed by 40 hexadecimal characters. ' +
        'Paste the address exactly as your wallet shows it.'
    }
  }

  // BEFORE the case checks, because it is true in EVERY case form. The zero
  // address is all digits, so it has no letters to carry checksum bits: it
  // matches the all-lowercase pattern, is unchanged by toChecksumAddress, and
  // would otherwise be refused as `unverifiable-case` — a true statement that
  // buries the one that matters. It is also exactly what an empty
  // configuration field looks like after a well-meaning normalisation.
  if (/^0x0{40}$/i.test(candidate)) {
    return {
      ok: false,
      reason: 'burn-address',
      message:
        'This is the zero address. It is correctly formed, and anything paid to it is ' +
        'destroyed — it is also what an empty configuration field looks like once ' +
        'normalised, so it is refused rather than treated as a deliberate choice.'
    }
  }

  if (ALL_LOWER_RE.test(candidate) || ALL_UPPER_RE.test(candidate)) {
    // Refused, not accepted-with-a-warning. The checksum lives in the case, so
    // there is nothing here to check — and this address will be paid to
    // without anyone looking at it again.
    return {
      ok: false,
      reason: 'unverifiable-case',
      message:
        'This address is all one case, so it carries no checksum and cannot be verified. ' +
        'A single mistyped character would send your earnings somewhere unrecoverable. ' +
        'Paste the mixed-case form your wallet displays (suggested below), and check it against your wallet.',
      suggestion: toChecksumAddress(candidate)
    }
  }

  if (toChecksumAddress(candidate) !== candidate) {
    return {
      ok: false,
      reason: 'checksum-mismatch',
      message:
        'This address fails its own checksum, which means at least one character is wrong. ' +
        'Copy it again from your wallet rather than retyping it — we cannot tell you which ' +
        'character changed, only that one did.'
    }
  }

  return { ok: true, address: candidate }
}
