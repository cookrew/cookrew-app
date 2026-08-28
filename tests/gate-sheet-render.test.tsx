import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { GateSheet, type GateSheetProps } from '../src/renderer/src/GateSheet'
import type { GateScene, WalkPricing } from '../src/shared/gate-walk'

/**
 * THE SHEET RENDERS THE WALK — the cheapest half of "it is tappable on the card"
 * (the same bar grant-panel-render holds). Magpie drives the real surface; this
 * catches the failure that would waste her pass: a sheet that throws on first
 * paint, or one that draws a step the gate never demanded. A static render runs
 * the component body, every branch reachable without effects, and — because the
 * markup IS the picture of the protocol — lets us assert the picture.
 */

const TERMS = { price: '2.50', asset: 'USDC', chain: 'Base', author: '@drej', expiry: 1_700_000_240_000 }
const PRICED: WalkPricing = { model: 'one-time', terms: TERMS }

const base: GateSheetProps = {
  scene: { door: 'install', phase: { kind: 'identify' } },
  title: 'RESEARCH CREW',
  onDismiss: () => undefined
}

const paint = (over: Partial<GateSheetProps>, scene?: Partial<GateScene>): string =>
  renderToStaticMarkup(
    <GateSheet {...base} {...over} scene={{ ...base.scene, ...scene } as GateScene} />
  )

describe('GateSheet — state A: priced install (401→402→open)', () => {
  const html = paint(
    { version: 'V4', agentCount: 4, wallets: [{ id: 'mm', label: 'METAMASK', icon: '🦊' }], selectedWallet: 'mm' },
    { pricing: PRICED, phase: { kind: 'pay' }, pin: 'V4' }
  )

  it('collapses the cleared identify step to a green receipt and lights pay', () => {
    expect(html).toContain('gk-tick done') // identify cleared
    expect(html).toContain('gk-tick now') // pay live
    expect(html).toContain('gate-401') // the identify receipt band
    expect(html).toContain('gate-402') // the money band
  })

  it('quotes the terms — price, chain and where the money lands', () => {
    expect(html).toContain('2.50')
    expect(html).toContain('Base')
    expect(html).toContain('@drej')
    // THE sentence: Cookrew holds nothing and takes nothing.
    expect(html).toMatch(/takes nothing/)
  })

  it('offers the wallet as a selected chip and the primary pays with it', () => {
    expect(html).toContain('METAMASK')
    expect(html).toContain('cr-chip clickable sel')
    expect(html).toMatch(/PAY 2\.50 USDC/)
  })
})

describe('GateSheet — state B: free install dashes the pay step', () => {
  const html = paint({ version: 'V2' }, { pricing: null, phase: { kind: 'open' }, pin: 'V2' })

  it('renders the pay tick DASHED (skip), never green (done)', () => {
    expect(html).toContain('gk-tick skip')
    // The open step is the live one; the served band is shown.
    expect(html).toContain('gate-open')
  })

  it('never quotes terms it did not ask for', () => {
    expect(html).not.toContain('gate-402')
    expect(html).not.toContain('WHAT THE GATE QUOTED')
  })

  it('leaves the buyer with the pinned version as a receipt, and a DONE to close', () => {
    expect(html).toContain('gk-rcpt')
    expect(html).toContain('Pinned to your rail')
    // The footer acknowledges the served state — it does not reuse the receipt line.
    expect(html).toMatch(/>DONE</)
  })
})

describe('GateSheet — state C: first call lights identify only, with the six words', () => {
  const html = paint(
    { words: ['corgi', 'lantern', 'fifty', 'maple', 'orbit', 'true'], bannerLine: '@drej granted you this line' },
    { door: 'call', phase: { kind: 'identify' }, pin: 'V1' }
  )

  it('has no pay slot at all — a call never charges inline', () => {
    expect(html).not.toContain('gate-402')
    expect(html).not.toContain('gk-tick skip') // not skipped — simply absent
  })

  it('shows all six words for the read-aloud comparison', () => {
    for (const w of ['corgi', 'lantern', 'fifty', 'maple', 'orbit', 'true']) {
      expect(html).toContain(w)
    }
  })

  it("uses the ceremony's verb, and warns the first reply is slow", () => {
    expect(html).toMatch(/I READ THESE ALOUD/)
    expect(html).toMatch(/never just spins/)
  })

  it('speaks the ceremony vocabulary and never the account vocabulary (R31)', () => {
    expect(html.toLowerCase()).not.toMatch(/\bsign in\b|\baccount\b/)
  })
})

describe('GateSheet — state D: refusals draw a band, not a rail', () => {
  it('a scope 403 stops in rose, with a single forward action', () => {
    const html = paint({}, { phase: { kind: 'denied', reason: 'scope', retryable: true } })
    expect(html).toContain('gate-403')
    expect(html).not.toContain('gk-rail') // a 403 is not a place on the journey
    expect(html).not.toContain('empty-credit')
  })

  it('an empty balance wears amber and offers a top-up, not a stop', () => {
    const html = paint(
      { deniedVars: { presetName: 'Research Crew', amount: '0.00', asset: 'USDC' } },
      { phase: { kind: 'denied', reason: 'balance_empty', retryable: false } }
    )
    expect(html).toContain('gate-403 empty-credit')
    expect(html).toMatch(/TOP UP/)
  })

  it('a 404 and an unusable answer both degrade to a closed refusal, never a served step', () => {
    const gone = paint({}, { phase: { kind: 'gone' } })
    const err = paint({}, { phase: { kind: 'error', status: 502 } })
    for (const html of [gone, err]) {
      expect(html).not.toContain('gate-open')
      expect(html).not.toContain('gk-rail')
    }
  })

  it('speaks about the resource, not the enrolment deck (a 404 is not a bad paste)', () => {
    const gone = paint({}, { phase: { kind: 'gone' } })
    const err = paint({}, { phase: { kind: 'error', status: 502 } })
    // renderToStaticMarkup escapes the apostrophe (&#x27;), so match past it.
    expect(gone).toMatch(/here anymore/)
    expect(err).toMatch(/reach the gate/)
    // The old bug: both painted "That doesn't look like a public key." — a
    // ceremony string dragged onto a resource error. It must not recur.
    for (const html of [gone, err]) {
      expect(html.toLowerCase()).not.toContain('public key')
    }
  })
})

describe('GateSheet — the two-voice payment fault', () => {
  it('an accusation and an apology never share a strip shape', () => {
    const accuse = paint(
      { fault: { voice: 'accuse', title: "This payment didn't verify.", body: 'Check your wallet.' } },
      { pricing: PRICED, phase: { kind: 'pay' } }
    )
    const apolog = paint(
      { fault: { voice: 'apolog', title: 'Our checker is unreachable.', body: 'Retry in a moment.' } },
      { pricing: PRICED, phase: { kind: 'pay' } }
    )
    expect(accuse).toContain('gk-err accuse')
    expect(apolog).toContain('gk-err apolog')
  })
})
