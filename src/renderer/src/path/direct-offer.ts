import { tokenParam } from '../auth-gate'
import { familyName } from '../browser-family'
import type { DataPlaneKind } from '../data-plane'
import type { LocalNetworkState } from '../local-network'
import type { PathAttempt } from '../path-attempts'
import { attemptName } from './plane-race'
import type { PlaneCandidate } from './plane-switch'

/**
 * THE ONE NAVIGATION A RELAYED COMPANION IS STILL ALLOWED TO MAKE.
 *
 * Everything else in this directory exists to keep the phone on cookrew.dev.
 * plane-switch.ts moves the DATA PLANE precisely so the address bar never
 * changes, and companion-relay-no-jump.test.ts pins that as a rule, because
 * "we stopped navigating" is exactly the kind of thing a refactor re-enables
 * by accident and the last time it fired the owner's phone landed on a
 * certificate warning holding a pairing token.
 *
 * WHY THERE IS AN EXCEPTION AT ALL. Measured on the owner's iPhone on
 * 2026-09-08 and confirmed by Apple's forums: iOS Safari never asks for the
 * Local Network permission and is not listed under Settings → Privacy → Local
 * Network. There is no dialog to raise, no site setting to change, and nothing
 * a reader can do. The Mac's own /api/path/reports has the whole diagnosis in
 * one row — `Safari 26 · permission unsupported · 192.168.2.40 timeout
 * 1585 ms` — and every probe on that phone ends the same way. A page served
 * from https://cookrew.dev simply cannot fetch a LAN address in that browser.
 *
 * A TOP-LEVEL NAVIGATION IS NOT A SUBRESOURCE FETCH, and it works: the owner
 * loaded the Mac's trusted name directly in Safari and it opened, because the
 * name has a publicly trusted certificate (reach-names.ts) and typing an
 * address is not something the local-network privacy rules gate. So on iOS
 * Safari the direct path exists — it is just not reachable from a fetch.
 *
 * THE EXCEPTION IS NARROW BY CONSTRUCTION. This module answers one question
 * and does not act on it: it is a pure function over a snapshot, and the only
 * thing that may call `location.assign` is the click handler behind the button
 * it feeds (DirectOfferRow.tsx). No timer, no race, no boot path reaches it,
 * which is why every automatic gate in companion-relay-no-jump.test.ts still
 * holds unchanged.
 */

/** Where the button would send this phone, and what to call that network. */
export interface DirectOffer {
  /** A trusted name off the desktop's card — never a bare IP, never a label. */
  readonly origin: string
  readonly kind: PlaneCandidate['kind']
  /**
   * `Safari`, `Chrome`, or `This browser` — the SUBJECT of the sentence, and
   * the reason it is on the offer rather than read again at render time: the
   * words and the decision have to be about the same browser, and the panel
   * has no business asking `navigator` a second question.
   */
  readonly family: string
}

/**
 * Everything the decision needs, as facts rather than stores.
 *
 * `hasToken` RATHER THAN THE TOKEN. The credential decides whether there is an
 * offer at all — a navigation without one lands on the Not paired card at an
 * address the reader has never seen — but nothing here needs to read it, so
 * nothing here can spill it into a return value, a log line or an attempt row.
 * It is fetched once, at the click, by the code that builds the URL.
 */
export interface DirectOfferState {
  /** `clientBase()`: '' at the root, `/relay/@user/desktop/<id>` under a relay. */
  readonly base: string
  readonly plane: DataPlaneKind
  /** `currentBrowser()` — a family and a major version, never a full UA. */
  readonly browser: string
  /** `onAppleMobile()` — one bit about the PLATFORM, which is the real guard. */
  readonly ios: boolean
  readonly permission: LocalNetworkState
  /** The rows of the LAST race, exactly as the "why this path" panel has them. */
  readonly attempts: readonly PathAttempt[]
  /** The trusted names this desktop currently publishes, LAN before tailnet. */
  readonly candidates: readonly PlaneCandidate[]
  readonly hasToken: boolean
}

/**
 * THE TWO WAYS A PROBE DIES WHEN THE BROWSER SIMPLY WILL NOT CARRY IT.
 *
 * A timeout is the shape iOS Safari produces — the request is made, nothing
 * comes back, the deadline fires — and 'blocked' is the shape a browser
 * produces when it refuses before connecting. Both mean "this address was
 * never spoken to", which is the only kind of failure a navigation can fix.
 *
 * Everything else is excluded on purpose. 'network' is a certificate or a DNS
 * answer and a navigation would land on the same browser error; 'http' and
 * 'unverified' mean something DID answer and was not this Mac, which is the
 * one case where sending a reader there with a token would be dangerous.
 */
