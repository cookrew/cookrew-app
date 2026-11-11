import { describe, expect, it, vi } from 'vitest'
import { doorBearer, withPaidBearer, type DoorBearerPort } from '../src/main/door-bearer'
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

/**
 * THE GAP AFTER A PURCHASE (0.6.0). The door admits a buyer the moment the 402
 * is paid; cookrew.dev hears of the seat a round trip later. The card placed
 * in between signs in with an ordinary mint and is told no_seat — so the
 * Bearer the door itself admitted stands in, for that answer and no other.
 */
describe('withPaidBearer', () => {
  const noSeat: AdmissionPhase = { kind: 'denied', reason: 'no_seat', retryable: false }
  /** cookrew.dev itself refused the mint: the account is real and holds no seat there. */
  const registrySaidNo = { token: null, phase: noSeat, minted: 'no_seat' as const }

  it('offers the Bearer a seat was bought on when cookrew.dev still says no_seat', () => {
    expect(withPaidBearer(registrySaidNo, 'paid-bearer')).toEqual({ ...registrySaidNo, token: 'paid-bearer' })
  })

  it('offers nothing where nothing was bought', () => {
    expect(withPaidBearer(registrySaidNo, null)).toBe(registrySaidNo)
  })

  it('never stands in when it was the DOOR that refused — a 403 there is the door’s own no (L2)', () => {
    // cookrew.dev minted a token and the door turned it away. The phase reads
    // no_seat because that is what an unexplained 403 at the seat rung is
    // called, but nobody is waiting on a seat report here: the door itself
    // said no, and a Bearer it issued earlier must not answer for it.
    const doorSaidNo = { token: null, phase: noSeat, minted: 'token' as const }
    expect(withPaidBearer(doorSaidNo, 'paid-bearer')).toBe(doorSaidNo)
  })

  it('never stands in for any other refusal — no account, a dead registry, another 403', () => {
    const others: Array<{ phase: AdmissionPhase; minted: 'identify' | 'offline' | 'refused' | 'token' }> = [
      { phase: { kind: 'identify' }, minted: 'identify' },
      { phase: { kind: 'error', status: 0 }, minted: 'offline' },
      { phase: { kind: 'error', status: 404 }, minted: 'refused' },
      { phase: { kind: 'gone' }, minted: 'token' },
      { phase: { kind: 'denied', reason: 'workspace', retryable: false }, minted: 'token' },
      { phase: { kind: 'denied', reason: 'budget', retryable: false }, minted: 'token' }
    ]
    for (const other of others) {
      expect(withPaidBearer({ token: null, ...other }, 'paid-bearer').token, other.phase.kind).toBeNull()
    }
  })

  it('leaves an admitted sign-in exactly as it was', () => {
    const admitted = { token: 'account-bearer', phase: open, minted: 'token' as const }
    expect(withPaidBearer(admitted, 'paid-bearer')).toBe(admitted)
  })
})
