import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { checkoutSessionOf, isStripeCheckoutUrl } from '../shared/stripe-checkout'

/**
 * A CARD PAYMENT IN FLIGHT — remembered by main, on disk, until the door has
 * answered for it.
 *
 * When a door hands out a Checkout session, a card can be charged on it for up
 * to an hour, and nothing tells the door when that happens: there is no
 * webhook. The door learns of a payment only when the BUYER'S APP presents the
 * session id. So the id is the one thing that must not be lost, and it used to
 * live in a sheet's component state:
 *
 *   • close the sheet, pay on the page still open in the browser — nobody
 *     presents the session, and the buyer has paid for nothing;
 *   • close the sheet, open it again, press PAY — inside the door's quote
 *     window Stripe replays the same session, but across a window boundary it
 *     makes a NEW one while the first can still be paid: two charges.
 *
 * One entry per account and door. Written when a session is handed out;
 * removed when the door says `open` for it, or says it is unpaid once its life
 * is over (serve-gate.ts owns both moments). While an entry stands, no new
 * Checkout is asked for at that door for that account, by any surface.
 *
 * WHAT IS IN THE FILE: who, which door, the session id, Stripe's page address,
 * the quoted price, when. No Bearer and no key — the door checks the session
 * against the presenter's own sign-in, so the id opens nothing by itself. It
 * still says where this person is buying, so it is 0600 and on the list a
 * served seat may not read (owner-secrets.ts).
 */

export interface PendingCheckout {
  /** The username that started it. '' on the direct walk, where a key is the identity. */
  account: string
  /** The door's key in the gate: a published name, or a dialled address. */
  door: string
  /** The address the gate was asked with — what a later ask is made with. */
  link: string
  /** The Checkout session id: the only thing ever presented for this payment. */
  session: string
  /** Stripe's hosted page for it — reopened, never replaced. */
  url: string
  /** What the pay step quoted for the card, for the receipt. */
  price: string
  /** Epoch ms the door handed the session out. */
  startedAt: number
}

/** Where pending card payments wait. `base` exists so tests never touch a real home. */
export function pendingCheckoutsPath(base?: string): string {
  return path.join(base ?? path.join(homedir(), '.cookrew'), 'checkout-pending.json')
}

/**
 * A row this module would have written — and nothing else. The address is
 * re-checked on the way IN from disk because it is later opened in a browser:
 * a file edited by hand must not become a way to open anything but Stripe.
 */
function looksPending(value: unknown): value is PendingCheckout {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.account === 'string' &&
    typeof row.door === 'string' &&
    row.door.length > 0 &&
    typeof row.link === 'string' &&
    row.link.length > 0 &&
    typeof row.session === 'string' &&
    typeof row.price === 'string' &&
    typeof row.startedAt === 'number' &&
    Number.isFinite(row.startedAt) &&
    isStripeCheckoutUrl(row.url) &&
    checkoutSessionOf(row.url) === row.session
  )
}

export interface PendingCheckoutStore {
  get(account: string, door: string): PendingCheckout | null
  all(account: string): readonly PendingCheckout[]
  put(entry: PendingCheckout): void
  /** Forget `session` at this door — and only that one, so a late answer cannot erase a newer payment. */
  drop(account: string, door: string, session: string): void
}

/** The same memory with no file under it: for a gate nobody gave a disk (tests of other things). */
export function memoryPendingCheckouts(): PendingCheckoutStore {
  let rows: readonly PendingCheckout[] = []
  return {
    get: (account, door) => rows.find((row) => row.account === account && row.door === door) ?? null,
    all: (account) => rows.filter((row) => row.account === account),
    put: (entry) => {
      rows = [...rows.filter((row) => !(row.account === entry.account && row.door === entry.door)), entry]
    },
    drop: (account, door, session) => {
      rows = rows.filter((row) => !(row.account === account && row.door === door && row.session === session))
    }
  }
}

export class PendingCheckouts implements PendingCheckoutStore {
  private readonly base: string | undefined

  constructor(options: { base?: string } = {}) {
    this.base = options.base
  }

  /** Read fresh every time: two surfaces and a restart must all see one truth. */
  private load(): readonly PendingCheckout[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(pendingCheckoutsPath(this.base), 'utf8'))
      return Array.isArray(parsed) ? parsed.filter(looksPending) : []
    } catch {
      return []
    }
  }

  /** 0600, temp-and-rename: it names who is paying whom. */
  private save(rows: readonly PendingCheckout[]): void {
    const file = pendingCheckoutsPath(this.base)
    const temp = `${file}.tmp`
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(temp, `${JSON.stringify(rows, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(temp, 0o600)
    try {
      renameSync(temp, file)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
  }

  get(account: string, door: string): PendingCheckout | null {
    return this.load().find((row) => row.account === account && row.door === door) ?? null
  }

  all(account: string): readonly PendingCheckout[] {
    return this.load().filter((row) => row.account === account)
  }

  put(entry: PendingCheckout): void {
    const others = this.load().filter((row) => !(row.account === entry.account && row.door === entry.door))
    this.save([...others, entry])
  }

  drop(account: string, door: string, session: string): void {
    const rows = this.load()
    const kept = rows.filter((row) => !(row.account === account && row.door === door && row.session === session))
    if (kept.length !== rows.length) this.save(kept)
  }
}
