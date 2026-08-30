import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { GateSheet } from '../src/renderer/src/GateSheet'
import { MKT_PAY, denialCopy, fillCopy } from '../src/shared/marketplace-copy'

/**
 * THE PAID IMPORT IS A SHEET, NOT A PROMPT.
 *
 * The import gate hands GateSheet a scene built from what the door actually
 * quoted. These pin the two claims that decide whether money is safe here:
 * the rail the person picked is the rail whose terms they are shown, and a
 * rail this device cannot use says so instead of offering a dead button.
 */

const src = (file: string): string =>
  readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', file), 'utf8')

const scene = (asset: string, chain: string, price: string): Parameters<typeof GateSheet>[0] => ({
  scene: {
    door: 'install',
    phase: { kind: 'pay' },
    pricing: {
      model: 'one-time',
      terms: { price, asset, chain, author: '@qa-orch-door', expiry: 0 }
    }
  },
  title: 'QA ORCH DOOR',
  version: 'V1',
  agentCount: 2,
  wallets: [
    { id: 'stripe', label: MKT_PAY['mkt.pay.rail.card'], icon: '▭' },
    { id: 'x402', label: fillCopy(MKT_PAY['mkt.pay.rail.usdc'], { wallet: '0x1234…cdef' }), icon: '◈' }
  ],
  selectedWallet: asset === 'USD' ? 'stripe' : 'x402',
  onDismiss: () => undefined
})

describe('the paid import sheet', () => {
  it('offers both rails as chips, and names the wallet that would sign', () => {
    const html = renderToStaticMarkup(<GateSheet {...scene('USDC', 'base-sepolia', '2.5')} />)
    expect(html).toContain('CARD')
    expect(html).toContain('0x1234…cdef')
    // The chip row is the choice; the selected one is pressed.
    expect(html).toContain('aria-pressed="true"')
  })

  it('quotes the terms of the SELECTED rail, not a fixed currency', () => {
    const card = renderToStaticMarkup(<GateSheet {...scene('USD', 'Stripe', '2.50')} />)
    expect(card).toContain('2.50 USD')
    expect(card).toContain('Stripe')
    expect(card).toContain('PAY 2.50 USD')
    expect(card).not.toContain('base-sepolia')

    const usdc = renderToStaticMarkup(<GateSheet {...scene('USDC', 'base-sepolia', '2.5')} />)
    expect(usdc).toContain('2.5 USDC')
    expect(usdc).toContain('base-sepolia')
    expect(usdc).toContain('PAY 2.5 USDC')
  })

  it('says where the money goes, and that Cookrew takes none of it', () => {
    const html = renderToStaticMarkup(<GateSheet {...scene('USDC', 'base-sepolia', '2.5')} />)
    expect(html).toContain('@qa-orch-door')
    expect(html).toContain('never holds your money and takes nothing')
    expect(html).toContain('Cookrew never holds your keys')
  })

  it('a device with no wallet says so rather than offering a dead button', () => {
    const props = scene('USDC', 'base-sepolia', '2.5')
    const html = renderToStaticMarkup(
      <GateSheet
        {...props}
        wallets={[{ id: 'x402', label: MKT_PAY['mkt.pay.rail.usdc.nowallet'], icon: '◈' }]}
        selectedWallet={null}
        fault={{
          voice: 'apolog',
          title: MKT_PAY['mkt.pay.error.nowallet.title'],
          body: MKT_PAY['mkt.pay.error.nowallet.body']
        }}
      />
    )
    expect(html).toContain('NO WALLET HERE')
    expect(html).toContain('No wallet on this device')
    expect(html).toContain('Cookrew never holds keys')
    // Nothing selected ⇒ the primary is CONNECT and carries no handler.
    expect(html).toContain('CONNECT WALLET')
    expect(html).toContain('disabled')
  })

  it('waiting on a card has no live pay button — that is how people pay twice', () => {
    const html = renderToStaticMarkup(<GateSheet {...scene('USD', 'Stripe', '2.50')} busy />)
    expect(html).toContain('disabled')
    expect(html).not.toContain('PAY 2.50 USD')
  })

  it("a served door's refusals have real words, not the unknown fallback", () => {
    const unknown = denialCopy('a-reason-nobody-shipped', undefined, {})
    for (const reason of ['budget', 'payment_unavailable', 'workspace', 'not_answering']) {
      const copy = denialCopy(reason, undefined, {})
      expect(copy.title, reason).not.toBe(unknown.title)
      // Every refusal says what did NOT happen to the caller's money.
      expect(`${copy.body}`.toLowerCase(), reason).toContain('charged')
    }
  })
})

describe('the terminal never asks for money again', () => {
  it('the placed card carries no payment header and no paste prompt', () => {
    const line = readFileSync(
      path.join(__dirname, '..', 'resources', 'orch-line.mjs'),
      'utf8'
    )
    // The header, as code — the comment above it is allowed to name the thing
    // it refuses to send.
    expect(line).not.toMatch(/['"]x-payment['"]/)
    expect(line).not.toContain('paste a payment')
    expect(line).not.toContain('payRef')
  })

  it('the import sheet hands a paid door to the gate, never to the card', () => {
    const sheet = src('ImportServedSheet.tsx')
    expect(sheet).toContain('ImportGate')
    expect(sheet).toContain("preview?.access === 'paid'")
  })
})
