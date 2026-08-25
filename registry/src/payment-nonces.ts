import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { EXPIRED_RETENTION_MS, type NonceState, type PaymentNonces } from './terms'

/**
 * QUOTES THAT SURVIVE A RESTART (M2-A4).
 *
 * Magpie flagged the memory version as process-scoped theatre and she was
 * right, but the reason that matters most is not the one it looks like.
 *
 * REPLAY DEFENCE is not what this file provides — that comes from the receipt,
 * which was already durable (see ./receipts.ts and `hasNonce`). What a restart
 * used to destroy is the record that a QUOTE WAS EVER ISSUED. A buyer who took
 * a quote, moved real money against it, and came back to a registry that had
 * bounced in between would meet `invalid`: their nonce was unknown to us, so we
 * would tell somebody who had just paid that their payment was not a payment.
 *
 * That is the same lie the `unverifiable` ruling was about, arriving by a
 * different road — and worse, because it accuses rather than admits. A quote is
 * a promise with a price on it, so it is written down.
 *
 * A lapsed quote is kept as lapsed for a while after it expires, for the same
 * reason it is in memory: `expired` and `unknown` are different answers, and
 * "your quote timed out" is not "that is not a payment".
 */

interface IssuedRecord {
  nonce: string
  binding: string
  exp: number
}

/**
 * Rewrite the file once it holds this many dead records. Quotes churn — one per
 * unpaid fetch of a priced preset — so an append-only file that never compacts
 * would grow without bound for a store whose live contents are minutes old.
 */
const COMPACT_AT_DEAD = 512

export class FilePaymentNonces implements PaymentNonces {
  private readonly file: string
  private issued = new Map<string, { binding: string; exp: number }>()
  private dead = 0

  constructor(base: string) {
    mkdirSync(base, { recursive: true })
    this.file = path.join(base, 'quotes.jsonl')
    if (!existsSync(this.file)) return
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue
      try {
        const record = JSON.parse(line) as IssuedRecord
        if (typeof record?.nonce !== 'string' || typeof record.exp !== 'number') continue
        this.issued.set(record.nonce, { binding: record.binding, exp: record.exp })
      } catch {
        // A truncated tail is a crash mid-append. Stop rather than skip: the
        // records after a gap are quotes we cannot be sure we wrote, and a
        // half-read quote store would hand out `unknown` for a live promise.
        break
      }
    }
  }

  mint(binding: string, now: number, ttlMs: number): string {
    const nonce = randomBytes(32).toString('base64url')
    const exp = now + ttlMs
    this.issued.set(nonce, { binding, exp })
    appendFileSync(this.file, `${JSON.stringify({ nonce, binding, exp } satisfies IssuedRecord)}\n`)
    this.sweep(now)
    return nonce
  }

  bindingOf(nonce: string): string | null {
    // Returned even for a LAPSED quote. The caller distinguishes expiry via
    // stateOf; folding the two together here would make an expired quote for
    // the right preset indistinguishable from one for the wrong preset.
    return this.issued.get(nonce)?.binding ?? null
  }

  expiryOf(nonce: string): number | null {
    return this.issued.get(nonce)?.exp ?? null
  }

  stateOf(nonce: string, now: number): NonceState {
    const entry = this.issued.get(nonce)
    if (entry === undefined) return 'unknown'
    return entry.exp < now ? 'expired' : 'ok'
  }

  /**
   * Drop quotes that lapsed long enough ago to be worth forgetting, and rewrite
   * the file when the dead outnumber the living by enough to matter.
   */
  private sweep(now: number): void {
    const before = this.issued.size
    for (const [key, entry] of this.issued) {
      if (entry.exp + EXPIRED_RETENTION_MS < now) this.issued.delete(key)
    }
    this.dead += before - this.issued.size
    if (this.dead < COMPACT_AT_DEAD) return
    // Written to a sibling and renamed, so a crash mid-compaction leaves the
    // previous file intact rather than a half-written one.
    const temporary = `${this.file}.compacting`
    const lines = [...this.issued]
      .map(([nonce, entry]) => JSON.stringify({ nonce, ...entry } satisfies IssuedRecord))
      .join('\n')
    writeFileSync(temporary, lines.length > 0 ? `${lines}\n` : '')
    renameSync(temporary, this.file)
    this.dead = 0
  }
}
