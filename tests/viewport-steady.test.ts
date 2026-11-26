// A phone's viewport ask holds still (owner's Android phone, 2026-11-26): the
// same card's live view flipped between 768x1586, 768x1580 and 522x1074 as it
// moved between hosts, and every flip resized the headless page, restarted the
// H.264 encoder and froze the view for a minute and a half. The ask's width is
// the page's own layout width; its height moves only on a real change; and
// nothing is asked while the box is mid-zoom.

import { describe, expect, it } from 'vitest'
import {
  ASK_HEIGHT_SLACK_PX,
  ASK_HEIGHT_SLACK_SHARE,
  ASK_HOLD_MAX_MS,
  ASK_TRANSFORM_SLACK_PX,
  EMPTY_STEADY,
  askMode,
  readBox,
  stepAsk,
  type BoxReading,
  type SteadyState
} from '../src/renderer/src/viewport-steady'

/** A box at rest: what it lays out at is what it paints at. */
function rest(box: { w: number; h: number }, pageWidth = 412): BoxReading {
  return {
    box: { width: box.w, height: box.h },
    layout: { width: box.w, height: box.h },
    painted: { width: box.w, height: box.h },
    pageWidth
  }
}

/** The same box under a CSS scale (a zoom on its way in). */
function scaled(box: { w: number; h: number }, s: number, pageWidth = 412): BoxReading {
  return { ...rest(box, pageWidth), painted: { width: box.w * s, height: box.h * s } }
}

/** Feed readings one after another; returns every ask that was sent. */
function run(readings: readonly BoxReading[], mode = askMode('remote', true), start = 0): { sent: { width: number; height: number }[]; state: SteadyState } {
  let state = EMPTY_STEADY
  const sent: { width: number; height: number }[] = []
  readings.forEach((reading, i) => {
    const step = stepAsk(state, reading, mode, start + i * 10)
    state = step.state
    if (step.decision.kind === 'send') sent.push(step.decision.ask)
  })
  return { sent, state }
}

describe('who gets a steady ask', () => {
  it('a phone (remote, touch) does', () => {
    expect(askMode('remote', true)).toBe('steady')
  })

  it('the desktop app, the demo and a remote viewer with a mouse keep the box', () => {
    expect(askMode('desktop', false)).toBe('box')
    expect(askMode('desktop', true)).toBe('box')
    expect(askMode('demo', true)).toBe('box')
    expect(askMode('remote', false)).toBe('box')
  })
})

describe('the width is the page’s, not the box’s', () => {
  it('asks the same width from a full-width half panel and a padded full view', () => {
    // Terminal lower half: the whole width. Item full view: 8 px each side.
    const { sent } = run([rest({ w: 412, h: 380 }), rest({ w: 396, h: 760 })])
    expect(sent.map((a) => a.width)).toEqual([412, 412])
  })

  it('asks nothing new when only the box’s width moved', () => {
    const { sent } = run([rest({ w: 412, h: 760 }), rest({ w: 396, h: 760 }), rest({ w: 404, h: 760 })])
    expect(sent).toEqual([{ width: 412, height: 760 }])
  })

  it('rounds a fractional page width', () => {
    const { sent } = run([rest({ w: 400, h: 700 }, 411.4)])
    expect(sent[0].width).toBe(411)
  })

  it('falls back to the box when the page has no width to give', () => {
    const { sent } = run([rest({ w: 396, h: 700 }, 0)])
    expect(sent[0].width).toBe(396)
  })

  it('asks again when the phone turns (the page’s width changed)', () => {
    const { sent } = run([rest({ w: 412, h: 760 }, 412), rest({ w: 915, h: 340 }, 915)])
    expect(sent).toEqual([
      { width: 412, height: 760 },
      { width: 915, height: 340 }
    ])
  })

  it('asks a turn even when the height barely moved', () => {
    const { sent } = run([rest({ w: 412, h: 500 }, 412), rest({ w: 600, h: 505 }, 600)])
    expect(sent).toEqual([
      { width: 412, height: 500 },
      { width: 600, height: 505 }
    ])
  })
})

