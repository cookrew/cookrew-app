import { describe, expect, it } from 'vitest'
import {
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  canCapture,
  initialBackoff,
  recordFailure,
  recordSuccess
} from '../src/renderer/src/capture-backoff'

describe('capture backoff', () => {
  it('allows captures in the initial state', () => {
    expect(canCapture(initialBackoff, 0)).toBe(true)
    expect(canCapture(initialBackoff, 999_999)).toBe(true)
  })

  it('blocks for 10s after the first failure', () => {
    const s = recordFailure(initialBackoff, 1000)
    expect(canCapture(s, 1000)).toBe(false)
    expect(canCapture(s, 1000 + INITIAL_BACKOFF_MS - 1)).toBe(false)
    expect(canCapture(s, 1000 + INITIAL_BACKOFF_MS)).toBe(true)
  })

  it('doubles the delay on each consecutive failure', () => {
    const s1 = recordFailure(initialBackoff, 0)
    expect(s1.notBefore).toBe(10_000)
    const s2 = recordFailure(s1, 0)
    expect(s2.notBefore).toBe(20_000)
    const s3 = recordFailure(s2, 0)
    expect(s3.notBefore).toBe(40_000)
  })

  it('caps the delay at 5 minutes', () => {
    const capped = Array.from({ length: 12 }).reduce<ReturnType<typeof recordFailure>>(
      (s) => recordFailure(s, 0),
      initialBackoff
    )
    expect(capped.notBefore).toBe(MAX_BACKOFF_MS)
    expect(MAX_BACKOFF_MS).toBe(5 * 60_000)
  })

  it('resets fully on success', () => {
    const failed = recordFailure(recordFailure(initialBackoff, 0), 0)
    const reset = recordSuccess()
    expect(reset).toEqual(initialBackoff)
    expect(canCapture(reset, 0)).toBe(true)
    expect(recordFailure(reset, 0).notBefore).toBe(INITIAL_BACKOFF_MS)
    expect(failed.failures).toBe(2)
  })

  it('never mutates prior states', () => {
    const s1 = recordFailure(initialBackoff, 0)
    recordFailure(s1, 0)
    expect(s1).toEqual({ failures: 1, notBefore: 10_000 })
    expect(initialBackoff).toEqual({ failures: 0, notBefore: 0 })
  })
})
