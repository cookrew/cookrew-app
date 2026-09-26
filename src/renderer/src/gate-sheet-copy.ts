/**
 * THE GATE SHEET's words, resolved (R28).
 *
 * The rail model (shared/gate-walk.ts) says WHICH band each step paints; this
 * says WHAT it reads, entirely from the deck (shared/marketplace-copy.ts). It is
 * pure and door-aware: the install door's identify band reads account strings
 * (the one identify sentence, V3-07), the DIRECT door's reads the key sentence
 * (G3), and because a sheet is one door they can never appear together.
 *
 * A `now` step shows its prompt; a `done` step shows its collapsed receipt. That
 * distinction is the whole reason the sheet gets shorter as you succeed.
 */

import {
  MKT_AUTH,
  MKT_GATE,
  MKT_PAY,
  denialCopy,
  fillCopy,
  headlineAndWhy,
  purchaseModelLine
} from '../../shared/marketplace-copy'
import {
  CREDIT_DENIAL,
  SEAT_DENIAL,
  type GateDoor,
  type WalkPricing
} from '../../shared/gate-walk'

/** What a gate-band renders: a glyph, the headline, and its one-line why. */
export interface BandCopy {
  glyph: string
  said: string
  why: string
}

/** A refusal band also carries the single forward action's label. */
export interface DeniedCopy extends BandCopy {
  action: string
}

/** The direct sentence is one cell; the band draws it as headline and why. */
const DIRECT = headlineAndWhy(MKT_AUTH['mkt.auth.direct'])

/**
 * The identity band. `done` collapses to the receipt; otherwise it is the
 * prompt. Each door reads only its own vocabulary — the account door never
 * speaks of this Mac's key, the direct door never of an account.
 */
export function identifyBand(door: GateDoor, done: boolean): BandCopy {
  if (door === 'direct') {
    return done
      ? {
          glyph: '✓',
          said: MKT_GATE['mkt.gate.identify.direct.done'],
          why: MKT_GATE['mkt.gate.identify.direct.why']
        }
      : { glyph: '⇄', said: DIRECT.title, why: DIRECT.body }
  }
  return done
    ? {
        glyph: '✓',
        said: MKT_GATE['mkt.gate.identify.install.done'],
        why: MKT_GATE['mkt.gate.identify.install.why']
      }
    : {
        glyph: '🔑',
        said: MKT_AUTH['mkt.auth.title'],
        why: MKT_AUTH['mkt.auth.body']
      }
}

/**
 * The seat band — the registry's rung, install door only. `done` is the
 * receipt; `now` is the door's own no_seat sentence, which names the person
 * refused and the person who can say yes, with BUY as its one action (cut 1).
 */
export function seatBand(
  done: boolean,
  vars: Readonly<Record<string, string | number>> = {}
): DeniedCopy {
  if (done) {
    return {
      glyph: '✓',
      said: MKT_GATE['mkt.gate.seat.done'],
      why: MKT_GATE['mkt.gate.seat.why'],
      action: ''
    }
  }
  const { title, body, action } = denialCopy(SEAT_DENIAL, undefined, vars)
  return { glyph: '◔', said: title, why: body, action }
}

/**
 * The payment band. Both doors can reach it — a dialled paid door charges
 * too. The why is THE sentence — where the money lands and that Cookrew takes
 * none of it.
 */
export function payBand(pricing: WalkPricing): BandCopy {
  const priceLike = {
    model: pricing.model,
    amount: pricing.terms.price,
    asset: pricing.terms.asset
  }
  return {
    glyph: '◈',
    said: purchaseModelLine(priceLike),
    why: fillCopy(MKT_PAY['mkt.pay.destination'], { author: pricing.terms.author })
  }
}

/** The served band. Door decides whether it speaks of a canvas or a line. */
export function openBand(door: GateDoor): BandCopy {
  return door === 'direct'
    ? {
        glyph: '▶',
        said: MKT_GATE['mkt.gate.open.direct.title'],
        why: MKT_GATE['mkt.gate.open.direct.why']
      }
    : {
        glyph: '▶',
        said: MKT_GATE['mkt.gate.open.install.title'],
        why: MKT_GATE['mkt.gate.open.install.why']
      }
}

/**
 * A refusal band. `balance_empty` is the one the buyer can clear, so it wears
 * the amber glyph and its action tops up; every other 403 stops, in rose. The
 * words come from `denialCopy`, which already falls back for a reason no client
 * has heard of rather than printing the token.
 */
export function deniedBand(
  reason: string,
  remedy: string | undefined,
  vars: Readonly<Record<string, string | number>> = {}
): DeniedCopy {
  const { title, body, action } = denialCopy(reason, remedy, vars)
  return {
    glyph: reason === CREDIT_DENIAL ? '◔' : '✕',
    said: title,
    why: body,
    action
  }
}
