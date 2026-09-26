import { describe, expect, it } from 'vitest'
import {
  EXPIRY_WARNING_MS,
  RENEW_AHEAD_MS,
  expiryWarningDue,
  renewDue,
  renewMessage
} from '../src/shared/session-renew'
import { renewMessage as registryRenewMessage } from '../registry/src/v2-renew'

/**
 * THE FACT THIS EXISTS FOR (v3, V3-17). A session lives thirty days, and
 * before V3-16 that meant every door this Mac serves went down on the
 * thirtieth unless a person was at the keyboard to retype a password.
 */

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const at = (days: number): { exp: number } => ({ exp: NOW + days * DAY })

describe('the message both sides sign', () => {
  it('is byte for byte the registry’s — two spellings would be a silent 401', () => {
    // The lockstep rule relay-seal keeps, applied here: the app signs it and
    // the registry rebuilds it, so a drift is a refusal nobody can read.
    expect(renewMessage('drej', 'dev-1', 'n0nce')).toBe(registryRenewMessage('drej', 'dev-1', 'n0nce'))
    expect(renewMessage('drej', 'dev-1', 'n0nce')).toBe('cookrew-renew/1 drej dev-1 n0nce')
  })
})

describe('renewDue', () => {
  it('waits while the month is young', () => {
    expect(renewDue(at(29), NOW)).toBe(false)
    expect(renewDue(at(8), NOW)).toBe(false)
  })

  it('renews from a week out, so six failed days still leave a day of warning', () => {
    expect(renewDue(at(7), NOW)).toBe(true)
    expect(renewDue({ exp: NOW + RENEW_AHEAD_MS }, NOW)).toBe(true)
    expect(renewDue(at(1), NOW)).toBe(true)
  })

  it('will not renew a session the REGISTRY ended — that is what "not me" does', () => {
    // Renewing it would let the very key somebody was cutting off mint a
    // fresh month for itself.
    expect(renewDue({ exp: NOW + DAY, endedAt: NOW - 60_000 }, NOW)).toBe(false)
  })

  it('will not renew one that has already expired, or none at all', () => {
    expect(renewDue(at(-1), NOW)).toBe(false)
    expect(renewDue({ exp: NOW }, NOW)).toBe(false)
    expect(renewDue(null, NOW)).toBe(false)
  })
})

describe('expiryWarningDue', () => {
  it('says nothing while renewal is working, however close the date', () => {
    expect(expiryWarningDue(at(1), NOW, false)).toBe(false)
  })

  it('warns inside two days once renewal is actually failing', () => {
    expect(expiryWarningDue(at(1), NOW, true)).toBe(true)
    expect(expiryWarningDue({ exp: NOW + EXPIRY_WARNING_MS }, NOW, true)).toBe(true)
  })

  it('holds its tongue while there is still a week of renewals to try', () => {
    expect(expiryWarningDue(at(5), NOW, true)).toBe(false)
  })

  it('does not warn about a thing that has already happened', () => {
    // The doors are already down by then, and the app has a better sentence.
    expect(expiryWarningDue(at(-1), NOW, true)).toBe(false)
    expect(expiryWarningDue({ exp: NOW + DAY, endedAt: NOW }, NOW, true)).toBe(false)
  })
})
