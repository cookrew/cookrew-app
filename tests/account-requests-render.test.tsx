// THE ONE QUEUE AND THE FACTOR LADDER, PAINTED (D11, D3).
//
// The markup IS the picture, so the picture can be asserted: the queue draws a
// row per kind with the buttons that kind has, APPROVE is DEAD until the two
// digits are typed, a finished row wears its chip and offers nothing, and the
// security rows read differently for an account with nothing enrolled and one
// with a passkey and an authenticator — the two states that make a promise
// about how the owner gets back in.

import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FactorsView } from '../src/shared/account-approvals'
import type { AnsweredRow, QueueRow } from '../src/shared/account-requests'
import { RequestsTab } from '../src/renderer/src/account/RequestsTab'
import { FactorRows, RemoveFactorRow } from '../src/renderer/src/account/FactorRows'
import { NewPasswordCard } from '../src/renderer/src/account/NewPasswordCard'
import { QrCode } from '../src/renderer/src/account/QrCode'
import { TotpSheet } from '../src/renderer/src/account/TotpSheet'

/** The Electron bridge, as these components feature-detect it. */
function stubBridge(): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    cookrew: {
      accountRequests: async () => ({ pending: [], answered: [] }),
      accountDecideRequest: async () => ({ ok: true, value: {} }),
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

const pending = (over: Partial<QueueRow> = {}): QueueRow => ({
  id: 'req-1',
  kind: 'join',
  device: 'Mac Studio',
  address: '203.0.113.9',
  at: NOW - 12_000,
  expiresAt: NOW + 120_000,
  state: 'pending',
  ...over,
})

const factors = (over: Partial<FactorsView> = {}): FactorsView => ({
  totp: false,
  passkeys: [],
  mustChangePassword: false,
  registry: 'https://registry.test',
  ...over,
})

const queue = (
  rows: readonly QueueRow[],
  answered: readonly AnsweredRow[] = [],
  focusId: string | null = null,
): string =>
  renderToStaticMarkup(
    <RequestsTab
      username="drej"
      refreshKey={0}
      focusId={focusId}
      onStatus={() => undefined}
      initial={{ pending: rows, answered }}
      now={NOW}
    />,
  )

describe('the one queue (D11)', () => {
  const html = queue([
    pending(),
    pending({ id: 'reach-1', kind: 'reach', device: 'iPhone', askKey: { kty: 'OKP' } }),
    pending({ id: 'seat-1', kind: 'seat', account: 'jkim', team: '@drej/alpha', device: undefined }),
  ])

  it('draws one row per kind, each with the buttons that kind has', () => {
    expect(html).toContain('Mac Studio wants to join @drej')
    expect(html).toContain('iPhone wants to reach this Mac on Wi-Fi.')
    expect(html).toContain('@jkim asks for a seat at @drej/alpha.')
    for (const label of ['>APPROVE<', '>DENY<', '>NOT ME<', '>ALLOW<', '>NOT NOW<', '>SEAT THEM<', '>DECLINE<']) {
      expect(html, label).toContain(label)
    }
  })

  it('asks the join row for the number, and NOWHERE else', () => {
    expect(html).toContain('What number is on that Mac?')
    expect(html.match(/What number is on that Mac\?/g)?.length).toBe(2) // label + placeholder
    expect(html.match(/cr-acct-match/g)).toHaveLength(1)
  })

  it('leaves APPROVE DEAD until the two digits are typed', () => {
    // The rung is worth nothing if the button can be pressed without reading
    // the other machine's screen, so it ships disabled and the field beside it
    // is the reason it will not move.
    expect(html).toMatch(/class="gs-primary"[^>]*disabled[^>]*>APPROVE/)
    // ALLOW and SEAT THEM are one press: they need no number.
    expect(html).toMatch(/class="gs-primary"[^>]*>ALLOW/)
    expect(html).not.toMatch(/class="gs-primary"[^>]*disabled[^>]*>ALLOW/)
  })

  it('weights the three answers to a sign-in: approve, deny, then the alarm', () => {
    expect(html.indexOf('APPROVE')).toBeLessThan(html.indexOf('>DENY<'))
    expect(html.indexOf('>DENY<')).toBeLessThan(html.indexOf('>NOT ME<'))
    expect(html).toMatch(/class="gs-ghost"[^>]*>NOT ME/)
  })

  it('says what each button does, under the list', () => {
    expect(html).toContain('ALLOW gives the phone this Mac')
    expect(html).toContain('NOT ME signs every other device out')
  })

  it('draws a finished row with its chip and nothing to press', () => {
    const over = queue(
      [],
      [
        { id: 'a1', kind: 'join', outcome: 'joined', subject: 'Mac Studio', at: NOW - 120_000 },
        { id: 'a2', kind: 'reach', outcome: 'allowed', subject: 'iPhone', at: NOW - 240_000 },
        { id: 'a3', kind: 'seat', outcome: 'seated', subject: 'jkim', team: '@drej/alpha', at: NOW - 360_000 },
        { id: 'a4', kind: 'join', outcome: 'denied', subject: 'iPhone', at: NOW - 600_000 },
      ],
    )
    expect(over).toContain('Mac Studio joined @drej')
    expect(over).toContain('>DONE<')
    expect(over).toContain('>LAN<')
    expect(over).toContain('>SEATED<')
    expect(over).toContain('A sign-in as @drej was denied on iPhone')
    expect(over).toContain('>NOT ME<')
    // A receipt offers nothing: the moment is past.
    expect(over).not.toContain('>APPROVE<')
    expect(over).not.toContain('>ALLOW<')
  })

  it('says what would land here rather than drawing an empty box', () => {
    const empty = queue([])
    expect(empty).toContain('Nothing is waiting.')
    expect(empty).not.toContain('<ul')
  })

  it('shows the row a notification named FIRST', () => {
    const html2 = queue([pending(), pending({ id: 'req-2', device: 'iPhone' })], [], 'req-2')
    expect(html2.indexOf('iPhone wants to join')).toBeLessThan(html2.indexOf('Mac Studio wants to join'))
  })

  it('is a tab in the sheet, never a modal over the canvas', () => {
    expect(html).toContain('cr-acct-request-row')
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