describe('the owner’s phone, 2026-11-26: the hosts it flipped between', () => {
  it('384x793, 384x790 and 261x537 (CSS px) make one ask, at the page’s width and the box’s shape', () => {
    const { sent } = run([rest({ w: 384, h: 793 }, 384), rest({ w: 384, h: 790 }, 384), rest({ w: 261, h: 537 }, 384), rest({ w: 384, h: 793 }, 384)])
    expect(sent).toEqual([{ width: 384, height: 793 }])
  })

  it('a tall narrow box on a wide page keeps its shape under the Mac’s height cap', () => {
    // A landscape tablet (1180 wide): 320x760 at the page's width would be 1180x2803, which the Mac cuts to 2048 high.
    const { sent } = run([rest({ w: 320, h: 760 }, 1180)])
    expect(sent).toEqual([{ width: 862, height: 2048 }])
  })

  it('a narrow host alone asks the page’s width at its own shape, so the picture fills it', () => {
    const { sent } = run([rest({ w: 261, h: 537 }, 384)])
    expect(sent).toEqual([{ width: 384, height: 790 }])
  })
})

describe('the height moves only on a real change', () => {
  it('sends the first ask', () => {
    const { sent } = run([rest({ w: 412, h: 793 })])
    expect(sent).toEqual([{ width: 412, height: 793 }])
  })

  it('keeps the ask through an address bar and sub-pixel rounding', () => {
    const { sent } = run([rest({ w: 412, h: 793 }), rest({ w: 412, h: 790 }), rest({ w: 412, h: 793.4 }), rest({ w: 412, h: 793 - (ASK_HEIGHT_SLACK_PX - 1) })])
    expect(sent).toEqual([{ width: 412, height: 793 }])
  })

  it('measures the slack from the last SENT ask, so a creep does not add up unseen', () => {
    // 15 px at a time: each step is small, the third is 45 px from what was sent (slack at 700: 35).
    const { sent } = run([rest({ w: 412, h: 700 }), rest({ w: 412, h: 715 }), rest({ w: 412, h: 730 }), rest({ w: 412, h: 745 })])
    expect(sent).toEqual([
      { width: 412, height: 700 },
      { width: 412, height: 745 }
    ])
  })

  it('sends a half panel to full view change once', () => {
    // The padded full view (396 wide) asked at the page's width keeps its shape: 760 x 412/396 = 791.
    const { sent } = run([rest({ w: 412, h: 380 }), rest({ w: 396, h: 760 }), rest({ w: 396, h: 760 })])
    expect(sent).toEqual([
      { width: 412, height: 380 },
      { width: 412, height: 791 }
    ])
  })

  it('sends a change of exactly the slack', () => {
    const slack = Math.max(ASK_HEIGHT_SLACK_PX, 700 * ASK_HEIGHT_SLACK_SHARE)
    expect(run([rest({ w: 412, h: 700 }), rest({ w: 412, h: 700 + slack })]).sent).toHaveLength(2)
    expect(run([rest({ w: 412, h: 700 }), rest({ w: 412, h: 700 + slack - 1 })]).sent).toHaveLength(1)
    // On a short box the floor holds: 5% of 300 is 15, under ASK_HEIGHT_SLACK_PX.
    expect(run([rest({ w: 412, h: 300 }), rest({ w: 412, h: 300 + ASK_HEIGHT_SLACK_PX - 1 })]).sent).toHaveLength(1)
  })

  it('asks nothing for a box not measured yet', () => {
    const { sent, state } = run([rest({ w: 0, h: 0 }), rest({ w: 412, h: 0 })])
    expect(sent).toEqual([])
    expect(state.sent).toBeNull()
  })
})

