import { MKT_GATE, MKT_PAY, denialCopy, unknownDenialCopy } from '../../shared/marketplace-copy'
import { CHECKOUT_MAX_LIFE_SECONDS } from '../../shared/stripe-checkout'
import type { ServePhase } from './api'
import type { PayFault } from './GateSheet'
import { settleRefusalFault } from './import-gate-remedy'

/**
 * WAITING ON A CARD — the decisions, pure, so a test holds them with no clock
 * and no DOM (ImportGate.tsx is the timer around them).
 *
 * The sheet opens Stripe's hosted page and then asks the door, every few
 * seconds, whether that Checkout session has been paid. Three things used to
 * be wrong with how it waited, and each one could cost a person money:
 *
 *   IT GAVE UP EARLY. Five minutes, against a page that takes a card for up
 *   to an hour. Whoever paid in minute six had paid for a sheet that had
 *   stopped listening.
 *
 *   IT GAVE UP SILENTLY, with PAY live again. A second PAY inside the door's
 *   quote window replays the same session; across it, Stripe is asked for a
 *   NEW one — a second page that takes a second payment.
 *
 *   IT IGNORED EVERYTHING BUT "OPEN". A door that ran out of sessions, went
 *   away or lost its Bearer answered every poll and was never heard.
 *
 * So: the wait lasts the session's whole life; when it ends it says so and
 * offers CHECK AGAIN, which asks about THE SAME session and never starts
 * another; and a fresh PAY exists only after the door has said that session
 * is unpaid once its life is over.
 */

/** How often the door is asked. */
export const CARD_POLL_MS = 3000

/** How long a session can still take money, from the moment it was made. */
export const CARD_SESSION_LIFE_MS = CHECKOUT_MAX_LIFE_SECONDS * 1000

/** One card payment being waited on. */
export interface CardWait {
  /** The Checkout session id — the only thing ever settled for this wait. */
  session: string
  /** Epoch ms the door handed the session out. */
  startedAt: number
}

/** What `serveSettle` answers. */
export type SettleAnswer =
  | { ok: true; phase: ServePhase }
  | { ok: false; reason: string; detail?: string }

export type CardStep =
  /** Paid, and the door admitted us. */
  | { kind: 'open' }
  /** Not paid yet and the page can still be paid. `fault` is something worth saying meanwhile. */
  | { kind: 'waiting'; fault: PayFault | null }
  /** The session's life is over and nothing landed: say so, offer CHECK AGAIN. */
  | { kind: 'ended'; fault: PayFault }
  /** A refusal that is not about the payment: say it, offer CHECK AGAIN. */
  | { kind: 'stopped'; fault: PayFault }
  /** The door says unpaid and the session can no longer be paid: a new payment is safe. */
  | { kind: 'expired'; fault: PayFault }

const apology = (title: string, body: string): PayFault => ({ voice: 'apolog', title, body })

const UNCHECKABLE = apology(
  MKT_PAY['mkt.pay.error.unverifiable.title'],
  MKT_PAY['mkt.pay.error.unverifiable.body']
)

const lifeOver = (wait: CardWait, now: number): boolean => now - wait.startedAt >= CARD_SESSION_LIFE_MS

/** What the door's answer means for the PAYMENT, before time is considered. */
type Reading = 'open' | 'unpaid' | 'uncheckable' | { fault: PayFault }

function read(answer: SettleAnswer, vars: Readonly<Record<string, string | number>>): Reading {
  if (!answer.ok) return { fault: settleRefusalFault(answer) }
  const { phase } = answer
  switch (phase.kind) {
    case 'open':
      return 'open'
    case 'denied': {
      // The door asks Stripe about the session every time we look. "Not paid"
      // is the ordinary answer until the person finishes on Stripe's page.
      if (phase.reason === 'payment_invalid') return 'unpaid'
      if (phase.reason === 'payment_unverifiable') return 'uncheckable'
      let copy: { title: string; body: string }
      try {
        copy = denialCopy(phase.reason, undefined, vars)
      } catch {
        // A sentence missing its facts must not throw inside a timer.
        copy = unknownDenialCopy(undefined)
      }
      return { fault: apology(copy.title, copy.body) }
    }
    case 'gone':
      return { fault: apology(MKT_GATE['mkt.gate.gone.title'], MKT_GATE['mkt.gate.gone.why']) }
    default:
      // An error, a door asking who we are, a door quoting again: none of
      // them is "paid", and none of them is a reason to start a new payment.
      return { fault: apology(MKT_GATE['mkt.gate.error.title'], MKT_GATE['mkt.gate.error.why']) }
  }
}

/** One look at the door while the sheet is waiting by itself. */
export function cardPollStep(
  answer: SettleAnswer,
  wait: CardWait,
  now: number,
  vars: Readonly<Record<string, string | number>>
): CardStep {
  const reading = read(answer, vars)
  if (reading === 'open') return { kind: 'open' }
  if (typeof reading === 'object') return { kind: 'stopped', fault: reading.fault }
  if (lifeOver(wait, now)) {
    return {
      kind: 'ended',
      fault: apology(MKT_PAY['mkt.pay.card.ended.title'], MKT_PAY['mkt.pay.card.ended.body'])
    }
  }
  return { kind: 'waiting', fault: reading === 'uncheckable' ? UNCHECKABLE : null }
}

/** CHECK AGAIN: one press, one question about the same session. */
export function cardCheckStep(
  answer: SettleAnswer,
  wait: CardWait,
  now: number,
  vars: Readonly<Record<string, string | number>>
): CardStep {
  const reading = read(answer, vars)
  if (reading === 'open') return { kind: 'open' }
  if (typeof reading === 'object') return { kind: 'stopped', fault: reading.fault }
  // "We could not check" is a maybe, and a maybe never frees a new payment.
  if (reading === 'uncheckable') return { kind: 'stopped', fault: UNCHECKABLE }
  if (!lifeOver(wait, now)) return { kind: 'waiting', fault: null }
  return {
    kind: 'expired',
    fault: apology(MKT_PAY['mkt.pay.card.expired.title'], MKT_PAY['mkt.pay.card.expired.body'])
  }
}
