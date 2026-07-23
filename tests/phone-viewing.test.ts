import { describe, expect, it } from 'vitest'
import {
  PHONE_VIEW_TTL_MS,
  activeViewers,
  isViewed,
  markViewed,
  pruneViewers
} from '../src/shared/phone-viewing'

// A phone polling GET /api/browser/:id/thumb is the "this browser is being
// viewed" heartbeat. The tracker keeps capture alive for TTL past the last
// poll so a couple of missed polls don't blank the phone.

describe('markViewed', () => {
  it('records the id at `now`, immutably (new object, input untouched)', () => {
    const s0 = {}
    const s1 = markViewed(s0, 'b1', 1000)
    expect(s0).toEqual({})
    expect(s1).toEqual({ b1: 1000 })
    expect(s1).not.toBe(s0)
  })
  it('refreshes an existing id to the newer timestamp', () => {
    const s1 = markViewed({ b1: 1000, b2: 500 }, 'b1', 4000)
    expect(s1).toEqual({ b1: 4000, b2: 500 })
  })
})

describe('isViewed', () => {
  it('true within the TTL, false once it lapses, false if never seen', () => {
    const s = markViewed({}, 'b1', 1000)
    expect(isViewed(s, 'b1', 1000 + PHONE_VIEW_TTL_MS - 1)).toBe(true)
    expect(isViewed(s, 'b1', 1000 + PHONE_VIEW_TTL_MS)).toBe(false)
    expect(isViewed(s, 'unknown', 1000)).toBe(false)
  })
  it('honors a custom ttl', () => {
    const s = markViewed({}, 'b1', 0)
    expect(isViewed(s, 'b1', 1500, 2000)).toBe(true)
    expect(isViewed(s, 'b1', 2500, 2000)).toBe(false)
  })
})

describe('activeViewers', () => {
  it('returns only ids still within the TTL', () => {
    const s = { fresh: 9000, stale: 100 }
    expect(activeViewers(s, 10000, 2000)).toEqual(['fresh'])
  })
  it('empty when all lapsed', () => {
    expect(activeViewers({ a: 0, b: 10 }, 100000, 2000)).toEqual([])
  })
})

describe('pruneViewers', () => {
  it('drops lapsed ids, keeps fresh, immutably', () => {
    const s0 = { fresh: 9000, stale: 100 }
    const s1 = pruneViewers(s0, 10000, 2000)
    expect(s1).toEqual({ fresh: 9000 })
    expect(s0).toEqual({ fresh: 9000, stale: 100 })
    expect(s1).not.toBe(s0)
  })
  it('returns an equal-shaped object when nothing is stale', () => {
    expect(pruneViewers({ a: 9000 }, 9500, 2000)).toEqual({ a: 9000 })
  })
})
