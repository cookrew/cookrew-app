import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  BUDGET_RETRY_MS,
  deniedVarsFor,
  remedyFor,
  settleRefusalFault,
  walkPricing
} from '../src/renderer/src/import-gate-remedy'
import { MKT_PAY } from '../src/shared/marketplace-copy'
import { onAccountSheetRequest, requestAccountSheet } from '../src/renderer/src/account/open-request'
import { denialCopy, unknownDenialCopy } from '../src/shared/marketplace-copy'

/**
 * THE IMPORT GATE — identity v3 (G1–G5), the parts that decide.
 *
 * The component is effects around three pure questions, and those are held
 * here without a DOM: what a refusal's one button does, what price the walk
 * carries in, and whether every sentence a 403 may say has its facts. The
 * wiring that cannot be pure — the primary opens the account sheet, the
 * sheet re-runs on an account change, no button merely closes — is pinned
 * as source, the same bar the other sheets keep.
 */

const src = (file: string): string =>
  readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', file), 'utf8')

const FACE = { name: 'RESEARCH CREW', slug: 'research-crew', access: 'paid' as const, priceUsd: '4.00' }

describe('remedyFor — every 403 goes somewhere, and none of them leaves the app (G2/G4, 0.6.0)', () => {
  it('no_seat at a listed team is BUY — the same walk, asked again with the intent', () => {
    expect(remedyFor('no_seat', 'install')).toEqual({ kind: 'buy' })
  })

  it('no remedy carries an address: the team’s page is gone and nothing opens one', () => {
    for (const reason of ['no_seat', 'seat_limit', 'region', 'version_gate', 'balance_empty', 'budget', 'nobody-shipped-this']) {
      for (const door of ['install', 'direct'] as const) {
        const act = remedyFor(reason, door)
        expect(Object.keys(act), reason).toEqual(['kind'])
        expect(JSON.stringify(act), reason).not.toMatch(/https?:|cookrew\.dev|\//)
      }
    }
  })

  it('what only the author can change is asked again, not sent to a page that no longer exists', () => {
    for (const reason of ['seat_limit', 'region', 'version_gate', 'balance_empty', 'refunded', 'revoked', 'nobody-shipped-this']) {
      expect(remedyFor(reason, 'install'), reason).toEqual({ kind: 'retry' })
    }
  })

  it('budget retries — and the sheet retries on its own in fifteen minutes', () => {
    expect(remedyFor('budget', 'install')).toEqual({ kind: 'retry' })
    expect(BUDGET_RETRY_MS).toBe(15 * 60 * 1000)
  })

  it('a direct door has no registry to buy a seat from: its no_seat is asked again', () => {
    expect(remedyFor('no_seat', 'direct')).toEqual({ kind: 'retry' })
  })

  it('never answers with a dismiss', () => {
    for (const reason of ['no_seat', 'budget', 'scope', 'a-reason-nobody-shipped']) {
      expect(['buy', 'retry']).toContain(remedyFor(reason, 'install').kind)
    }
  })
})

describe('walkPricing — the price the rail carries in', () => {
  it('a paid team reads its published price before the door quotes, so seat and pay are ahead, not dashed', () => {
    const pricing = walkPricing(FACE, null)
    expect(pricing).not.toBeNull()
    expect(pricing?.terms.price).toBe('4.00')
    expect(pricing?.terms.author).toBe('@research-crew')
  })

  it('the rail the person picked is exact and wins', () => {
    const pricing = walkPricing(FACE, {
      rail: 'stripe',
      price: '4.50',
      asset: 'USD',
      chain: 'Stripe',
      expiry: 99
    })
    expect(pricing?.terms).toMatchObject({ price: '4.50', chain: 'Stripe', expiry: 99 })
  })

  it('names the OWNER as who is paid once the listed walk knows them, not the team’s slug', () => {
    const rail = { rail: 'stripe' as const, price: '4.00', asset: 'USD' as const, chain: 'Stripe' as const, expiry: 99 }
    expect(walkPricing(FACE, rail, 'mira')?.terms.author).toBe('@mira')
    expect(walkPricing(FACE, null, 'mira')?.terms.author).toBe('@mira')
    // A dialled door tells us no owner: the slug is the most there is to say.
    expect(walkPricing(FACE, rail, null)?.terms.author).toBe('@research-crew')
  })

  it('a free team carries null — both steps dash, honestly', () => {
    expect(walkPricing({ ...FACE, access: 'account', priceUsd: undefined }, null)).toBeNull()
  })
})

describe('deniedVarsFor — a 403 never throws for a brace nobody filled', () => {
  const facts = { team: '@mira/research-crew', owner: 'mira', account: 'jkim' }

  it('fills the no_seat sentence with both people, the team and the price', () => {
    const copy = denialCopy('no_seat', undefined, deniedVarsFor(FACE, facts))
    expect(copy.title).toBe('@jkim has no seat at @mira/research-crew.')
    expect(copy.body).toContain('Ask @mira for one, or buy one')
    expect(copy.action).toBe('BUY A SEAT · $4.00')
    // The one thing this lane is for: never the unknown fallback.
    expect(copy.title).not.toBe(unknownDenialCopy(undefined).title)
  })

  it('every served refusal renders with these vars, on both walks', () => {
    const direct = { team: null, owner: null, account: null }
    // The reasons served-admission.ts can produce. The preset marketplace's
    // own 403s (seat_limit, balance_empty, version_gate) carry counts a door
    // never sends and never reach this sheet.
    for (const reason of ['no_seat', 'budget', 'payment_unavailable', 'workspace', 'not_answering', 'region']) {
      for (const vars of [deniedVarsFor(FACE, facts), deniedVarsFor(FACE, direct)]) {
        expect(() => denialCopy(reason, undefined, vars), reason).not.toThrow()
      }
    }
  })
})

describe('settleRefusalFault — a settle that main refused, in the sheet’s two voices', () => {
  it('a door that changed its terms at the press is accused, in its own sentence — never "we could not check"', () => {
    const fault = settleRefusalFault({ reason: 'terms-changed', detail: 'whatever main said' })
    expect(fault).toEqual({
      voice: 'accuse',
      title: MKT_PAY['mkt.pay.error.changed.title'],
      body: MKT_PAY['mkt.pay.error.changed.body']
    })
    expect(fault.body).toMatch(/nothing was signed/)
    expect(fault.body).toMatch(/nothing was charged/)
  })

  it('anything else is the apology, with what main could say about it', () => {
    expect(settleRefusalFault({ reason: 'refused', detail: 'the door hung up' })).toEqual({
      voice: 'apolog',
      title: MKT_PAY['mkt.pay.error.unverifiable.title'],
      body: 'the door hung up'
    })
    expect(settleRefusalFault({ reason: 'not-signed-in' }).body).toBe(MKT_PAY['mkt.pay.error.unverifiable.body'])
  })
})

describe('the account-sheet request seam (G1: identify opens the sheet in place)', () => {
  it('reaches a listening surface, and says so when nothing listens', () => {
    expect(requestAccountSheet()).toBe(false)
    let opened = 0
    const off = onAccountSheetRequest(() => void (opened += 1))
    expect(requestAccountSheet()).toBe(true)
    expect(opened).toBe(1)
    off()
    expect(requestAccountSheet()).toBe(false)
  })
})

describe('the wiring, as source', () => {
  const gate = src('ImportGate.tsx')

  it('passes onIdentify, and the primary opens the account sheet rather than closing', () => {
    expect(gate).toContain('onIdentify={identify}')
    expect(gate).toContain('requestAccountSheet()')
  })

  it('re-runs the gate when the account changes, without closing the sheet', () => {
    expect(gate).toContain('onAccountChanged')
    expect(gate).not.toContain('onDismiss()')
  })

  it('never wires a refusal to dismiss', () => {
    expect(gate).not.toContain('onRemedy={onDismiss}')
    expect(gate).toContain('onRemedy={remedy}')
  })

  it('BUY asks the gate again with the intent, and a plain ask never carries one', () => {
    // The one call to main: the intent is whatever this ask was given, and
    // every ask that is not a press of BUY is given none.
    expect(gate).toContain('.serveGate(link, intent)')
    expect(gate).toContain("runGate(act.kind === 'buy' ? 'buy' : undefined)")
    expect(gate.match(/'buy'/g)?.length, 'BUY is named where the press is handled and nowhere else').toBe(3)
  })

  it('no refusal opens a web page: no browser card, no link, no site address (0.6.0)', () => {
    for (const file of ['ImportGate.tsx', 'import-gate-remedy.ts']) {
      const text = src(file)
      expect(text, file).not.toMatch(/addNode|kind: 'browser'|openExternal|window\.open/)
      expect(text, file).not.toMatch(/https?:\/\//)
      expect(text, file).not.toContain('teamPageUrl')
    }
  })

  it('the account surface listens for the request', () => {
    expect(src('account/AccountSurface.tsx')).toContain('onAccountSheetRequest(open)')
  })

  it('no call door remains in the renderer (G5)', () => {
    for (const file of ['ImportGate.tsx', 'GateSheet.tsx', 'gate-sheet-copy.ts', 'import-gate-remedy.ts']) {
      const text = src(file)
      expect(text, file).not.toMatch(/door === 'call'|door: 'call'|SixWords|MKT_ENROL/)
    }
  })
})
