// THE APPROVAL CARD AND THE FACTOR LADDER, PAINTED (D6, D3).
//
// The markup IS the picture, so the picture can be asserted: the request card
// says the design's sentence and offers three answers with the right weight,
// "not me" refuses to fire without a second press, and the security rows read
// differently for an account with nothing enrolled and one with a passkey and
// an authenticator — the two states that make a promise about how the owner
// gets back in.

import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ApprovalRequest, FactorsView } from '../src/shared/account-approvals'
import { ApprovalCard } from '../src/renderer/src/account/ApprovalCard'
import { FactorRows, RemoveFactorRow } from '../src/renderer/src/account/FactorRows'
import { NewPasswordCard } from '../src/renderer/src/account/NewPasswordCard'
import { QrCode } from '../src/renderer/src/account/QrCode'
import { TotpSheet } from '../src/renderer/src/account/TotpSheet'

/** The Electron bridge, as these components feature-detect it. */
function stubBridge(): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    cookrew: {
      accountDecide: async () => ({ ok: true, value: {} }),
      accountFactors: async () => ({ ok: false, reason: 'offline' }),
      accountTotpEnrol: async () => ({ ok: false, reason: 'offline' }),
      accountSetPassword: async () => ({ ok: true, value: undefined }),
    },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
  }
}
stubBridge()
beforeEach(stubBridge)

const NOW = 1_757_000_000_000

const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: 'req-1',
  deviceName: 'Chrome on macOS in Sydney',
  kind: 'browser',
  address: '203.0.113.9',
  at: NOW - 12_000,
  expiresAt: NOW + 120_000,
  ...over,
})

const factors = (over: Partial<FactorsView> = {}): FactorsView => ({
  totp: false,
  passkeys: [],
  mustChangePassword: false,
  registry: 'https://registry.test',
  ...over,
})

const card = (requests: readonly ApprovalRequest[], focusId: string | null = null): string =>
  renderToStaticMarkup(
    <ApprovalCard
      requests={requests}
      username="drej"
      focusId={focusId}
      onStatus={() => undefined}
      now={NOW}
    />,
  )

describe('the approval card (D6)', () => {
  const html = card([request()])

  it('says the design sentence, in two lines', () => {
    expect(html).toContain('Chrome on macOS in Sydney wants to sign in as @drej.')
    expect(html).toContain(
      'Started 12 seconds ago · 203.0.113.9 · no second factor on the account yet.',
    )
  })

  it('offers three answers, weighted: approve, deny, and a ghost', () => {
    expect(html).toContain('>APPROVE<')
    expect(html).toContain('>DENY<')
    expect(html).toContain('NOT ME — LOCK ACCOUNT')
    expect(html.indexOf('APPROVE')).toBeLessThan(html.indexOf('NOT ME'))
    expect(html).toMatch(/class="gs-primary"[^>]*>APPROVE/)
    expect(html).toMatch(/class="gs-ghost"[^>]*>NOT ME/)
  })

  it('does NOT put the consequence sentence on screen until NOT ME is pressed', () => {
    // It has to be one press away, not one press: this signs every other
    // device out of the account.
    expect(html).not.toContain('Every other device signs out')
  })

  it('is nothing at all when nothing is waiting', () => {
    expect(card([])).toBe('')
  })

  it('shows the request a notification named FIRST', () => {
    const html2 = card(
      [request(), request({ id: 'req-2', deviceName: 'iPhone in Tokyo' })],
      'req-2',
    )
    expect(html2.indexOf('iPhone in Tokyo')).toBeLessThan(html2.indexOf('Chrome on macOS'))
    expect(html2.match(/>APPROVE</g)).toHaveLength(2)
  })

  it('is a card in the sheet, never a modal over the canvas', () => {
    expect(html).toContain('cr-acct-request')
    expect(html).not.toContain('gs-scrim')
    expect(html).not.toContain('aria-modal')
  })
})

