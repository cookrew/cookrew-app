import { describe, expect, it } from 'vitest'
import {
  LEAD_PATIENCE_MS,
  flingStep,
  flingVelocity,
  leadAnswered,
  leadFrame,
  leadMoved,
  leadOffset,
  pinchLeadScale,
  startLead,
  viewPerCss
} from '../src/renderer/src/scroll-lead'

const k = 1 // one view pixel per CSS pixel

describe('the picture follows the finger before the Mac answers', () => {
  it('moves by what the finger did, with no frame back yet', () => {
    const lead = leadMoved(startLead({ scrollY: 500, at: 0 }), -120, 10)
    expect(leadOffset(lead, k, 10)).toBe(-120)
  })

  it('takes back exactly what the page has since scrolled', () => {
    let lead = leadMoved(startLead({ scrollY: 500, at: 0 }), -120, 10)
    lead = leadFrame(lead, 590, 50)
    expect(leadOffset(lead, k, 50)).toBe(-30)
    lead = leadFrame(lead, 620, 90)
    expect(leadOffset(lead, k, 90) === 0).toBe(true)
  })

  it('never overshoots when the page runs ahead of the finger', () => {
    let lead = leadMoved(startLead({ scrollY: 500, at: 0 }), -100, 10)
    lead = leadFrame(lead, 700, 50)
    expect(leadOffset(lead, k, 50) === 0).toBe(true)
  })

  it('stops at the top of the page: there is nothing above it to show', () => {
    const lead = leadMoved(startLead({ scrollY: 40, at: 0 }), 300, 10)
    expect(leadOffset(lead, k, 10)).toBe(40)
  })

  it('scales by the view: a CSS pixel may be several view pixels', () => {
    expect(viewPerCss(195, 390, 1)).toBe(0.5)
    expect(viewPerCss(390, 390, 0.5)).toBe(0.5)
    const lead = leadFrame(leadMoved(startLead({ scrollY: 500, at: 0 }), -100, 10), 600, 50)
    expect(leadOffset(lead, 0.5, 50)).toBe(-50)
  })

  it('lets go when the page will not scroll: the bottom, a map, an inner list', () => {
    const lead = leadMoved(startLead({ scrollY: 500, at: 0 }), -100, 10)
    expect(leadOffset(lead, k, LEAD_PATIENCE_MS)).toBe(-100)
    expect(leadOffset(lead, k, LEAD_PATIENCE_MS + 20) === 0).toBe(true)
  })

  it('a page that is moving keeps the patience fresh', () => {
    let lead = leadMoved(startLead({ scrollY: 500, at: 0 }), -400, 10)
    lead = leadFrame(lead, 520, LEAD_PATIENCE_MS)
    expect(leadOffset(lead, k, LEAD_PATIENCE_MS + 100)).toBe(-380)
  })

  it('knows whether the page has really moved', () => {
    const lead = leadMoved(startLead({ scrollY: 500, at: 0 }), -100, 10)
    expect(leadAnswered(lead)).toBe(false)
    expect(leadAnswered(leadFrame(lead, 520, 50))).toBe(true)
  })

  it('does nothing for a page that does not say where it is', () => {
    const lead = leadMoved(startLead({ scrollY: null, at: 0 }), -100, 10)
    expect(leadOffset(lead, k, 10) === 0).toBe(true)
  })
})

describe('two fingers, shown before they land', () => {
  it('scales by what the fingers asked and the page has not yet done', () => {
    expect(pinchLeadScale(2, 1, 1)).toBe(2)
    expect(pinchLeadScale(2, 1, 1.5)).toBeCloseTo(1.333, 2)
    expect(pinchLeadScale(2, 1, 2)).toBe(1)
  })

  it('is held to a sane range, and a page that reports no scale gets none', () => {
    expect(pinchLeadScale(40, 1, 1)).toBe(4)
    expect(pinchLeadScale(0.01, 1, 1)).toBe(0.25)
    expect(pinchLeadScale(2, null, 1)).toBe(1)
  })
})

describe('a flick keeps going after the finger lifts', () => {
  it('reads the speed from the last moments of the swipe, in view pixels per ms', () => {
    const v = flingVelocity([
      { y: 300, at: 0 },
      { y: 280, at: 500 },
      { y: 200, at: 520 },
      { y: 100, at: 560 }
    ])
    expect(v).toBeCloseTo(-3, 0)
  })

  it('is no flick when the finger stopped before lifting, or barely moved', () => {
    expect(flingVelocity([{ y: 300, at: 0 }, { y: 100, at: 40 }, { y: 100, at: 400 }])).toBe(0)
    expect(flingVelocity([{ y: 300, at: 0 }])).toBe(0)
    expect(flingVelocity([{ y: 300, at: 0 }, { y: 299, at: 40 }])).toBe(0)
  })

  it('slows down and stops, and never reverses', () => {
    let v = -3
    let travelled = 0
    let steps = 0
    for (;;) {
      const step = flingStep(v, 16)
      if (step === null) break
      expect(step.delta).toBeLessThanOrEqual(0)
      travelled += step.delta
      v = step.velocity
      steps += 1
      expect(steps).toBeLessThan(500)
    }
    expect(travelled).toBeLessThan(-200)
    expect(Math.abs(v)).toBeLessThan(0.1)
  })
})
