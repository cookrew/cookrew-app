import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { PresetPricing } from '../../src/shared/preset-manifest'

/**
 * RECEIPTS (M2-A3) — what a buyer already owns.
 *
 * The point of this file is that A BUYER MUST NOT SIGN PER FETCH. Without it
 * every download re-runs the 402 handshake, which means a wallet gesture to
 * open something you bought last week. So the entitlement step reads receipts
 * ABOVE the price step, and the second fetch is an ordinary 200 that never
 * reaches payment at all.
 *
 * NOT IN THE TRANSPARENCY LOG, and that is deliberate. The log's guarantee is
 * about what the registry served and who signed it; putting buyer identities in
 * a public append-only file is a privacy leak with no matching benefit, and it
 * would complicate a log that already carries a carefully narrow claim. These
 * are private records in the registry's own data directory.
 *
 * KEYED BY LINEAGE, NOT PRESET ID. A preset id is the content address of one
 * version, so a receipt against it would entitle exactly that byte-for-byte
 * team and nothing else — buying v2 would not entitle v3, and
 * `mkt.pay.buys`'s "v{version} and later" would be false the moment an author
 * shipped an update.
 */

export interface Receipt {
  /** Who bought. The passkey identity, the durable owner (R20's lesson). */
  identityId: string
  /** What they bought, across versions. */
  lineage: string
  /** The version at the moment of purchase — what "and later" is measured from. */
  version: number
  /** The preset id actually paid for, kept for audit rather than for matching. */
  presetId: string
  /** Single-use, and the reason a receipt cannot be manufactured by replay. */
  nonce: string
  tx: string
  /** What was paid, in the asset the terms named. */
  amount: string
  asset: 'USDC'
  at: number
}

export class ReceiptStore {
  private readonly file: string
  private records: Receipt[] = []

  constructor(base: string) {
    mkdirSync(base, { recursive: true })
    this.file = path.join(base, 'receipts.jsonl')
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (line.trim().length === 0) continue
        try {
          this.records = [...this.records, JSON.parse(line) as Receipt]
        } catch {
          // A truncated tail is the expected shape of a crash mid-append. Stop
          // rather than skip: a receipt read past a gap is a purchase we are
          // not sure we recorded, and guessing in either direction is wrong.
          break
        }
      }
    }
  }

  /**
   * Record a purchase. Append-only: a receipt is a fact about something that
   * already happened, and nothing here may edit one.
   */
  record(receipt: Receipt): void {
    this.records = [...this.records, receipt]
    appendFileSync(this.file, `${JSON.stringify(receipt)}\n`)
  }

  /** Every receipt this identity holds for this lineage, oldest first. */
  forLineage(identityId: string, lineage: string): Receipt[] {
    return this.records.filter((r) => r.identityId === identityId && r.lineage === lineage)
  }

  /** Has this nonce already produced a receipt? A4's durable replay answer. */
  hasNonce(nonce: string): boolean {
    return this.records.some((r) => r.nonce === nonce)
  }
}

/**
 * WHAT A RECEIPT ENTITLES, and the two pricing models differ.
 *
 * one-time  the version bought and every later one — `mkt.pay.buys` says
 *           "v{version} and later" and this is what makes that true.
 * per-call  the download, plus a PREPAID BALANCE. R5: pay-per-call is credit
 *           bought at install or top-up, never a wallet over a conversation.
 */
export function entitledTo(
  receipts: readonly Receipt[],
  input: { version: number; pricing: PresetPricing }
): boolean {
  if (receipts.length === 0) return false
  if (input.pricing.model === 'per-call') {
    // Owning ANY credit for this lineage entitles the download. Whether a
    // given CALL may run is the meter's question, answered on the call path
    // as 200 or 403 — never here, and never as a payment demand.
    return true
  }
  // The earliest purchase sets the floor: buying v2 entitles v2 and later, and
  // a buyer who bought v2 is not asked to pay again when v3 ships.
  return receipts.some((r) => r.version <= input.version)
}

/**
 * The prepaid balance, in BOTH units.
 *
 * Deck §7 requires it: "$0.30 USDC · ~4 calls left". Money alone makes the
 * buyer divide to learn how many answers they have; calls alone hides what a
 * top-up costs. One unit on the chip and the other in the sheet is the worst
 * option — that is arithmetic as a feature.
 */
export interface Balance {
  /** Remaining credit, a decimal string in the asset. Never a float. */
  amount: string
  /** How many calls that buys at the current unit price. Floor, never rounded up. */
  calls: number
}

/** Decimal-string money as integer cents, so no total is ever a float. */
function cents(amount: string): number {
  const [whole, fraction = ''] = amount.split('.')
  const padded = `${fraction}00`.slice(0, 2)
  return Number(whole) * 100 + Number(padded)
}

function fromCents(total: number): string {
  return `${Math.floor(total / 100)}.${String(total % 100).padStart(2, '0')}`
}

/**
 * Credit bought minus credit spent, and the calls it still buys.
 *
 * `spent` arrives from the meter rather than being tracked here: A3 owns what
 * was PAID, and the call path — which does not exist yet — owns what was used.
 * Keeping them apart is what stops this file quietly becoming a ledger of money
 * we hold, which we never do.
 */
export function balanceOf(
  receipts: readonly Receipt[],
  input: { pricing: PresetPricing; spentCents?: number }
): Balance {
  const credited = receipts.reduce((total, r) => total + cents(r.amount), 0)
  const remaining = Math.max(0, credited - (input.spentCents ?? 0))
  const unit = cents(input.pricing.amount)
  return {
    amount: fromCents(remaining),
    // Floor: a fraction of a call is not a call, and telling a buyer they have
    // one left when they do not is how `balance_empty` arrives as a surprise
    // mid-conversation — the exact thing R12's ordering exists to prevent.
    calls: unit > 0 ? Math.floor(remaining / unit) : 0
  }
}