describe('the security rows, in both states (D3)', () => {
  const rows = (view: FactorsView | null, elsewhere = false): string =>
    renderToStaticMarkup(
      <FactorRows
        factors={view}
        elsewhere={elsewhere}
        onAdd={() => undefined}
        onRemove={() => undefined}
        onOpenBrowser={() => undefined}
      />,
    )

  it('NOTHING ENROLLED: passkey first and recommended, both offering ADD', () => {
    const html = rows(factors())
    expect(html).toContain('Add a passkey (Touch ID)')
    expect(html).toContain('RECOMMENDED')
    expect(html).toContain('Add an authenticator app')
    expect(html.match(/>ADD</g)).toHaveLength(2)
    expect(html).not.toContain('REMOVE')
  })

  it('ENROLLED: every passkey by name, the app as ACTIVE, and ADD still beneath', () => {
    const html = rows(
      factors({
        totp: true,
        passkeys: [
          { id: 'pk-1', name: 'Comet on M1Pro', addedAt: 1_757_116_800_000 },
          { id: 'pk-2', name: 'Touch ID on this Mac', addedAt: 1_757_116_800_000 },
        ],
      }),
    )
    expect(html).toContain('Comet on M1Pro')
    expect(html).toContain('Touch ID on this Mac')
    expect(html).toContain('Added ')
    expect(html).toContain('ACTIVE')
    // Two passkeys and the authenticator come off; adding another stays open.
    expect(html.match(/>REMOVE</g)).toHaveLength(3)
    expect(html.match(/>ADD</g)).toHaveLength(1)
    expect(html).not.toContain('RECOMMENDED')
  })

  it('offers the browser when this build cannot make a passkey', () => {
    const html = rows(factors(), true)
    expect(html).toContain('Add a passkey on cookrew.dev in your browser')
    expect(html).toContain('>OPEN<')
  })
})

describe('the authenticator sheet (D3)', () => {
  const html = renderToStaticMarkup(
    <TotpSheet username="drej" onClose={() => undefined} onActive={() => undefined} />,
  )

  it('asks for the six digits, and says where they come from', () => {
    expect(html).toContain('Code from the app')
    expect(html).toContain('They change every 30 seconds.')
    expect(html).toContain('Scan this with your authenticator app, or type the secret into it.')
  })

  it('keeps CONFIRM down until there is a code — and an enrolment', () => {
    expect(html).toMatch(/<button class="gs-primary" disabled=""/)
  })
})

describe('the QR', () => {
  it('draws one square per dark module, inside a quiet zone', () => {
    const html = renderToStaticMarkup(<QrCode rows={['101', '010', '111']} label="A QR" />)
    // 3 modules + 4 either side.
    expect(html).toContain('viewBox="0 0 11 11"')
    expect(html).toContain('aria-label="A QR"')
    expect(html.match(/M\d+ \d+h1v1h-1z/g)).toHaveLength(6)
  })

  it('draws nothing rather than an empty box when there is no matrix', () => {
    expect(renderToStaticMarkup(<QrCode rows={[]} label="A QR" />)).toBe('')
  })
})

describe('the new password, after "not me"', () => {
  const html = renderToStaticMarkup(
    <NewPasswordCard username="drej" onDone={() => undefined} />,
  )

  it('says what happened, and asks for the old password as well as the new', () => {
    expect(html).toContain('Set a new password — every other device was signed out.')
    expect(html).toContain('Current password')
    expect(html).toContain('New password')
    expect(html.match(/type="password"/g)).toHaveLength(2)
  })

  it('keeps the primary down until both fields are filled', () => {
    expect(html).toMatch(/<button class="gs-primary" disabled=""/)
    expect(html).toContain('SET A NEW PASSWORD')
  })
})

describe('the password a removal costs', () => {
  const rowFor = (factor: 'passkey' | 'totp'): Parameters<typeof RemoveFactorRow>[0]['row'] => ({
    id: factor === 'totp' ? 'totp' : 'pk-1',
    label: factor === 'totp' ? 'Authenticator app' : 'Touch ID on this Mac',
    state: 'ACTIVE',
    action: 'remove',
    factor,
  })

  const removal = (factor: 'passkey' | 'totp', current = ''): string =>
    renderToStaticMarkup(
      <RemoveFactorRow
        row={rowFor(factor)}
        current={current}
        onCurrent={() => undefined}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    )

  it('asks for the password, and names what is going', () => {
    expect(removal('totp')).toContain('Your password, to remove the authenticator')
    expect(removal('passkey')).toContain('Your password, to remove this passkey')
    expect(removal('totp')).toContain('type="password"')
  })

  it('keeps REMOVE IT down until a password is typed, and offers the way out', () => {
    expect(removal('totp')).toMatch(/class="gs-revoke" disabled=""/)
    expect(removal('totp', 'correct-horse-battery')).not.toContain('disabled=""')
    expect(removal('totp')).toContain('KEEP IT')
  })
})
