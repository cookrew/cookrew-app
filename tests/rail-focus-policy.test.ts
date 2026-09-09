// THE RAIL'S ROW ACTIONS MUST BE REACHABLE WITH ONE FINGER (D2, canvas QA
// 2026-09-07, dev 91c7314).
//
// ROLE / FORK / ⟲ REWIND live inside a fan row, and the fan existed only while
// `scrubbing` was true — i.e. only while a pointer was held down on the rail.
// So the gesture was: hold the rail with one finger, and press the action with
// a second one that a phone does not have. QA measured the two failures:
//
//   2-CHECKPOINT CARD. A tap on the rail left focus null. The transcript is
//   shorter than one screen, so it never scrolls, so scroll-derived focus never
//   leaves the live tail. There was no way to open the fan at all.
//
//   1,055-CHECKPOINT LIVE CARD. A scrub focused T556; focus was null again
//   within 2.2s of the lift, because the agent's own output re-scrolled the
//   transcript to the tail and took the focus back.
//
// The policy below is the arithmetic of the repair, kept pure so the dwell is
// asserted to the millisecond instead of to a device.

import { describe, expect, it } from 'vitest'
import {
  FOCUS_DWELL_MS,
  focusPinned,
  initialFocusState,
  nextFocus,
  type FocusState
} from '../src/renderer/src/stream/focus-policy'

const T = (index: number, frac = index / 10): { index: number; frac: number } => ({ index, frac })

/** Wall clock at the start of each scenario — every event carries its own. */
const T0 = 1_757_000_000_000

const tap = (state: FocusState, index: number, at: number): FocusState =>
  nextFocus(state, { kind: 'tap', focus: T(index), at })
const scroll = (state: FocusState, index: number | null, at: number): FocusState =>
  nextFocus(state, { kind: 'scroll', focus: index === null ? null : T(index), at })

describe('a tap pins the focus for the dwell', () => {
  it('selects the tapped checkpoint', () => {
    const after = tap(initialFocusState, 12, T0)
    expect(after.focus).toEqual(T(12))
    expect(after.selection).toEqual(T(12))
  })

  it('is pinned for exactly FOCUS_DWELL_MS and not a millisecond more', () => {
    const after = tap(initialFocusState, 12, T0)
    expect(focusPinned(after, T0)).toBe(true)
    expect(focusPinned(after, T0 + FOCUS_DWELL_MS - 1)).toBe(true)
    expect(focusPinned(after, T0 + FOCUS_DWELL_MS)).toBe(false)
  })

  it('a second tap re-pins on the new checkpoint, restarting the dwell', () => {
    const first = tap(initialFocusState, 12, T0)
    const second = tap(first, 40, T0 + 3000)
    expect(second.focus).toEqual(T(40))
    expect(focusPinned(second, T0 + FOCUS_DWELL_MS + 1000)).toBe(true)
  })

  it('a tap that resolves to no checkpoint changes nothing', () => {
    const state = tap(initialFocusState, 12, T0)
    expect(nextFocus(state, { kind: 'tap', focus: null, at: T0 + 10 })).toBe(state)
  })
})

describe('a live scroll during the dwell does NOT steal the focus', () => {
  // The 1,055-checkpoint card, to the measured timing: the agent's output
  // re-scrolled the transcript to the tail 2.2s after the lift.
  it('the agent scrolling to the tail leaves the pick alone', () => {
    const picked = tap(initialFocusState, 556, T0)
    const during = scroll(picked, null, T0 + 2200)
    expect(during).toBe(picked)
    expect(during.focus).toEqual(T(556))
  })

  it('a scroll to some OTHER checkpoint is refused too — it is still not the user', () => {
    const picked = tap(initialFocusState, 556, T0)
    expect(scroll(picked, 1055, T0 + 500).focus).toEqual(T(556))
  })

  it('and the refusal is repeated for the whole window, not just the first event', () => {
    let state = tap(initialFocusState, 556, T0)
    for (let ms = 100; ms < FOCUS_DWELL_MS; ms += 400) state = scroll(state, null, T0 + ms)
    expect(state.focus).toEqual(T(556))
  })
})

describe('a scroll AFTER the dwell takes the focus back', () => {
  it('the transcript resumes ownership once the window closes', () => {
    const picked = tap(initialFocusState, 556, T0)
    const after = scroll(picked, 900, T0 + FOCUS_DWELL_MS + 1)
    expect(after.focus).toEqual(T(900))
    expect(after.selection).toBeNull()
    expect(focusPinned(after, T0 + FOCUS_DWELL_MS + 1)).toBe(false)
  })

  it('a card that HAS scrolled goes back to the live tail, focus and all', () => {
    let state = tap(initialFocusState, 556, T0)
    state = scroll(state, 900, T0 + FOCUS_DWELL_MS + 1) // a real scroll happened
    state = scroll(state, null, T0 + FOCUS_DWELL_MS + 2000)
    expect(state.focus).toBeNull()
    expect(state.selection).toBeNull()
  })
})

