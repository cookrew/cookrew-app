/**
 * THE GATE SHEET's words, resolved (R28).
 *
 * The rail model (shared/gate-walk.ts) says WHICH band each step paints; this
 * says WHAT it reads, entirely from the deck (shared/marketplace-copy.ts). It is
 * pure and door-aware, and the R31 wall lives in the door split: the install
 * door's identify band reads account strings, the call door's reads ceremony
 * strings, and because a sheet is one door they can never appear together.
 *
 * A `now` step shows its prompt; a `done` step shows its collapsed receipt. That
 * distinction is the whole reason the sheet gets shorter as you succeed.
 */

import {
  MKT_AUTH,
  MKT_ENROL,
  MKT_GATE,
  MKT_PAY,
  denialCopy,
  fillCopy,
  purchaseModelLine
} from '../../shared/marketplace-copy'
import { CREDIT_DENIAL, type GateDoor, type WalkPricing } from '../../shared/gate-walk'

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

/**
 * The identity band. `done` collapses to the receipt; otherwise it is the
 * prompt. Each door reads only its own vocabulary — the account door never
 * shows the ceremony, the ceremony never shows the account.
 */
export function identifyBand(door: GateDoor, done: boolean): BandCopy {
  if (door === 'call') {
    return done
      ? {
          glyph: '✓',
          said: MKT_GATE['mkt.gate.identify.call.done'],
          why: MKT_GATE['mkt.gate.identify.call.why']
        }
      : {
          glyph: '🔑',
          said: MKT_ENROL['mkt.enrol.title'],
          why: MKT_ENROL['mkt.enrol.channel']
        }
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
        why: MKT_AUTH['mkt.auth.method']
      }
}

/**
 * The payment band. Only the install door ever reaches it. The why is THE
 * sentence — where the money lands and that Cookrew takes none of it.
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
  return door === 'call'
    ? {
        glyph: '▶',
        said: MKT_GATE['mkt.gate.open.call.title'],
        why: MKT_GATE['mkt.gate.open.call.why']
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
