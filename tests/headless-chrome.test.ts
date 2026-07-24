import { describe, expect, it } from 'vitest'
import { STATIC_FRAME_HEARTBEAT_MS, shouldEmitFrame } from '../src/main/headless-chrome'

describe('headless static-frame liveness', () => {
  it('deduplicates rapid repeats but emits a heartbeat before the UI stale window', () => {
    expect(shouldEmitFrame('same', 'same', 100, 0)).toBe(true)
    expect(shouldEmitFrame('same', 'same', STATIC_FRAME_HEARTBEAT_MS, 1)).toBe(false)
    expect(shouldEmitFrame('same', 'same', STATIC_FRAME_HEARTBEAT_MS + 1, 1)).toBe(true)
  })

  it('always emits changed frames', () => {
    expect(shouldEmitFrame('next', 'previous', 2, 1)).toBe(true)
  })
})
