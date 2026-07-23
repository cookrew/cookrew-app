import { describe, expect, it } from 'vitest'
import { initialBackoff, recordFailure, shouldCapture } from '../src/renderer/src/capture-backoff'

// The capture gate: a hidden/occluded desktop window normally pauses capture
// (GPU protection), but a browser a PHONE has open must keep capturing so
// /thumb stays fresh. The GPU-health backoff still gates in every case.

describe('shouldCapture', () => {
  const ok = initialBackoff
  it('captures when the window is visible and healthy', () => {
    expect(shouldCapture({ documentHidden: false, phoneViewing: false, backoff: ok, now: 0 })).toBe(true)
  })
  it('pauses when hidden and no phone is viewing (GPU protection)', () => {
    expect(shouldCapture({ documentHidden: true, phoneViewing: false, backoff: ok, now: 0 })).toBe(false)
  })
  it('KEEPS capturing when hidden but a phone is viewing (the fix)', () => {
    expect(shouldCapture({ documentHidden: true, phoneViewing: true, backoff: ok, now: 0 })).toBe(true)
  })
  it('still respects the GPU-health backoff even for a phone-viewed browser', () => {
    const blocked = recordFailure(initialBackoff, 0) // notBefore = 10_000
    expect(shouldCapture({ documentHidden: true, phoneViewing: true, backoff: blocked, now: 5_000 })).toBe(false)
    expect(shouldCapture({ documentHidden: true, phoneViewing: true, backoff: blocked, now: 10_000 })).toBe(true)
  })
  it('backoff also gates the visible path', () => {
    const blocked = recordFailure(initialBackoff, 0)
    expect(shouldCapture({ documentHidden: false, phoneViewing: false, backoff: blocked, now: 1_000 })).toBe(false)
  })
})
