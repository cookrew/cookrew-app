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

/**
 * Door B — the remote teammate card. The two properties that are privacy
 * decisions rather than wording preferences.
 */
describe('remote card refusals', () => {
  it('renders 403-scope, 403-revoked and 404 with the IDENTICAL sentence', async () => {
    const { remoteRefusalCopy } = await import('../src/shared/marketplace-copy')
    const scope = remoteRefusalCopy(403, 'Tinker', 'scope').text
    const revoked = remoteRefusalCopy(403, 'Tinker', 'revoked').text
    const missing = remoteRefusalCopy(404, 'Tinker').text
    // The merge IS the privacy: an unexported agent and one that never existed
    // must be indistinguishable, and a shared string survives a refactor where
    // two carefully-similar sentences do not.
    expect(scope).toBe(revoked)
    expect(revoked).toBe(missing)
  })

  it('splits identity from busy — both retryable, only one by pressing again', async () => {
    const { remoteRefusalCopy } = await import('../src/shared/marketplace-copy')
    expect(remoteRefusalCopy(409, 'Tinker').retryable).toBe(true)
    expect(remoteRefusalCopy(401, 'Tinker').retryable).toBe(true)
    expect(remoteRefusalCopy(401, 'Tinker').text).not.toBe(remoteRefusalCopy(409, 'Tinker').text)
    expect(remoteRefusalCopy(403, 'Tinker').retryable).toBe(false)
  })

  it('never names the owner in a revocation', async () => {
    const { MKT_REMOTE_REVOKED } = await import('../src/shared/marketplace-copy')
    for (const value of Object.values(MKT_REMOTE_REVOKED)) {
      expect(value).not.toMatch(/\{owner\}|\{author\}/)
    }
  })

  it('counts callers without "(s)"', async () => {
    const { accessLabel } = await import('../src/shared/marketplace-copy')
    expect(accessLabel(0)).toBe('Nobody can call this')
    expect(accessLabel(1)).toBe('1 caller')
    expect(accessLabel(4)).toBe('4 callers')
  })

  it('says the cold wait is one-time, at both stages', async () => {
    const { MKT_REMOTE_WAKING } = await import('../src/shared/marketplace-copy')
    expect(MKT_REMOTE_WAKING['mkt.remote.waking.first']).toMatch(/after that/i)
    expect(MKT_REMOTE_WAKING['mkt.remote.waking.still']).toMatch(/only happens once/i)
  })
})
