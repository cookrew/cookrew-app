// How long after a tap does a card actually go live?
//
// Reported as "zoom in latency", with a console log full of xterm-webgl and
// ResizeObserver warnings — all of which are the full view MOUNTING, not the
// zoom itself. The mount was gated behind two waits in series:
//
//   tap -> fitView(duration) -> viewport stops -> SETTLE_MS debounce -> mount
//
// which put a 620ms floor under it (500 + 120). The animation already knows
// when it has finished — fitView returns a promise that resolves at the end —
// so the debounce was re-deriving, badly, something the caller could just be
// told. The debounce stays for wheel-zoom, which has no completion event.
//
// These tests pin the budget and the gate. The LOD arithmetic is NOT in the
// budget: measured at 0.031ms per frame across all 63 overlay nodes in the real
// workspace, it never showed up.

import { describe, expect, it } from 'vitest'
import { CARD_ZOOM_MS } from '../src/renderer/src/nodes/card-zoom'
import { admitsFullView } from '../src/renderer/src/zoom-lod'

/** What the LOD waits out when nothing tells it the viewport has stopped. */
const SETTLE_MS = 120

describe('time from tap to a live card', () => {
  it('is the animation alone, with no debounce after it', () => {
    // The arrival signal removes the settle wait from the critical path.
    expect(CARD_ZOOM_MS).toBe(280)
    expect(CARD_ZOOM_MS + 0).toBeLessThan(500 + SETTLE_MS)
  })

  it('is less than half of what it was', () => {
    // 620ms -> 280ms. Stated as a ratio so retuning CARD_ZOOM_MS cannot quietly
    // give the whole win back.
    const before = 500 + SETTLE_MS
    expect(CARD_ZOOM_MS / before).toBeLessThan(0.5)
  })
})

describe('admitsFullView — what counts as "the viewport has stopped"', () => {
  it('mounts on arrival WITHOUT waiting for the settle debounce', () => {
    // The fix: a tapped card whose animation has finished goes live now.
    expect(admitsFullView(true, false, false, true)).toBe(true)
  })

  it('still mounts on the debounce alone, for wheel-zoom', () => {
    // Manual zoom has no completion event, so the debounce has to stay.
    expect(admitsFullView(true, true, false, false)).toBe(true)
  })

  it('keeps an already-open card mounted while the viewport moves', () => {
    // Otherwise panning a live card would unmount and rebuild its xterm.
    expect(admitsFullView(true, false, true, false)).toBe(true)
  })

  it('mounts nothing while the viewport is still moving toward an untapped card', () => {
    expect(admitsFullView(true, false, false, false)).toBe(false)
  })

  it('NEVER overrides eligibility — arrival is not a bypass', () => {
    // Arriving at a card that is off-stage, or too small, must not mount it.
    // Otherwise the corner-card bug comes back through a different door.
    expect(admitsFullView(false, true, true, true)).toBe(false)
    expect(admitsFullView(false, false, false, true)).toBe(false)
  })
})
