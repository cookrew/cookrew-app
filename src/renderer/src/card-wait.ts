import { MKT_GATE, MKT_PAY, denialCopyLenient } from '../../shared/marketplace-copy'
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
 *
 * AND NOTHING SAID HERE CLAIMS THE CARD WAS NOT CHARGED. Every sentence in
 * this module is spoken while a card page exists for the purchase. The door's
 * ordinary refusals end "nothing was charged" — written for somebody who has
 * not paid — and its "not paid" is one answer for several facts (unpaid; a
 * session already used; an amount or a buyer that did not match). So a
 * refusal keeps its own headline and gets one honest body under it: the door
 * did not confirm the payment, and what to do if the card was charged.
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
  | { ok: true; phase: ServePhase; standing?: boolean }
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

/** A refusal's own headline over the one body that is true while a card page exists. */
const unconfirmed = (title: string): PayFault => apology(title, MKT_PAY['mkt.pay.card.unconfirmed.body'])

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
      // Lenient: a sentence missing its facts must not throw inside a timer.
      // The HEADLINE only — the refusal's body is the one that says "nothing
      // was charged", which nobody here can know.
      return { fault: unconfirmed(denialCopyLenient(phase.reason, undefined, vars).title) }
    }
    case 'gone':
      return { fault: unconfirmed(MKT_GATE['mkt.gate.gone.title']) }
    default:
      // An error, a door asking who we are, a door quoting again: none of
      // them is "paid", and none of them is a reason to start a new payment.
      return { fault: unconfirmed(MKT_GATE['mkt.gate.error.title']) }
  }
}

/**
 * A SHEET OPENED ON A PAYMENT IN FLIGHT, and the door's answer to the gate is
 * a refusal. The refusal's band would say "nothing was charged" over a card
 * page that may have been paid; this is what is said instead, on the pay
 * step, with CHECK AGAIN under it. Null when the door is simply quoting (or
 * open): there is nothing to correct.
 */
export function cardHeldFault(
  phase: ServePhase,
  vars: Readonly<Record<string, string | number>>
): PayFault | null {
  if (phase.kind === 'pay' || phase.kind === 'open') return null
  // No live account session: the door cannot be asked anything until the
  // person signs in, so that is what the sentence sends them to do.
  if (phase.kind === 'identify') {
    return apology(MKT_PAY['mkt.pay.card.resume.title'], MKT_PAY['mkt.pay.card.signin.body'])
  }
  const reading = read({ ok: true, phase }, vars)
  return typeof reading === 'object' ? reading.fault : null
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
  // MAIN DECIDES WHEN THE SESSION IS OVER. It holds the payment on disk and
  // lets go only when the door says unpaid after its own clock says the page
  // can no longer be paid; `standing` is its word. This surface's clock is a
  // fallback for a main that does not say (and it only governs the wording:
  // main refuses a second Checkout while one stands, whatever is pressed).
  const held = answer.ok ? answer.standing : undefined
  const over = held === undefined ? lifeOver(wait, now) : !held
  if (!over) {
    return lifeOver(wait, now)
      ? { kind: 'ended', fault: apology(MKT_PAY['mkt.pay.card.ended.title'], MKT_PAY['mkt.pay.card.ended.body']) }
      : { kind: 'waiting', fault: null }
  }
  return {
    kind: 'expired',
    fault: apology(MKT_PAY['mkt.pay.card.expired.title'], MKT_PAY['mkt.pay.card.expired.body'])
  }
}
