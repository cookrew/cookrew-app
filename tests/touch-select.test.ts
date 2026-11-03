import { describe, expect, it } from 'vitest'
import { HOLD_SLOP_PX, LONG_PRESS_MS, stillHolding } from '../src/renderer/src/touch-select'
import { sanitizeInput } from '../src/shared/cast-input'
import { streamInputAllowed } from '../src/renderer/src/browser-stream'

describe('press and hold to select', () => {
  const start = { pointerId: 7, clientX: 100, clientY: 200 }
  it('the same finger, hardly moved, is still holding', () => {
    expect(stillHolding(start, 7, 103, 204)).toBe(true)
    expect(stillHolding(start, 7, 100 + HOLD_SLOP_PX + 1, 200)).toBe(false)
    expect(stillHolding(start, 8, 100, 200)).toBe(false)
    expect(stillHolding(null, 7, 100, 200)).toBe(false)
  })
  it('turns into a selection before Chrome’s own 500 ms long press', () => {
    expect(LONG_PRESS_MS).toBeLessThan(500)
  })
})

describe('touchcancel on the wire', () => {
  const ctx = { displayScale: 1, viewportWidth: 400, viewportHeight: 800 }
  it('withdraws the touch with no points (no tap, no click)', () => {
    expect(sanitizeInput({ t: 'touchcancel' }, ctx)).toEqual([
      { method: 'Input.dispatchTouchEvent', params: { type: 'touchCancel', touchPoints: [] } }
    ])
  })
  it('like a release, it may cross a hold but never a revision boundary', () => {
    const opts = { live: false, agentHeld: true, transitioning: false, frameRevision: 2, viewportRevision: 2 }
    expect(streamInputAllowed({ t: 'touchcancel' }, opts)).toBe(true)
    expect(streamInputAllowed({ t: 'touchcancel' }, { ...opts, viewportRevision: 3 })).toBe(false)
  })
})