const STALLED: ReadonlySet<PathAttempt['outcome']> = new Set(['timeout', 'blocked'])

/**
 * THE PLATFORM WITH NO PERMISSION TO GRANT — or Safari, wherever it runs.
 *
 * The first cut of this asked "is it Safari", and the owner reproduced the
 * identical failure the next day in Chrome 152 on the same iPhone: "Chrome 152
 * · local network permission not supported · 192.168.2.40 timed out 1557 ms".
 * Every browser on iOS and iPadOS is WebKit by App Store rule, so the brand
 * was never the fact — the platform was.
 *
 * SAFARI STAYS IN AS A SECOND ARM, not as the rule. It covers macOS Safari
 * (harmless: the offer is only made when a probe has already stalled) and, by
 * the same clause, an iPad in desktop mode, which sends a Macintosh user agent
 * and cannot be told from a Mac without fingerprinting for it.
 *
 * DESKTOP CHROME AND FIREFOX ARE OUT, deliberately. They have a real
 * permission or can be told about one, and a navigation offered there would
 * train readers away from the control that actually fixes their session.
 */
const hasNoPermissionToGive = (browser: string, ios: boolean): boolean =>
  ios || browser === 'Safari' || browser.startsWith('Safari ')

/** LAN first, then tailnet, each keeping the order the desktop listed them in. */
const bestFirst = (candidates: readonly PlaneCandidate[]): readonly PlaneCandidate[] => [
  ...candidates.filter((candidate) => candidate.kind === 'lan'),
  ...candidates.filter((candidate) => candidate.kind === 'tailnet')
]

/**
 * THE OFFER, or null — and null is the answer in every case but one.
 *
 * The guards are ordered cheapest first and each one is a separate reason:
 *
 *   under a relay base    at the root the page already IS the Mac
 *   still on the relay    a direct plane needs no rescuing
 *   iOS/iPadOS, or Safari every browser there is WebKit and none of them has a
 *                         permission; a desktop Chrome's prompt is the fix
 *   'unsupported'         a browser that CAN be asked must be asked instead
 *   a stored token        or the landing page is a pairing screen
 *   something stalled     and nothing answered — an answer means the ordinary
 *                         switch is already handling this and a navigation
 *                         would be a page reload for nothing
 */
export const directNavigationOffer = (state: DirectOfferState): DirectOffer | null => {
  if (state.base.length === 0) return null
  if (state.plane !== 'relay') return null
  if (!hasNoPermissionToGive(state.browser, state.ios)) return null
  if (state.permission !== 'unsupported') return null
  if (!state.hasToken) return null
  if (state.attempts.some((attempt) => attempt.outcome === 'answered')) return null
  const stalled = new Set(
    state.attempts.filter((attempt) => STALLED.has(attempt.outcome)).map((attempt) => attempt.name)
  )
  if (stalled.size === 0) return null
  // NAME THE CANDIDATE THE EVIDENCE IS ABOUT. Rows outlive a network, and a
  // card can list an address this phone never tried; matching them by the
  // address the row already spells keeps the button pointing at a machine we
  // have a measurement for.
  const best = bestFirst(state.candidates).find((candidate) =>
    stalled.has(attemptName(candidate.origin))
  )
  return best
    ? { origin: best.origin, kind: best.kind, family: familyName(state.browser) }
    : null
}

/**
 * THE URL THE BUTTON OPENS, built at the click and nowhere else.
 *
 * `tokenParam` is the same helper the two EventSource call sites use, so the
 * credential is spelled exactly one way in this client. It goes in the query
 * rather than the fragment because the far end is the Mac's own server and
 * `?token=` is the form it has always accepted — and because the landing boot
 * takes it straight back off the address bar (auth-gate.ts ·
 * `scrubPairingFromUrl`), so it survives one request and no screenshot.
 *
 * `from=relay` is how the landed page knows to say one line about where it
 * came from. It is scrubbed by the same boot, for the same reason: a note that
 * reappeared on every reload would be a banner.
 *
 * NULL WITHOUT A TOKEN. An unpaired navigation is a certificate the reader has
 * never seen wrapped around a Not paired card; refusing to build the URL at
 * all is the only honest answer, and it means the offer and the URL cannot
 * disagree about whether there is a credential.
 */
export const directNavigationUrl = (
  offer: { readonly origin: string },
  token: string | null
): string | null => (token ? `${tokenParam(`${offer.origin}/`, token)}&from=relay` : null)
