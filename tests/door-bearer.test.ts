import { describe, expect, it, vi } from 'vitest'
import { doorBearer, type DoorBearerPort } from '../src/main/door-bearer'
import type { AdmissionPhase, ServeTargetRef } from '../src/main/served-admission'

/**
 * THE BUG THIS PINS (v3, G1). After V3-04 the import walk signs in as the
 * ACCOUNT at a listed door, but the card's transcript reads and its END kept
 * using the per-door caller KEY — so one door heard two callers for one card:
 * the rail read a session the card never opened, and END ended that one while
 * the account's stayed up on the owner's lending budget.
 */

const target: ServeTargetRef = { origin: 'https://cookrew.dev', slug: 'alpha' }
const open: AdmissionPhase = { kind: 'open' }

const port = (over: Partial<DoorBearerPort> = {}): DoorBearerPort => ({
  admit: vi.fn(async () => ({ token: 'account-bearer', phase: open })),
  withKey: vi.fn(async () => 'key-bearer'),
  ...over
})

describe('doorBearer', () => {
  it('a LISTED door is asked as the account, and the key is never reached for', async () => {
    const deps = port()
    await expect(doorBearer(deps, target, '@mira/alpha')).resolves.toBe('account-bearer')
    expect(deps.admit).toHaveBeenCalledWith(target, '@mira/alpha')
    expect(deps.withKey).not.toHaveBeenCalled()
  })

  it('an UNLISTED door keeps the key — it has nothing else to verify', async () => {
    const deps = port()
    await expect(doorBearer(deps, target, null)).resolves.toBe('key-bearer')
    expect(deps.withKey).toHaveBeenCalledWith(target)
    expect(deps.admit).not.toHaveBeenCalled()
  })

  it('a listed door that will not admit the account THROWS, never falls back to the key', async () => {
    // The fallback is the bug: a card that quietly becomes somebody else is
    // worse than a card that says it could not be read.
    const deps = port({
      admit: vi.fn(async () => ({ token: null, phase: { kind: 'denied', reason: 'no_seat', retryable: false } as AdmissionPhase }))
    })
    await expect(doorBearer(deps, target, '@mira/alpha')).rejects.toThrow('did not admit this account (denied)')
    expect(deps.withKey).not.toHaveBeenCalled()
  })

  it('names the phase so a failed read says which of the three refusals it was', async () => {
    for (const kind of ['identify', 'error'] as const) {
      const deps = port({ admit: vi.fn(async () => ({ token: null, phase: { kind, status: 0 } as AdmissionPhase })) })
      await expect(doorBearer(deps, target, '@mira/alpha')).rejects.toThrow(`(${kind})`)
    }
  })
})
