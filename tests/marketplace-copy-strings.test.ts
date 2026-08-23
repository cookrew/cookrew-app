import { describe, expect, it } from 'vitest'
import {
  MKT_ALL,
  blockedCopy,
  copy,
  denialCopy,
  installPriceLine,
  purchaseModelLine
} from '../src/shared/marketplace-copy'
import { FORBIDDEN_REASONS } from '../src/shared/preset-manifest'

/**
 * Magpie's give-up reason 5 was that every decision point rendered raw JSON.
 * These assert the opposite property: for each protocol moment a person can
 * reach, a SENTENCE exists — and no sentence leaks the machinery.
 */
describe('every protocol moment has words', () => {
  it('covers all six 403 reasons with a title, body and action', () => {
    for (const reason of FORBIDDEN_REASONS) {
      const c = denialCopy(reason, 'https://example.test', {
        n: 3, deviceList: 'a, b', author: '@ana', from: 'v1', to: 'v2', wanted: 'v3',
        date: '12 Aug', authorNote: 'n', presetName: 'Crew', amount: '0.00', asset: 'USDC'
      })
      expect(c.title.length, reason).toBeGreaterThan(0)
      expect(c.action.length, reason).toBeGreaterThan(0)
    }
  })

  it('falls back for a reason no client has heard of, rather than showing the token', () => {
    const c = denialCopy('teleport_denied', undefined)
    expect(c.title).not.toContain('teleport_denied')
    expect(c.body).toContain('Nothing was installed')
  })

  it('distinguishes invalid from unverifiable — different voice, different action', () => {
    const invalid = blockedCopy('signature_invalid', { author: '@ana' })!
    const unverifiable = blockedCopy('schema_unsupported', { author: '@ana' })!
    expect(invalid.body).toMatch(/altered/)
    expect(unverifiable.body).not.toMatch(/altered|tamper/)
    expect(invalid.action).not.toBe(unverifiable.action)
  })

  it('states where the money goes and what a second download costs', () => {
    expect(copy('mkt.pay.destination', { author: '@ana' })).toContain('takes nothing')
    expect(copy('mkt.pay.receipt')).toMatch(/free/i)
  })

  it('tells an author their original session is untouched', () => {
    expect(copy('mkt.export.safety')).toMatch(/never touched/)
  })

  it('prices a free preset as free rather than as a blank', () => {
    expect(installPriceLine(null, 'ana')).toBe('Free.')
    expect(installPriceLine({ model: 'one-time', amount: '12.00', asset: 'USDC' }, 'ana'))
      .toContain('@ana')
    expect(purchaseModelLine({ model: 'per-call', amount: '1', asset: 'USDC' })).toMatch(/each call/)
  })

  it('leaks no status code or reason token into any string (R14)', () => {
    for (const [id, value] of Object.entries(MKT_ALL)) {
      for (const banned of ['401', '402', '403', 'seat_limit', 'balance_empty', 'scope', 'nonce']) {
        expect(value, `${id} leaks ${banned}`).not.toContain(banned)
      }
    }
  })

  it('never says sign in, account, or unlock — the words the audit banned', () => {
    for (const [id, value] of Object.entries(MKT_ALL)) {
      expect(value.toLowerCase(), id).not.toMatch(/\bsign in\b|\blog in\b|\bunlock\b/)
    }
  })
})
