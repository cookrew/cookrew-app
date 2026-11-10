import { SEAT_DENIAL, type GateDoor, type WalkPricing } from '../../shared/gate-walk'
import { MKT_PAY } from '../../shared/marketplace-copy'
import type { ServeFacePreview, ServeRail } from './api'
import type { PayFault } from './GateSheet'

/**
 * THE IMPORT GATE's decisions, pure — so a test can hold them without a DOM.
 *
 * ImportGate.tsx is effects and callbacks around three questions: what does a
 * refusal's one button DO (G2/G4: "a button that names a destination and only
 * closes the sheet" was the defect), what scene does the sheet paint from the
 * door's answer, and which facts do its sentences need. Each is answered here.
 */

/**
 * What a refusal's forward action does. Never "close the sheet", and never
 * "open a page": every one of them is a question put to the door again.
 */
export type RemedyAct =
  /** Ask the door again as a BUYER — the walk that lands on its price and rails. */
  | { kind: 'buy' }
  /** Ask the door again, now. */
  | { kind: 'retry' }

/** How long the sheet waits before asking again on its own, on a 429. */
export const BUDGET_RETRY_MS = 15 * 60 * 1000

/**
 * The dispatch, by reason (G2).
 *
 * `no_seat` is BUY, and BUY HAPPENS HERE (0.6.0). It used to open the team's
 * page at cookrew.dev in a browser card, because that page was the one place
 * a seat could be bought; the page is gone, and the purchase is this sheet's
 * own pay step. Pressing it charges nothing: the gate is asked again with the
 * intent said out loud, the door answers with its price and its rails, and
 * the person pays there or does not.
 *
 * It is offered on the INSTALL walk only. A direct door has no registry to
 * seat anybody (gate-walk.ts), so a `no_seat` from one is asked again like
 * any other refusal.
 *
 * Everything else is asked again. The refusals only the author can lift (a
 * region, a version, a seat count, a refund) were sent to that same page to
 * read about it; with no page, the honest act left is the question itself —
 * the sentence on the band has already said who can change the answer.
 */
export function remedyFor(reason: string, door: GateDoor): RemedyAct {
  return reason === SEAT_DENIAL && door === 'install' ? { kind: 'buy' } : { kind: 'retry' }
}

/**
 * A settle main REFUSED TO MAKE, as the pay step says it.
 *
 * `terms-changed` is the door's doing — it quoted something at the press that
 * the sheet never showed, and main signed nothing — so it is said in the
 * accusing voice with its own sentence. Everything else is a failure on the
 * way (no Bearer, a door that hung up), which is ours to apologise for.
 */
export function settleRefusalFault(refusal: { reason: string; detail?: string }): PayFault {
  if (refusal.reason === 'terms-changed') {
    return {
      voice: 'accuse',
      title: MKT_PAY['mkt.pay.error.changed.title'],
      body: MKT_PAY['mkt.pay.error.changed.body']
    }
  }
  return {
    voice: 'apolog',
    title: MKT_PAY['mkt.pay.error.unverifiable.title'],
    body: refusal.detail ?? MKT_PAY['mkt.pay.error.unverifiable.body']
  }
}

/** The facts main returns beside the phase, on the install walk. */
export interface GateFacts {
  door: GateDoor
  team: string | null
  owner: string | null
  account: string | null
  /** The seat that admitted this account, or null: none yet, or none needed. */
  seat: string | null
}

/**
 * The price the walk carries in. The rail the person picked is exact; before
 * the door quotes, a paid team's published price stands in so the seat and
 * pay steps read as AHEAD rather than dashed — a free team carries null and
 * both dash, honestly.
 *
 * WHO IS PAID is the owner, when the walk knows one. A listed team reaches
 * the pay step now (a seat is bought here), and main names its owner beside
 * the phase; a dialled door tells us nobody, so there the slug is the most
 * there is to say.
 */
export function walkPricing(
  face: Pick<ServeFacePreview, 'access' | 'priceUsd' | 'slug'>,
  selected: ServeRail | null,
  owner: string | null = null
): WalkPricing | null {
  const author = `@${owner ?? face.slug}`
  if (selected !== null) {
    return {
      model: 'one-time',
      terms: {
        price: selected.price,
        asset: selected.asset,
        chain: selected.chain,
        author,
        expiry: selected.expiry
      }
    }
  }
  if (face.access !== 'paid') return null
  return {
    model: 'one-time',
    terms: { price: face.priceUsd ?? '', asset: 'USD', chain: '', author, expiry: 0 }
  }
}

/**
 * Every placeholder a refusal's sentence may ask for, always present — an
 * unfilled brace throws, and a throw on a 403 is a sheet that shows nothing.
 * On the direct walk the owner and team are the face's, which is the most a
 * dialled door tells us.
 */
export function deniedVarsFor(
  face: Pick<ServeFacePreview, 'name' | 'slug' | 'priceUsd'>,
  facts: Pick<GateFacts, 'team' | 'owner' | 'account'>
): Record<string, string> {
  const team = facts.team?.split('/')[1] ?? face.slug
  const owner = facts.owner ?? face.slug
  return {
    presetName: face.name,
    author: `@${owner}`,
    handle: facts.account ?? '',
    owner,
    team,
    price: face.priceUsd === undefined ? '' : `$${face.priceUsd}`
  }
}
