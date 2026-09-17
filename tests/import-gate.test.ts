import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  BUDGET_RETRY_MS,
  deniedVarsFor,
  remedyFor,
  walkPricing
} from '../src/renderer/src/import-gate-remedy'
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

describe('remedyFor — every 403 goes somewhere (G2/G4)', () => {
  it('no_seat is BUY, and in cut 1 BUY is the team’s page in a browser card', () => {
    expect(remedyFor('no_seat', '@mira/research-crew')).toEqual({
      kind: 'author-page',
      url: 'https://cookrew.dev/@mira/research-crew'
    })
  })

  it('seat_limit, region, version_gate and balance_empty open the author’s page', () => {
    for (const reason of ['seat_limit', 'region', 'version_gate', 'balance_empty']) {
      expect(remedyFor(reason, '@mira/research-crew').kind, reason).toBe('author-page')
    }
  })

  it('budget retries — and the sheet retries on its own in fifteen minutes', () => {
    expect(remedyFor('budget', '@mira/research-crew')).toEqual({ kind: 'retry' })
    expect(BUDGET_RETRY_MS).toBe(15 * 60 * 1000)
  })

  it('a door with no page (the direct walk) can only be asked again', () => {
    expect(remedyFor('seat_limit', null)).toEqual({ kind: 'retry' })
  })

  it('never answers with a dismiss', () => {
    for (const reason of ['no_seat', 'budget', 'scope', 'a-reason-nobody-shipped']) {
      expect(['author-page', 'retry']).toContain(remedyFor(reason, '@a/b').kind)
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
