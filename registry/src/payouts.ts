import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * WHERE AN AUTHOR'S MONEY GOES (M2-A1).
 *
 * Ruled by Commander, 2026-08-22: money moves buyer → author and the registry
 * is NEVER in the path. So a priced preset needs one fact M1 never had — an
 * address to pay — and this is the only place it lives.
 *
 * KEYED TO THE IDENTITY, NOT THE AUTHOR KEY, and that is the whole design.
 * R20 made author keys rotatable: a key is a credential an identity holds and
 * may replace. A payout address bound to a key would therefore go stale exactly
 * when a key rotates, and the failure mode of a stale payout binding is money
 * sent somewhere nobody is watching. The passkey identity is the durable owner
 * — the same reasoning that made lineage identity-keyed rather than key-keyed.
 *
 * NOT A LEDGER. Nothing here records what was paid, owed or held, because
 * nothing is ever paid, owed or held BY US. This is an address book with one
 * entry per author, and the moment it grows a balance column somebody has taken
 * custody by accident.
 */

/**
 * An EVM address: `0x` and 40 hex digits.
 *
 * FLAGGED, and deliberately not faked: this is a FORMAT check, not an EIP-55
 * checksum check. A checksummed address encodes its own typo detection in the
 * case of its letters, and validating that needs keccak256, which node:crypto
 * does not provide. So a mistyped-but-well-formed address still passes here and
 * the money would go nowhere recoverable.
 *
 * The mitigation that costs nothing is upstream: the address arrives at PUBLISH
 * time, from the author, in a ceremony they are already present for — so the
 * party who can check it is the party who typed it. Real checksum validation
 * wants a keccak dependency and is worth doing before this faces a public
 * network; it is recorded here rather than assumed away.
 */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** The address that means "nobody" on every EVM chain. Never a payee. */
const ZERO = '0x0000000000000000000000000000000000000000'

export function isPayoutAddress(value: unknown): value is string {
  return typeof value === 'string' && EVM_ADDRESS.test(value) && value.toLowerCase() !== ZERO
}

export class PayoutStore {
  private readonly file: string
  private addresses: Record<string, string> = {}

  constructor(base: string) {
    mkdirSync(base, { recursive: true })
    this.file = path.join(base, 'payouts.json')
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
        if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
          this.addresses = raw as Record<string, string>
        }
      } catch {
        // A corrupt address book is EMPTY, never partial. Publishing then
        // refuses to price until an author re-supplies an address, which is a
        // stall; guessing at half a file would be a payment.
        this.addresses = {}
      }
    }
  }

  /** The address to pay this identity, or null if it has never given one. */
  addressOf(identityId: string): string | null {
    const address = this.addresses[identityId]
    return isPayoutAddress(address) ? address : null
  }

  /**
   * Record where an identity is paid. Stored VERBATIM — never lower-cased,
   * because EIP-55 encodes a checksum in the case of the letters and
   * normalising it would destroy the one typo defence the string carries.
   *
   * A change is allowed and is not a special ceremony, because it cannot be
   * reached without one: the only caller is publish, which already requires a
   * fresh countersigned WebAuthn assertion from this identity. Anyone able to
   * change the address can already publish as the author, so a second gate here
   * would guard a door that is inside the building.
   */
  bind(identityId: string, address: string): boolean {
    if (!isPayoutAddress(address)) return false
    if (this.addresses[identityId] === address) return true
    this.addresses = { ...this.addresses, [identityId]: address }
    writeFileSync(this.file, JSON.stringify(this.addresses, null, 2))
    return true
  }
}
