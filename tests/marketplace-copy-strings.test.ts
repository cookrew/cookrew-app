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

  it('keeps cannot-take-payment distinct from a real unverifiable payment', () => {
    const unavailable = copy('mkt.gate.payment.unavailable')
    const unverifiable = copy('mkt.gate.payment.unverifiable')
    expect(unavailable).toBe(
      "this crew can't take payment right now — nothing was charged; try later"
    )
    expect(unavailable).not.toMatch(/checker|payment may be fine/i)
    expect(unverifiable).toMatch(/checker is unreachable|payment may be fine/i)
    expect(unavailable).not.toBe(unverifiable)
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

  it('never says unlock or password — the two still banned after R31', () => {
    // R31 made "account" and "sign in" TRUE, so they are no longer banned: the
    // ban existed because they promised a thing that did not exist, and the
    // ruling created the thing. "Unlock" stays banned (it hides whether money
    // moves) and "password" stays banned (there still is not one, outside the
    // strings that exist to say so).
    const saysNoPassword = /no password|never sees your key|stores no password/i
    for (const [id, value] of Object.entries(MKT_ALL)) {
      expect(value.toLowerCase(), id).not.toMatch(/\bunlock\b/)
      if (!saysNoPassword.test(value)) {
        expect(value.toLowerCase(), id).not.toMatch(/\bpassword\b/)
      }
    }
  })

  it('MKT_ALL carries every group — a group added but not wired makes the leak test vacuous', async () => {
    // This exists because it already happened: MKT_ENROL and MKT_SAVE were
    // written, the spread into MKT_ALL silently failed to apply, and the leak
    // assertion below passed over strings it was never given. A coverage check
    // is the only thing that catches a test passing for the wrong reason.
    const mod = await import('../src/shared/marketplace-copy')
    const groups = [mod.MKT_AUTH, mod.MKT_PAY, mod.MKT_DENIED_REASONS, mod.MKT_BLOCKED,
                    mod.MKT_EXPORT, mod.MKT_ENROL, mod.MKT_SAVE, mod.MKT_INSTALL_PRICE,
                    mod.MKT_TEMPLATE, mod.MKT_SERVE, mod.MKT_SESSIONS, mod.MKT_SVC,
                    mod.MKT_CHIP, mod.MKT_GATE]
    for (const group of groups) {
      for (const id of Object.keys(group)) {
        expect(Object.keys(MKT_ALL), `${id} is not reachable through MKT_ALL`).toContain(id)
      }
    }
  })

  it('keeps the two identity vocabularies from bleeding (R31)', async () => {
    const { identityVocabularyLeaks } = await import('../src/shared/marketplace-copy')
    // Accounts at the public door; six words between two humans who know each
    // other. A sentence reaching for both has confused a registry check with a
    // conversation between two people — and that confusion is what would make
    // the ceremony feel like a formality someone else already handled.
    expect(identityVocabularyLeaks(MKT_ALL)).toEqual([])
  })

  it('the enrolment ceremony never mentions an account', async () => {
    const { MKT_ENROL } = await import('../src/shared/marketplace-copy')
    for (const [id, value] of Object.entries(MKT_ENROL)) {
      expect(value.toLowerCase(), id).not.toMatch(/\baccount\b|\bsign in\b/)
    }
  })

  it('the account door never shows a fingerprint', async () => {
    const { MKT_AUTH } = await import('../src/shared/marketplace-copy')
    for (const [id, value] of Object.entries(MKT_AUTH)) {
      expect(value.toLowerCase(), id).not.toMatch(/six words|fingerprint|out loud/)
    }
  })

  it('says saving is private, at the moment the button is pressed', async () => {
    const { MKT_SAVE } = await import('../src/shared/marketplace-copy')
    expect(MKT_SAVE['mkt.save.done']).toMatch(/private/i)
    expect(MKT_SAVE['mkt.save.done']).toMatch(/nothing was published/i)
  })
})

/** R30 — the confinements that are design decisions rather than preferences. */
describe('R30 vocabulary', () => {
  it('never says "session" to a caller', async () => {
    const { MKT_SVC, callerFacingSessionLeaks } = await import('../src/shared/marketplace-copy')
    // A stranger's session is a login: weightless, ephemeral. This one is a
    // workspace with a folder that parks for hours and survives the author's
    // next version, so their model would be far too small.
    expect(callerFacingSessionLeaks(MKT_SVC)).toEqual([])
  })

  it('keeps "service" out of prose — /svc/ is a URL, not a fourth word', async () => {
    const mod = await import('../src/shared/marketplace-copy')
    for (const [id, value] of Object.entries(mod.MKT_ALL)) {
      expect(value.toLowerCase(), id).not.toMatch(/\bservices?\b/)
    }
  })

  it('bounds the reversibility promise — unlisting is not a recall', async () => {
    const { MKT_SERVE } = await import('../src/shared/marketplace-copy')
    expect(MKT_SERVE['mkt.serve.reversible']).toMatch(/already working keeps going/i)
  })

  it('says parking costs nothing, so nobody ends a session to save money', async () => {
    const { MKT_SESSIONS } = await import('../src/shared/marketplace-copy')
    expect(MKT_SESSIONS['mkt.sessions.state.parked']).toMatch(/costs you nothing/i)
  })

  it('the END failure leads with the frightening half and offers the second remedy', async () => {
    const { MKT_SESSIONS } = await import('../src/shared/marketplace-copy')
    const e = MKT_SESSIONS['mkt.sessions.end.error']
    expect(e.indexOf('still running')).toBeLessThan(e.indexOf('Try again'))
    expect(e).toMatch(/stop serving/i)
  })

  it('the owner reassurance says carry on, not merely safe', async () => {
    const { MKT_SERVE } = await import('../src/shared/marketplace-copy')
    expect(MKT_SERVE['mkt.serve.safety']).toMatch(/keep working exactly as you did before/i)
  })
})

describe('chip provenance and the imported pin', () => {
  it('never tells a buyer their bought copy can be taken away', async () => {
    const { importedPinTip } = await import('../src/shared/marketplace-copy')
    const bought = importedPinTip('bought', 'drej', 'V2')
    expect(bought).toContain("@drej's V2")
    expect(bought).toMatch(/stays yours/i)
    // "the version you were granted" implies a revoker. On a purchase there
    // isn't one, and implying otherwise sells a weaker thing than we shipped.
    expect(bought).not.toMatch(/granted/i)
  })

  it('tells a granted caller the line can end, because it can', async () => {
    const { importedPinTip } = await import('../src/shared/marketplace-copy')
    expect(importedPinTip('granted', 'drej', 'V2')).toMatch(/can end the line/i)
  })

  it('distinguishes your own pin from someone else’s', async () => {
    const { MKT_CHIP, importedPinTip } = await import('../src/shared/marketplace-copy')
    expect(MKT_CHIP['mkt.chip.pin.own']).not.toMatch(/@|\{handle\}/)
    expect(importedPinTip('session', 'drej', 'V2')).toContain('@drej')
  })

  it('normalises the handle exactly once', async () => {
    const { importedPinTip } = await import('../src/shared/marketplace-copy')
    expect(importedPinTip('bought', '@drej', 'V2')).not.toContain('@@')
  })
})