describe('nothing is asked while the box is mid-zoom', () => {
  it('holds an ask from a box painted at a CSS scale', () => {
    const step = stepAsk(EMPTY_STEADY, scaled({ w: 396, h: 760 }, 0.6), 'steady', 0)
    expect(step.decision.kind).toBe('hold')
    expect(step.state.sent).toBeNull()
  })

  it('lets it go once the box paints at its own size', () => {
    const { sent } = run([scaled({ w: 396, h: 760 }, 0.4), scaled({ w: 396, h: 760 }, 0.8), rest({ w: 396, h: 760 })])
    expect(sent).toEqual([{ width: 412, height: 791 }])
  })

  it('holds a big height change made mid-zoom, and sends only the settled one', () => {
    const first = run([rest({ w: 412, h: 380 })])
    let state = first.state
    const decisions = [scaled({ w: 396, h: 600 }, 0.5), scaled({ w: 396, h: 700 }, 0.9), rest({ w: 396, h: 760 })].map((reading, i) => {
      const step = stepAsk(state, reading, 'steady', 100 + i * 16)
      state = step.state
      return step.decision
    })
    expect(decisions.map((d) => d.kind)).toEqual(['hold', 'hold', 'send'])
    expect(decisions[2]).toEqual({ kind: 'send', ask: { width: 412, height: 791 } })
  })

  it('ignores a difference within a few px (borders, rounding)', () => {
    const reading = { ...rest({ w: 396, h: 760 }), painted: { width: 396 + ASK_TRANSFORM_SLACK_PX, height: 760 - ASK_TRANSFORM_SLACK_PX } }
    expect(stepAsk(EMPTY_STEADY, reading, 'steady', 0).decision.kind).toBe('send')
  })

  it('gives up holding a box that stays scaled (a card shown at a stop’s size), so the view still opens', () => {
    const held = stepAsk(EMPTY_STEADY, scaled({ w: 396, h: 760 }, 0.5), 'steady', 1000)
    expect(held.decision.kind).toBe('hold')
    const still = stepAsk(held.state, scaled({ w: 396, h: 760 }, 0.5), 'steady', 1000 + ASK_HOLD_MAX_MS - 1)
    expect(still.decision.kind).toBe('hold')
    const sent = stepAsk(still.state, scaled({ w: 396, h: 760 }, 0.5), 'steady', 1000 + ASK_HOLD_MAX_MS)
    expect(sent.decision).toEqual({ kind: 'send', ask: { width: 412, height: 791 } })
    // Settled into its scale: later changes go without another wait.
    const later = stepAsk(sent.state, scaled({ w: 396, h: 400 }, 0.5), 'steady', 1000 + ASK_HOLD_MAX_MS + 50)
    expect(later.decision.kind).toBe('send')
  })

  it('starts the hold over after the box has been at rest', () => {
    const a = stepAsk(EMPTY_STEADY, scaled({ w: 396, h: 760 }, 0.5), 'steady', 0)
    const b = stepAsk(a.state, rest({ w: 396, h: 760 }), 'steady', 100)
    expect(b.state.heldSince).toBeNull()
    const c = stepAsk(b.state, scaled({ w: 396, h: 400 }, 0.5), 'steady', ASK_HOLD_MAX_MS + 10)
    expect(c.decision.kind).toBe('hold')
  })

  it('does not change the state it was given', () => {
    const state: SteadyState = Object.freeze({ sent: Object.freeze({ width: 412, height: 700 }), heldSince: null })
    expect(() => stepAsk(state, scaled({ w: 396, h: 300 }, 0.5), 'steady', 0)).not.toThrow()
    expect(state).toEqual({ sent: { width: 412, height: 700 }, heldSince: null })
  })
})

describe('the desktop keeps asking its box, as before', () => {
  it('sends every change of the box, however small, at the box’s own width', () => {
    const { sent } = run([rest({ w: 640, h: 480 }, 1440), rest({ w: 640, h: 481 }, 1440), rest({ w: 600.4, h: 481 }, 1440)], 'box')
    expect(sent).toEqual([
      { width: 640, height: 480 },
      { width: 640, height: 481 },
      { width: 600, height: 481 }
    ])
  })

  it('never holds, scaled or not (the canvas zooms its cards)', () => {
    const step = stepAsk(EMPTY_STEADY, scaled({ w: 640, h: 480 }, 0.3), 'box', 0)
    expect(step.decision).toEqual({ kind: 'send', ask: { width: 640, height: 480 } })
  })

  it('keeps an unchanged box', () => {
    const { sent } = run([rest({ w: 640, h: 480 }), rest({ w: 640, h: 480 })], 'box')
    expect(sent).toHaveLength(1)
  })
})

describe('reading the box', () => {
  it('takes layout from offset sizes, paint from the bounding rect, and the page from the root', () => {
    const el = { offsetWidth: 396, offsetHeight: 760, getBoundingClientRect: () => ({ width: 198, height: 380 }) }
    const doc = { documentElement: { clientWidth: 412 } }
    expect(readBox(el, { w: 396, h: 758 }, doc, { innerWidth: 420 })).toEqual({
      box: { width: 396, height: 758 },
      layout: { width: 396, height: 760 },
      painted: { width: 198, height: 380 },
      pageWidth: 412
    })
  })

  it('uses the window’s width where the root reports none', () => {
    const el = { offsetWidth: 396, offsetHeight: 760, getBoundingClientRect: () => ({ width: 396, height: 760 }) }
    expect(readBox(el, { w: 396, h: 760 }, { documentElement: { clientWidth: 0 } }, { innerWidth: 420 }).pageWidth).toBe(420)
  })
})
