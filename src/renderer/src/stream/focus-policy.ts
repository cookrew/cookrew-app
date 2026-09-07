/**
 * WHO OWNS THE RAIL'S FOCUS — the user, or the transcript.
 *
 * D2, canvas QA 2026-09-07 (dev 91c7314): the rail's row actions (ROLE / FORK /
 * ⟲ REWIND) could not be reached by real input.
 *
 *   On a 2-checkpoint card a tap on the rail left focus null. The transcript is
 *   shorter than one screen, so it never scrolls, so the scroll-derived focus
 *   never leaves the live tail — and the fan and its actions only exist while
 *   a focus does.
 *
 *   On a 1,055-checkpoint LIVE card a scrub focused T556 and focus was back to
 *   null within 2.2s of the lift, because the agent's own output re-scrolled
 *   the transcript to the tail. With one pointer there is no way to hold the
 *   scrub and press a row: the finger that would press is the finger holding
 *   the fan open.
 *
 * Both are the same bug — focus was DERIVED from the transcript's scroll and
 * from nothing else, so the transcript could always take it back, including
 * from a user who had just set it deliberately. This module is the small state
 * machine that decides between them:
 *
 *   A TAP OR A SCRUB PINS. For FOCUS_DWELL_MS after the pointer lifts, the
 *   focus the user chose is theirs; a scroll — the agent's or anyone's —
 *   cannot overrule it. That dwell is the window in which the second tap (on
 *   ROLE, FORK, REWIND) happens.
 *
 *   A SHORT TRANSCRIPT FALLS BACK TO THE SELECTION. A card whose transcript
 *   has never produced a scroll focus is exactly the 2-checkpoint case: there
 *   is no scroll position to prefer, so the user's pick stands instead of null.
 *   The moment a real scroll does arrive, the transcript takes over again.
 *
 * Pure and total: no clocks, no timers, no DOM. Every time comes in on the
 * event, so the dwell is testable to the millisecond.
 */

/** How long a deliberately chosen checkpoint stays the rail's focus after the
 *  pointer lifts. Long enough to read the three actions and press one, short
 *  enough that a rail left alone returns to following the transcript. */
export const FOCUS_DWELL_MS = 8000

export interface RailFocus {
  readonly index: number
  readonly frac: number
}

export interface FocusState {
  /** What the rail draws. The fan, the focus tag and its actions mount for a
   *  non-null value and for nothing else. */
  readonly focus: RailFocus | null
  /** The user's own last pick. Outlives a live scroll on a short transcript. */
  readonly selection: RailFocus | null
  /** Epoch ms up to which a scroll may not overrule the pick. */
  readonly pinnedUntil: number
  /** Has the transcript EVER produced a scroll focus? False means "shorter
   *  than the viewport" — the card that can never focus by scrolling. */
  readonly scrolled: boolean
}

export const initialFocusState: FocusState = {
  focus: null,
  selection: null,
  pinnedUntil: 0,
  scrolled: false
}

export type FocusEvent =
  /** A press on the rail that did NOT travel: select the nearest checkpoint. */
  | { readonly kind: 'tap'; readonly focus: RailFocus | null; readonly at: number }
  /** A scrub in progress — the pointer is driving the focus directly. */
  | { readonly kind: 'scrub'; readonly focus: RailFocus | null; readonly at: number }
  /** The scrub's pointer lifted: the dwell starts HERE, not at the last move. */
  | { readonly kind: 'release'; readonly at: number }
  /** The transcript reports the identity in view — null at the live tail. */
  | { readonly kind: 'scroll'; readonly focus: RailFocus | null; readonly at: number }
  /** The user asked for the tail explicitly (tapped LIVE). Always obeyed. */
  | { readonly kind: 'live'; readonly at: number }

/** Is the current focus the user's, right now? Drives both the fan staying
 *  mounted and the focus tag showing its actions without a 1500ms hold. */
export function focusPinned(state: FocusState, at: number): boolean {
  return state.focus !== null && state.pinnedUntil > at
}

function sameFocus(a: RailFocus | null, b: RailFocus | null): boolean {
  if (a === null || b === null) return a === b
  return a.index === b.index && a.frac === b.frac
}

/** Return the ORIGINAL state when nothing moved, so a caller can set it back
 *  into React without provoking a render (and without an effect loop). */
function settle(previous: FocusState, next: FocusState): FocusState {
  const unchanged =
    sameFocus(previous.focus, next.focus) &&
    sameFocus(previous.selection, next.selection) &&
    previous.pinnedUntil === next.pinnedUntil &&
    previous.scrolled === next.scrolled
  return unchanged ? previous : next
}

/** A user pick: it is the focus, it is the selection, and it is pinned. */
function pick(state: FocusState, focus: RailFocus, at: number): FocusState {
  return { focus, selection: focus, pinnedUntil: at + FOCUS_DWELL_MS, scrolled: state.scrolled }
}

/** The transcript is driving again — nothing of the user's pick survives. */
function transcriptDriving(focus: RailFocus | null, scrolled: boolean): FocusState {
  return { focus, selection: null, pinnedUntil: 0, scrolled }
}

export function nextFocus(state: FocusState, event: FocusEvent): FocusState {
  switch (event.kind) {
    case 'tap':
    case 'scrub':
      // A scrub re-arms on every move, so a PAUSED drag cannot be stolen from
      // under the thumb either.
      return settle(
        state,
        event.focus === null ? state : pick(state, event.focus, event.at)
      )
    case 'release':
      // The dwell restarts from the LIFT. On a live card the last pointermove
      // may be a second old already, and that second comes out of the window
      // the user has to reach an action in.
      return settle(
        state,
        state.focus === null
          ? state
          : { ...state, selection: state.focus, pinnedUntil: event.at + FOCUS_DWELL_MS }
      )
    case 'scroll':
      return settle(state, afterScroll(state, event.focus, event.at))
    case 'live':
      return settle(state, transcriptDriving(null, state.scrolled))
  }
}

/** The transcript reporting where it is — the only event that may be REFUSED. */
function afterScroll(state: FocusState, focus: RailFocus | null, at: number): FocusState {
  // OBSERVED EVEN WHEN REFUSED. `scrolled` is a fact about the CARD — can this
  // transcript produce a focus at all — not about who currently owns one. Left
  // out of the refused branch, a long live card that reported its checkpoint
  // during the dwell and then ran back to the tail would still look "short" at
  // expiry, and the fallback below would strand its tag on the pick forever.
  const observed = focus !== null && !state.scrolled ? { ...state, scrolled: true } : state
  // A live scroll must not steal a focus the user just set. This is the whole
  // fix for the 1,055-checkpoint card, where the agent's own output re-scrolled
  // the transcript to the tail 2.2s after the lift.
  if (focusPinned(observed, at)) return observed
  if (focus !== null) return transcriptDriving(focus, true)
  // The transcript is at the live tail. On a card that has NEVER scrolled the
  // tail is the only position it has, so it is not evidence of anything and the
  // user's pick stands (the 2-checkpoint card).
  if (observed.selection !== null && !observed.scrolled) {
    return { ...observed, focus: observed.selection }
  }
  return transcriptDriving(null, observed.scrolled)
}
