import type { LocalNetworkState } from '../local-network'
import type { PathAttempt } from '../path-attempts'
import { LOCAL_NETWORK_COPY } from '../path-copy'

/**
 * WHAT A RACE'S ROWS PROVE ABOUT THE LOCAL-NETWORK HINT, AS TWO QUESTIONS.
 *
 * THE INCIDENT: Chrome 152 behind a system proxy, on the owner's Mac,
 * 2026-09-08. The probe to the Mac's trusted LAN name annotated
 * `targetAddressSpace: 'local'` failed in 32 ms, the permission stayed
 * 'prompt', and no dialog was ever raised — a proxy hides the resolved address,
 * so Chrome calls the target public and Local Network Access fails a request
 * declaring 'local' before any prompt. The panel therefore offered ALLOW for
 * ever, a button with no pending permission behind it.
 *
 * Two surfaces need the same two facts out of the rows — the explainer, which
 * decides whether an ask is honest, and the direct-navigation offer, which
 * decides whether leaving the page is the only thing left — so the questions
 * live here rather than being asked twice in two different shapes. Pure over a
 * snapshot: nothing in this file reads a store or touches a browser.
 */

/**
 * SOMETHING ANSWERED, AND ONLY BECAUSE THE ANNOTATION WAS DROPPED.
 *
 * The strongest possible evidence that there is nothing left to allow: the
 * session is already talking to the Mac, and the permission that never
 * prompted is not standing in anybody's way.
 */
export const answeredWithoutHint = (attempts: readonly PathAttempt[]): boolean =>
  attempts.some((attempt) => attempt.outcome === 'answered' && attempt.hint === 'none')

/**
 * EVERY CANDIDATE REFUSED BEFORE IT CONNECTED, WITH AND WITHOUT THE ANNOTATION.
 *
 * EVERY, not some: one address that timed out is a Mac that may simply be
 * asleep, and calling that a proxy would send a reader after the wrong thing.
 * A row only carries `hint: 'none'` on a refusal when both variants were
 * actually tried (plane-race.ts · toldHint), so this cannot fire on an address
 * no browser annotates in the first place.
 */
export const blockedBothWays = (attempts: readonly PathAttempt[]): boolean =>
  attempts.length > 0 &&
  attempts.every((attempt) => attempt.outcome === 'blocked' && attempt.hint === 'none')

/**
 * EVERY CANDIDATE REFUSED BEFORE IT CONNECTED, whichever variant was tried.
 *
 * The badge's question, not the proxy's: "is the relay what we have because
 * the browser would not try, or because nothing answered?" The sentence it
 * replaces — "your Mac is not on this network" — is a claim about the Mac,
 * and a race whose every row died in the browser measured nothing about the
 * Mac at all (2026-10-04: Safari 26, 4 ms, both ways). EVERY, as above: one
 * timeout is a Mac that may be asleep, and that sentence may then be true.
 */
export const refusedBeforeConnecting = (attempts: readonly PathAttempt[]): boolean =>
  attempts.length > 0 && attempts.every((attempt) => attempt.outcome === 'blocked')

/**
 * EVERY CANDIDATE WAS A NAME THE ZONE IS NOT ANSWERING. The Mac's card said
 * the names were live and the zone said otherwise — a card that went stale
 * between two reads, or a registry that lost it. Nothing about the phone, its
 * browser or its network is the story then, and the badge says so.
 */
export const everyUnnamed = (attempts: readonly PathAttempt[]): boolean =>
  attempts.length > 0 && attempts.every((attempt) => attempt.outcome === 'unnamed')

/** What the explainer draws: an ask, the after-refusal line, or nothing. */
export interface AskRowView {
  readonly kind: 'ask' | 'denied' | 'hidden'
  readonly sentence: string
}

export interface AskRowState {
  readonly permission: LocalNetworkState
  /** True once the switcher has a trusted name to point the ask at. */
  readonly offered: boolean
  /** The rows of the LAST race, exactly as the "why this path" panel has them. */
  readonly attempts: readonly PathAttempt[]
}

const HIDDEN: AskRowView = { kind: 'hidden', sentence: '' }

/**
 * THE ROW, OR NOTHING — and 'prompt' no longer means "ask" on its own.
 *
 * The order is the argument:
 *
 *   denied                 the browser will not re-prompt; say where the switch
 *                          is instead of offering a dead button.
 *   not prompt, or nowhere granted, unsupported, or no trusted name yet.
 *   answered hint-less     THE NEW ONE. The permission will read 'prompt' for
 *                          the life of this session and there is nothing behind
 *                          it; the probe already got through the other way.
 *                          Keeping the button would be asking a reader to fix
 *                          something that is not broken.
 *   blocked both ways      still worth asking — this may be a browser nobody
 *                          has asked yet — but the sentence names the proxy,
 *                          and the direct offer puts OPEN ON WI-FI beside it
 *                          (path/direct-offer.ts).
 */
export const localNetworkAskRow = (state: AskRowState): AskRowView => {
  if (state.permission === 'denied') {
    return { kind: 'denied', sentence: LOCAL_NETWORK_COPY.denied }
  }
  if (state.permission !== 'prompt' || !state.offered) return HIDDEN
  if (answeredWithoutHint(state.attempts)) return HIDDEN
  return {
    kind: 'ask',
    sentence: blockedBothWays(state.attempts)
      ? `${LOCAL_NETWORK_COPY.ask} ${LOCAL_NETWORK_COPY.proxied}`
      : LOCAL_NETWORK_COPY.ask
  }
}