describe('a short transcript falls back to the selection, never to null', () => {
  // The 2-checkpoint card. Its transcript is shorter than the viewport, so it
  // never scrolls and the only scroll focus it can ever report is the tail.
  it('the pick survives the tail report even after the dwell has expired', () => {
    const picked = tap(initialFocusState, 2, T0)
    const later = scroll(picked, null, T0 + FOCUS_DWELL_MS + 5000)
    expect(later.focus).toEqual(T(2))
    expect(later.selection).toEqual(T(2))
  })

  it('and keeps surviving, so the actions stay reachable while the user reads them', () => {
    let state = tap(initialFocusState, 2, T0)
    for (let ms = 0; ms < 60_000; ms += 1000) state = scroll(state, null, T0 + ms)
    expect(state.focus).toEqual(T(2))
  })

  it('but the moment the card CAN scroll, the transcript wins again', () => {
    let state = tap(initialFocusState, 2, T0)
    // The agent replies, the transcript grows past a screen, a scroll focuses.
    state = scroll(state, 5, T0 + FOCUS_DWELL_MS + 1)
    expect(state.scrolled).toBe(true)
    state = scroll(state, null, T0 + FOCUS_DWELL_MS + 2)
    expect(state.focus).toBeNull()
  })

  it('with no pick at all, a tail report is still just the tail', () => {
    expect(scroll(initialFocusState, null, T0).focus).toBeNull()
  })

  // The trap the fallback opens if "has it scrolled" is only recorded on the
  // events that WIN: a long live card whose scrub reported T556 and whose agent
  // then ran the transcript back to the tail would look short at expiry, and its
  // tag would be stranded on T556 for the rest of the session.
  it('a LONG card that reported a checkpoint mid-dwell is never mistaken for a short one', () => {
    let state = tap(initialFocusState, 556, T0)
    state = scroll(state, 556, T0 + 50) // the seek arrives, refused but SEEN
    expect(state.scrolled).toBe(true)
    state = scroll(state, null, T0 + 2200) // the agent's output, back to the tail
    state = scroll(state, null, T0 + FOCUS_DWELL_MS + 1)
    expect(state.focus).toBeNull()
  })
})

describe('a scrub pins on release, so the lift is not the end of the gesture', () => {
  it('the dwell is measured from the LIFT, not from the last pointermove', () => {
    let state = nextFocus(initialFocusState, { kind: 'scrub', focus: T(556), at: T0 })
    state = nextFocus(state, { kind: 'release', at: T0 + 3000 })
    // 3s of dragging must not come out of the window for pressing an action.
    expect(focusPinned(state, T0 + 3000 + FOCUS_DWELL_MS - 1)).toBe(true)
  })

  it('a paused drag cannot be stolen either — each move re-arms', () => {
    let state = nextFocus(initialFocusState, { kind: 'scrub', focus: T(556), at: T0 })
    state = scroll(state, null, T0 + 100)
    expect(state.focus).toEqual(T(556))
  })

  it('releasing with nothing focused stays nothing', () => {
    expect(nextFocus(initialFocusState, { kind: 'release', at: T0 })).toBe(initialFocusState)
  })
})

describe('tapping LIVE is the way out, and it is always obeyed', () => {
  it('clears the pick even mid-dwell and even on a short card', () => {
    const picked = tap(initialFocusState, 2, T0)
    const live = nextFocus(picked, { kind: 'live', at: T0 + 10 })
    expect(live.focus).toBeNull()
    expect(live.selection).toBeNull()
    expect(focusPinned(live, T0 + 10)).toBe(false)
  })
})

describe('the reducer is stable and immutable', () => {
  it('returns the SAME object when nothing moved, so React does not re-render', () => {
    const state = tap(initialFocusState, 12, T0)
    expect(scroll(state, null, T0 + 1)).toBe(state)
    expect(nextFocus(state, { kind: 'tap', focus: T(12), at: T0 })).toBe(state)
  })

  it('never mutates the state it was handed', () => {
    const before = tap(initialFocusState, 12, T0)
    const snapshot = JSON.stringify(before)
    scroll(before, 40, T0 + FOCUS_DWELL_MS + 1)
    nextFocus(before, { kind: 'live', at: T0 })
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})
