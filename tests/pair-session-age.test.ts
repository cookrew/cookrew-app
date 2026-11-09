import { describe, expect, it } from 'vitest'
import { FRESH_MS, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, freshlyVerified, sessionEnded, tokenExpiry } from '../registry/src/v2-session-age'

/** The owner's numbers (2026-11-09): idle 7 days, absolute 30, fresh 5 minutes. */
describe('session age', () => {
  const now = 1_800_000_000_000
  it('ends a session idle for seven days, or thirty days after its sign-in', () => {
    expect(sessionEnded({ signedInAt: now - 1000, lastUsedAt: now - SESSION_IDLE_MS - 1 }, now)).toBe('idle')
    expect(sessionEnded({ signedInAt: now - SESSION_ABSOLUTE_MS - 1, lastUsedAt: now }, now)).toBe('absolute')
    expect(sessionEnded({ signedInAt: now - 1000, lastUsedAt: now - 1000 }, now)).toBeNull()
    // Written before the ruling: nothing to measure yet.
    expect(sessionEnded({}, now)).toBeNull()
  })
  it('is fresh for five minutes after a verification, by the methods asked for', () => {
    expect(freshlyVerified({ verifiedAt: now - FRESH_MS + 1, verifiedBy: 'passkey' }, now)).toBe(true)
    expect(freshlyVerified({ verifiedAt: now - FRESH_MS - 1, verifiedBy: 'passkey' }, now)).toBe(false)
    expect(freshlyVerified({ verifiedAt: now, verifiedBy: 'provider' }, now, ['password', 'passkey'])).toBe(false)
    expect(freshlyVerified({}, now)).toBe(false)
  })
  it('never mints a token past the sign-in’s thirtieth day', () => {
    expect(tokenExpiry({ signedInAt: now - SESSION_ABSOLUTE_MS + 1000 }, now, SESSION_ABSOLUTE_MS)).toBe(now + 1000)
  })
})
