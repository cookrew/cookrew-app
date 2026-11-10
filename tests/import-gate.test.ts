import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  BUDGET_RETRY_MS,
  deniedVarsFor,
  displayedTermsKey,
  remedyFor,
  settleRefusalFault,
  walkPricing
} from '../src/renderer/src/import-gate-remedy'
import { MKT_PAY } from '../src/shared/marketplace-copy'
import { deniedBand } from '../src/renderer/src/gate-sheet-copy'
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
    for (const reason of ['seat_limit', 'region', 'version_gate', 'balance_empty', 'revoked', 'scope', 'nobody-shipped-this']) {
      expect(remedyFor(reason, 'install'), reason).toEqual({ kind: 'retry' })
    }
  })

  it('a refunded seat is bought again the way a first one is: BUY AGAIN sends the intent', () => {
    expect(remedyFor('refunded', 'install')).toEqual({ kind: 'buy' })
    // No registry seats anybody at a dialled door, refunded or not.
    expect(remedyFor('refunded', 'direct')).toEqual({ kind: 'retry' })
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

describe('a refusal’s button says what it does (M2)', () => {
  /**
   * Every one of these used to name somewhere to go — the author's page, a
   * contact, a top-up — and the page is gone and the others never existed in
   * this sheet. The press asks the door again, so the label says so. Only the
   * two that BUY keep a buying label, because buying is what they do.
   */
  const VARS = {
    ...deniedVarsFor(FACE, { team: '@mira/research-crew', owner: 'mira', account: 'jkim' }),
    n: 3, deviceList: 'a, b', from: 'v1', to: 'v2', wanted: 'v3',
    date: '12 Aug', authorNote: 'n', amount: '0.00', asset: 'USDC'
  }
  const ASKS_AGAIN = ['seat_limit', 'version_gate', 'revoked', 'region', 'balance_empty', 'scope', 'budget', 'not_answering']

  it('the label and the act agree, for every reason and on both walks', () => {
    for (const reason of [...ASKS_AGAIN, 'no_seat', 'refunded', 'workspace', 'payment_unavailable', 'a-reason-nobody-shipped']) {
      for (const door of ['install', 'direct'] as const) {
        const label = deniedBand(reason, undefined, VARS).action
        const buys = remedyFor(reason, door).kind === 'buy'
        // A label that says BUY belongs to a press that buys — and on the
        // walk where it cannot, the sheet never draws that band's button as a
        // purchase (gate-walk draws no seat step on the direct door).
        if (buys) expect(label, `${reason}/${door}`).toMatch(/^BUY /)
        else if (door === 'install') expect(label, `${reason}/${door}`).not.toMatch(/^BUY /)
      }
    }
  })

  it('"ask the door again" is labelled TRY AGAIN — nothing promises a page, a contact or a top-up', () => {
    for (const reason of ASKS_AGAIN) {
      expect(deniedBand(reason, undefined, VARS).action, reason).toBe('TRY AGAIN')
    }
    expect(deniedBand('a-reason-nobody-shipped', undefined, VARS).action).toBe('TRY AGAIN')
    expect(denialCopy('a-reason-nobody-shipped', 'https://example.test', VARS).action).toBe('TRY AGAIN')
    const everything = [...ASKS_AGAIN, 'no_seat', 'refunded', 'a-reason-nobody-shipped']
      .map((reason) => Object.values(deniedBand(reason, undefined, VARS)).join(' '))
      .concat(Object.values(denialCopy('a-reason-nobody-shipped', 'https://example.test', VARS)))
      .join(' ')
    expect(everything).not.toMatch(/↗|’s page|'s page|AUTHOR'S PAGE|CONTACT|LEARN WHY|TOP UP|UPGRADE TO|COPY DETAILS|ASK @/)
  })

  it('the two that buy say so', () => {
    expect(deniedBand('no_seat', undefined, VARS).action).toBe('BUY A SEAT · $4.00')
    expect(deniedBand('refunded', undefined, VARS).action).toBe('BUY AGAIN')
  })

  it('a refusal a door sends without its facts still paints, with its own label — never a blank sheet', () => {
    // A served door sends a reason and nothing else: no date, no counts.
    const served = deniedVarsFor(FACE, { team: '@mira/research-crew', owner: 'mira', account: 'jkim' })
    const refunded = deniedBand('refunded', undefined, served)
    expect(refunded.said).toBe('This purchase was refunded')
    expect(refunded.action).toBe('BUY AGAIN')
    expect(refunded.why).not.toMatch(/\{|undefined/)
    for (const reason of ['seat_limit', 'version_gate', 'revoked', 'balance_empty']) {
      const band = deniedBand(reason, undefined, served)
      expect(band.action, reason).toBe('TRY AGAIN')
      expect(`${band.said} ${band.why}`, reason).not.toMatch(/\{|undefined/)
      expect(band.said.length, reason).toBeGreaterThan(0)
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
  it('a price that is no longer the one asked has its own sentence, and blames nobody', () => {
    const fault = settleRefusalFault({ reason: 'terms-changed', detail: 'whatever main said' })
    expect(fault).toEqual({
      voice: 'apolog',
      title: MKT_PAY['mkt.pay.error.changed.title'],
      body: MKT_PAY['mkt.pay.error.changed.body']
    })
    expect(fault.body).toMatch(/nothing was signed/)
    expect(fault.body).toMatch(/nothing was charged/)
    // It also fires when ANOTHER SCREEN of the same person re-asked the door
    // and this one went stale: the cause may be local, so the door is not accused.
    expect(`${fault.title} ${fault.body}`).not.toMatch(/door changed|changed its/i)
    expect(fault.body).toContain('Cancel and import again to see the current terms.')
  })

  it('a wallet press main refused because a card payment stands says so, and never that nothing was charged', () => {
    const fault = settleRefusalFault({ reason: 'card-in-flight', detail: 'whatever main said' })
    expect(fault).toEqual({
      voice: 'apolog',
      title: MKT_PAY['mkt.pay.card.resume.title'],
      body: MKT_PAY['mkt.pay.card.unconfirmed.body']
    })
    expect(`${fault.title} ${fault.body}`).not.toMatch(/nothing was charged/i)
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

describe('displayedTermsKey — the press vouches for what is on screen (C)', () => {
  const KEY = 'x402-terms/1|base-sepolia|84532|2500000|0xpayee|0xasset|300|USDC|2'
  const rail = { rail: 'x402' as const, price: '2.5', asset: 'USDC', chain: 'base-sepolia', payTo: '0xpayee', expiry: 0, shown: KEY }

  it('sends back the key of the rail it printed', () => {
    expect(displayedTermsKey(rail)).toBe(KEY)
  })

  it('vouches for nothing when the printed price or chain is not what the key says', () => {
    expect(displayedTermsKey({ ...rail, price: '0' })).toBeUndefined()
    expect(displayedTermsKey({ ...rail, price: '2.50' })).toBeUndefined()
    expect(displayedTermsKey({ ...rail, chain: 'base' })).toBeUndefined()
    expect(displayedTermsKey({ ...rail, shown: 'nonsense' })).toBeUndefined()
    expect(displayedTermsKey({ ...rail, shown: KEY.replace('|2500000|', '|0x2625A0|') })).toBeUndefined()
  })

  it('a card rail and no rail show no wallet terms', () => {
    expect(displayedTermsKey(null)).toBeUndefined()
    expect(displayedTermsKey({ rail: 'stripe', price: '2.50', asset: 'USD', chain: 'Stripe', expiry: 0 })).toBeUndefined()
  })

  it('the sheet sends it with the press, from the SELECTED rail — the one whose terms are printed', () => {
    expect(src('ImportGate.tsx')).toContain(".serveSettle(link, 'x402', undefined, displayedTermsKey(selected))")
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
