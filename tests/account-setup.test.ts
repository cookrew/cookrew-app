import { describe, expect, it } from 'vitest'
import {
  availabilityArrived,
  availabilityNote,
  canCreate,
  failedWith,
  initialSetup,
  mintedAs,
  shouldCheck,
  submitting,
  typeHandle
} from '../src/renderer/src/account-setup'
import {
  accountBridge,
  asAvailability,
  asMintResult,
  asStatus
} from '../src/renderer/src/owner-account'

describe('the setup sheet, as a value', () => {
  it('starts on the suggestion, unchecked', () => {
    const state = initialSetup('Drej.Smith')
    // The suggestion arrives already folded into a handle by the main process;
    // whatever reaches the field is normalised here too rather than trusted.
    expect(state.handle).toBe('drej.smith')
    expect(state.availability).toBe('idle')
    expect(canCreate(state)).toBe(false)
  })

  it('marks a well-shaped name as checking and a malformed one as invalid', () => {
    expect(typeHandle(initialSetup(), '@Mira ').availability).toBe('checking')
    expect(typeHandle(initialSetup(), '-nope-').availability).toBe('invalid')
    expect(typeHandle(initialSetup(), '').availability).toBe('idle')
    expect(shouldCheck(typeHandle(initialSetup(), 'mira'))).toBe(true)
    expect(shouldCheck(typeHandle(initialSetup(), '-nope-'))).toBe(false)
  })

  it('DROPS the old answer on every keystroke', () => {
    const free = availabilityArrived(typeHandle(initialSetup(), 'mira'), 'mira', 'free')
    expect(canCreate(free)).toBe(true)
    // One more character and the field must stop claiming anything.
    const next = typeHandle(free, 'miraa')
    expect(next.availability).toBe('checking')
    expect(canCreate(next)).toBe(false)
  })

  it('ignores a late answer about a name that is no longer typed', () => {
    const typing = typeHandle(initialSetup(), 'miraa')
    // The reply for 'mira' lands after the person typed another letter.
    const after = availabilityArrived(typing, 'mira', 'taken')
    expect(after).toBe(typing)
    expect(after.availability).toBe('checking')
  })

  it('only offers Create for a name the registry said is free', () => {
    const typed = typeHandle(initialSetup(), 'mira')
    for (const answer of ['checking', 'taken', 'invalid', 'unknown', 'idle'] as const) {
      expect(canCreate(availabilityArrived(typed, 'mira', answer))).toBe(false)
    }
    expect(canCreate(availabilityArrived(typed, 'mira', 'free'))).toBe(true)
    // And never while a mint is in flight — one press, one name.
    expect(canCreate(submitting(availabilityArrived(typed, 'mira', 'free')))).toBe(false)
  })

  it('a taken refusal moves the FIELD, not only the message', () => {
    const ready = availabilityArrived(typeHandle(initialSetup(), 'mira'), 'mira', 'free')
    const refused = failedWith(submitting(ready), '@mira is already taken', 'handle-taken')
    expect(refused.availability).toBe('taken')
    expect(refused.busy).toBe(false)
    expect(canCreate(refused)).toBe(false)
    expect(availabilityNote(refused)).toBe('@mira is already taken')
  })

  it('finishes on a mint and stays finished', () => {
    const done = mintedAs(submitting(typeHandle(initialSetup(), 'mira')), '@Mira')
    expect(done.minted).toBe('mira')
    expect(done.busy).toBe(false)
    expect(canCreate(done)).toBe(false)
  })

  it('says something true in every state — never a blank reassurance', () => {
    const typed = typeHandle(initialSetup(), 'mira')
    const notes = (['idle', 'checking', 'free', 'taken', 'invalid', 'unknown'] as const).map(
      (a) => availabilityNote(availabilityArrived(typed, 'mira', a))
    )
    for (const note of notes) expect(note.length).toBeGreaterThan(10)
    // An unreachable registry is its own sentence, not "available".
    expect(availabilityNote(availabilityArrived(typed, 'mira', 'unknown'))).toContain(
      'did not answer'
    )
    expect(availabilityNote(availabilityArrived(typed, 'mira', 'taken'))).toContain('taken')
  })
})

describe('the renderer bridge — feature-detected, never assumed', () => {
  const full = {
    accountStatus: async () => ({
      handle: 'mira',
      registry: 'https://cookrew.dev',
      suggestion: 'drej',
      envHandle: null
    }),
    accountCheck: async () => ({ availability: 'free' }),
    accountMint: async () => ({ ok: true, handle: 'mira' })
  }

  it('is null on a transport that does not carry the account', () => {
    // The phone companion and a browser card reach remote-api / demo-api,
    // which carry none of these — so the first-run sheet never renders there.
    expect(accountBridge({})).toBeNull()
    expect(accountBridge({ accountStatus: full.accountStatus })).toBeNull()
    expect(accountBridge(full)).not.toBeNull()
  })

  it('reads the status, defaulting a missing handle to no account', () => {
    expect(asStatus({ handle: 'mira', registry: 'r', suggestion: 's', envHandle: 'x' })).toEqual({
      handle: 'mira',
      registry: 'r',
      suggestion: 's',
      envHandle: 'x'
    })
    expect(asStatus({ handle: '' }).handle).toBeNull()
    expect(asStatus(undefined)).toEqual({
      handle: null,
      registry: '',
      suggestion: '',
      envHandle: null
    })
  })

  it('reads an unrecognisable availability as UNKNOWN, never free', () => {
    expect(asAvailability({ availability: 'free' })).toBe('free')
    expect(asAvailability({ availability: 'taken' })).toBe('taken')
    expect(asAvailability({ availability: 'yes' })).toBe('unknown')
    expect(asAvailability(null)).toBe('unknown')
    expect(asAvailability({ ok: false, reason: 'not_owner' })).toBe('unknown')
  })

  it('reads a refusal as a refusal with a sentence, whatever shape it took', () => {
    expect(asMintResult({ ok: true, handle: 'mira' })).toEqual({ ok: true, handle: 'mira' })
    expect(asMintResult({ ok: false, reason: '@mira is taken', kind: 'handle-taken' })).toEqual({
      ok: false,
      reason: '@mira is taken',
      kind: 'handle-taken'
    })
    // The owner-window guard answers `{ ok: false, reason: 'not_owner' }` —
    // a refusal, and it must not be read as a success with no handle.
    expect(asMintResult({ ok: false, reason: 'not_owner' }).ok).toBe(false)
    const bare = asMintResult({})
    expect(bare.ok).toBe(false)
    expect(bare.ok === false && bare.reason.length > 10).toBe(true)
  })
})
