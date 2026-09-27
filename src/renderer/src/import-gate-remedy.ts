import type { GateDoor, WalkPricing } from '../../shared/gate-walk'
import { teamPageUrl } from '../../shared/seats'
import type { ServeFacePreview, ServeRail } from './api'

/**
 * THE IMPORT GATE's decisions, pure — so a test can hold them without a DOM.
 *
 * ImportGate.tsx is effects and callbacks around three questions: what does a
 * refusal's one button DO (G2/G4: "a button that names a destination and only
 * closes the sheet" was the defect), what scene does the sheet paint from the
 * door's answer, and which facts do its sentences need. Each is answered here.
 */

/**
 * Where a published team's page is. The renderer has no registry setting of
 * its own — main resolves addresses — so the one public origin is named here,
 * as import-session.ts names it for main.
 */
const REGISTRY_SITE = 'https://cookrew.dev'

/** What a refusal's forward action does. Never "close the sheet". */
export type RemedyAct =
  /** Open the team's own page in a browser card — the author's surface. */
  | { kind: 'author-page'; url: string }
  /** Ask the door again, now. */
  | { kind: 'retry' }

/** How long the sheet waits before asking again on its own, on a 429. */
export const BUDGET_RETRY_MS = 15 * 60 * 1000

/**
 * The dispatch, by reason (G2). Everything the author can change — a seat,
 * their seat count, a region, a version, credit — goes to their page; the
 * refusals that pass with time are retried. `no_seat` is BUY, and BUY is the
 * team's page: cookrew.dev now mints an unseated token on an explicit
 * `intent: 'buy'` and the door admits it as far as its 402, so the page's
 * seat bar completes the purchase end to end. This sheet still sends people
 * there rather than paying in place — one purchase surface, on the author's
 * own page, until an in-app buy is worth a second one.
 */
export function remedyFor(reason: string, team: string | null): RemedyAct {
  switch (reason) {
    case 'budget':
    case 'payment_unavailable':
    case 'not_answering':
    case 'workspace':
    case 'scope':
      return { kind: 'retry' }
    default:
      return team === null
        ? { kind: 'retry' }
        : { kind: 'author-page', url: teamPageUrl(REGISTRY_SITE, team) }
  }
}

/** The facts main returns beside the phase, on the install walk. */
export interface GateFacts {
  door: GateDoor
  team: string | null
  owner: string | null
  account: string | null
}

/**
 * The price the walk carries in. The rail the person picked is exact; before
 * the door quotes, a paid team's published price stands in so the seat and
 * pay steps read as AHEAD rather than dashed — a free team carries null and
 * both dash, honestly.
 */
export function walkPricing(
  face: Pick<ServeFacePreview, 'access' | 'priceUsd' | 'slug'>,
  selected: ServeRail | null
): WalkPricing | null {
  const author = `@${face.slug}`
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
