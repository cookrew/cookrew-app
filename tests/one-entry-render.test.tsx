import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  ShareOnSave,
  canSubmitShare,
  priceLooksGood,
  saveButtonLabel,
  serveRefusalText,
  type ShareAccess
} from '../src/renderer/src/ShareOnSave'
import { ServedTeamCard, type ServedTeam } from '../src/renderer/src/ServedTeamCard'
import { ImportServedSheet } from '../src/renderer/src/ImportServedSheet'
import { renderServedCrewFace, type CrewFace } from '../src/main/served-endpoints'
import type { ServedPaymentRail } from '../src/shared/served-payment-rails'
import { EMPTY_SERVED_PAYMENT_STATUS } from '../src/shared/served-payment-config'
import { MKT_SERVE } from '../src/shared/marketplace-copy'
import { PaymentSettingsSheet } from '../src/renderer/src/PaymentSettingsSheet'

/**
 * THE ONE-ENTRY SURFACES render, and say the things the ruling requires.
 *
 * The cheapest half of "it is tappable on the card": a surface that throws on
 * first paint wastes a whole QA pass. These also pin the two claims the design
 * turns on — the primary renames when the click gains a consequence, and the
 * door fact appears only when a door is actually opening.
 */

const noop = (): void => undefined
const src = (file: string): string =>
  readFileSync(path.join(__dirname, '..', 'src/renderer/src', file), 'utf8')

const paint = (
  access: ShareAccess,
  priceUsd = '',
  paymentRails: readonly ServedPaymentRail[] = ['x402', 'stripe']
): string =>
  renderToStaticMarkup(
    <ShareOnSave
      access={access}
      priceUsd={priceUsd}
      paymentRails={paymentRails}
      door="Conductor"
      onAccess={noop}
      onPrice={noop}
      onConfigurePayments={noop}
    />
  )

describe('ShareOnSave — the share question inside the save sheet', () => {
  it('offers exactly the three doors, private first', () => {
    const html = paint('just-me')
    expect(html).toContain('Just me')
    expect(html).toContain('Anyone with a Cookrew account')
    expect(html).toContain('Anyone who pays')
  })

  it('shows NO door fact while the team stays private', () => {
    // Before a door opens it is noise; it answers a fear nobody has yet.
    expect(paint('just-me')).not.toContain('Callers talk to')
  })

  it('shows the door fact the moment a public option is picked', () => {
    for (const access of ['account', 'paid'] as const) {
      expect(paint(access)).toContain('Callers talk to Conductor only')
    }
  })

  it('asks for a price only on the paid door, per SESSION', () => {
    expect(paint('account')).not.toContain('per session')
    expect(paint('paid', '2.50')).toContain('USD · per session')
  })

  it('names only the payment rails the door will actually offer', () => {
    expect(paint('paid', '2.50', ['x402', 'stripe'])).toContain('Offers USDC · card')
    const x402Only = paint('paid', '2.50', ['x402'])
    expect(x402Only).toContain('Offers USDC')
    expect(x402Only).not.toContain('card')
    expect(paint('paid', '2.50', [])).toContain('No payment rail is configured yet.')
  })

  it('says why a bad price is bad rather than silently refusing', () => {
    expect(paint('paid', 'abc')).toContain('a number above zero')
    expect(paint('paid', '2.50')).not.toContain('a number above zero')
  })

  it('carries the NARROWED privacy claim, never the old over-promise', () => {
    // The R30 ruling: the owner CAN read a caller's session, so the copy
    // promises identity only.
    const html = paint('account')
    expect(html).toContain('They sign in, then start.')
    expect(html).not.toContain('never what they are doing')
  })
})

describe('the primary says everything the click does', () => {
  it('stays a plain SAVE while nothing is published', () => {
    expect(saveButtonLabel('just-me', false)).toBe('SAVE')
  })

  it('renames when the click also opens a door', () => {
    expect(saveButtonLabel('account', false)).toBe('SAVE · START SERVING')
    expect(saveButtonLabel('paid', false)).toBe('SAVE · START SERVING')
  })

  it('cannot submit a paid door that could not quote at 402', () => {
    expect(canSubmitShare('paid', '', 'Conductor', ['x402'])).toBe(false)
    expect(canSubmitShare('paid', '0', 'Conductor', ['x402'])).toBe(false)
    expect(canSubmitShare('paid', '2.50', 'Conductor', [])).toBe(false)
    expect(canSubmitShare('paid', '2.50', 'Conductor', ['x402'])).toBe(true)
    // A free door never blocks on a price it does not have.
    expect(canSubmitShare('just-me', '', 'Conductor', [])).toBe(true)
    expect(canSubmitShare('account', '', 'Conductor', [])).toBe(true)
  })

  it('cannot submit a PUBLIC door with no orch — the save is where that is caught', () => {
    // Owner ruling 2026-08-26. The crew used to save, serve, and hand the first
    // caller's prompt to a bare shell; the refusal belongs at the act.
    expect(canSubmitShare('account', '', null, [])).toBe(false)
    expect(canSubmitShare('paid', '2.50', null, ['x402'])).toBe(false)
    // Private is untouched: just-me publishes nothing, so it needs no door.
    expect(canSubmitShare('just-me', '', null, [])).toBe(true)
  })

  it('agrees with the backend on what a price is', () => {
    // Mirrors validPrice in session-served.ts — a UI that accepted what the
    // main process refuses would fail at the worst moment.
    expect(priceLooksGood('2.50')).toBe(true)
    expect(priceLooksGood('10')).toBe(true)
    expect(['0', '-1', 'abc', '', '1.234'].every((v) => !priceLooksGood(v))).toBe(true)
  })
})

describe('serve refusal copy', () => {
  it('states that an unusable grant is not taking callers and names both owner fixes', () => {
    const text = serveRefusalText('grant-unusable')
    expect(text).toContain('Not taking callers')
    expect(text).toContain('Match the grant to the orch')
    expect(text).toContain('endpoint’s request template')
  })

  it('sends the phone owner to the desktop instead of showing the raw token', () => {
    // The remote transport refuses servingServe with `desktop-only` (publish is
    // owner-IPC only, the grant-surface rule). That word reached the bar as-is.
    const text = serveRefusalText('desktop-only')
    expect(text).not.toBe('desktop-only')
    expect(text).toContain('desktop')
  })
})

describe('the share popover survives a phone-width bar', () => {
  /**
   * The user saved a team on the phone and the share chooser never appeared:
   * under ≤700px the bar became a scroll container (overflow-x: auto), and a
   * scroll container clips the absolutely positioned popovers it contains —
   * the share sheet, the clipboard tray, the address receipt. The scroll must
   * live on a NON-positioned inner row instead: absolute children escape the
   * overflow of an ancestor that is not their containing block.
   */
  it('keeps every popover a direct child of the positioned bar, outside the row', () => {
    const bar = src('SelectionBar.tsx')
    expect(bar).toContain('className="cr-selbar-row"')
    const row = bar.indexOf('className="cr-selbar-row"')
    for (const popover of [
      'cr-selbar-share cr-selbar-served',
      'className="cr-selbar-tray"'
    ]) {
      expect(bar.indexOf(popover), popover).toBeLessThan(row)
    }
    // The share sheet sits at the bar's own indent (6 spaces), one level
    // above row content — nesting it back inside the row would deepen this.
    expect(bar).toMatch(/\n {6}\{naming && \(\n {8}<div className="cr-selbar-share">/)
  })

  it('narrow screens scroll the row, never the bar the popovers hang from', () => {
    const css = readFileSync(
      path.join(__dirname, '..', 'src/renderer/src', 'styles.css'),
      'utf8'
    )
    // The base rule must stay overflow-free too — clipping there brings the
    // bug back at EVERY width, not just phones.
    const base = css.indexOf('\n.cr-selbar {')
    expect(base).toBeGreaterThan(-1)
    expect(css.slice(base, css.indexOf('}', base))).not.toContain('overflow')
    const start = css.indexOf('Narrow screens: the bar hugs the width')
    expect(start).toBeGreaterThan(-1)
    const end = css.indexOf('}\n\n/* ----', start)
    expect(end).toBeGreaterThan(-1)
    const block = css.slice(start, end)
    expect(block).toMatch(/\.cr-selbar-row[^{]*\{[^}]*overflow-x:\s*auto/)
    expect(block).not.toMatch(/\.cr-selbar\s*\{[^}]*overflow/)
  })
})

describe('the save-flow overlays wear the house dress', () => {
  /**
   * The payment sheet and the served-team card reuse the grant surface's gs-*
   * skeleton, whose --cr-* tokens are defined nowhere in this app — every
   * surface wearing them fell back to a foreign dark theme, with the app's
   * own ink invisible on it (the phone screenshot: a near-black sheet whose
   * headings could not be read). cr-sheet re-dresses the skeleton in house
   * materials; these pin the class to the two sheets and the tokens to the
   * treatment.
   */
  const css = (): string =>
    readFileSync(path.join(__dirname, '..', 'src/renderer/src', 'team-fork.css'), 'utf8')

  it('both sheets carry the cr-sheet treatment', () => {
    const paymentHtml = renderToStaticMarkup(
      <PaymentSettingsSheet status={EMPTY_SERVED_PAYMENT_STATUS} onStatus={noop} onClose={noop} />
    )
    expect(paymentHtml).toContain('cr-sheet')
    const servedHtml = renderToStaticMarkup(
      <ServedTeamCard
        team={{
          serviceId: 'svc',
          templateId: 'Crew',
          slug: 'crew',
          access: 'account',
          address: 'http://192.168.1.20:8639/crew',
          transport: 'lan',
          paymentRails: []
        }}
        door="Conductor"
        paymentStatus={EMPTY_SERVED_PAYMENT_STATUS}
        onConfigurePayments={noop}
        onStopped={noop}
        onClose={noop}
      />
    )
    expect(servedHtml).toContain('cr-sheet')
    const importHtml = renderToStaticMarkup(<ImportServedSheet onClose={noop} onImported={noop} />)
    expect(importHtml).toContain('cr-sheet')
  })

  it('the treatment speaks house tokens, not the undefined dark ones', () => {
    const sheet = css()
    const start = sheet.indexOf('.cr-sheet.gs-sheet {')
    expect(start).toBeGreaterThan(-1)
    const block = sheet.slice(start, sheet.indexOf('}', start))
    expect(block).toContain('var(--cream-hi)')
    expect(block).toContain('var(--ink)')
    expect(block).not.toContain('--cr-panel')
  })

  it('the share popover container is cream, no longer the foreign dark panel', () => {
    const styles = readFileSync(
      path.join(__dirname, '..', 'src/renderer/src', 'styles.css'),
      'utf8'
    )
    const start = styles.indexOf('.cr-selbar-share {')
    expect(start).toBeGreaterThan(-1)
    const block = styles.slice(start, styles.indexOf('}', start))
    expect(block).toContain('background: var(--cream-hi)')
    expect(block).toContain('border: 2px solid var(--line)')
    expect(block).toContain('box-shadow: 3px 3px 0 var(--line)')
    expect(block).not.toContain('--cr-panel')
  })

  it('the bar carries no transform — a fixed scrim inside would anchor to it', () => {
    // position: fixed resolves against a transformed ancestor, not the
    // viewport. The payment sheet renders INSIDE the bar; a transform here
    // glued its scrim to the bar instead of covering the screen.
    const styles = readFileSync(
      path.join(__dirname, '..', 'src/renderer/src', 'styles.css'),
      'utf8'
    )
    const base = styles.indexOf('\n.cr-selbar {')
    expect(base).toBeGreaterThan(-1)
    const bar = styles.slice(base, styles.indexOf('}', base))
    expect(bar).not.toContain('transform')
    // …and pin the replacement centering, so deleting it outright fails too.
    expect(bar).toContain('margin-inline: auto')
    expect(bar).toContain('width: fit-content')
  })
})

describe('Ways to get paid — the missing paid-door affordance', () => {
  it('renders both setup paths while exposing no Stripe value', () => {
    const html = renderToStaticMarkup(
      <PaymentSettingsSheet
        status={EMPTY_SERVED_PAYMENT_STATUS}
        onStatus={noop}
        onClose={noop}
      />
    )
    expect(html).toContain('Ways to get paid')
    expect(html).toContain('USDC receiving address')
    expect(html).toContain('Stripe secret key')
    expect(html).toMatch(/write-only/i)
    expect(html).not.toContain('sk_test_')
  })

  it('paid plus zero rails shows the fix beside a disabled submit decision', () => {
    const html = paint('paid', '2.50', [])
    expect(html).toContain('Set up ways to get paid')
    expect(html).toContain('A paid door needs at least one way to pay you.')
    expect(canSubmitShare('paid', '2.50', 'Conductor', [])).toBe(false)
  })

  it('configured status names the actual rails and only the Stripe mode', () => {
    const html = renderToStaticMarkup(
      <PaymentSettingsSheet
        status={{
          x402: { ready: true, payTo: '0x1111111111111111111111111111111111111111' },
          stripe: { ready: true, mode: 'test' }
        }}
        onStatus={noop}
        onClose={noop}
      />
    )
    expect(html).toContain('USDC rail: configured')
    expect(html).toContain('0x1111111111111111111111111111111111111111')
    expect(html).toContain('Card rail: configured (test)')
    expect(html).not.toContain('sk_test_')
    expect(html).not.toContain('Paste secret key')
  })

  it('the Stripe input never becomes React state and is cleared before the reply', () => {
    const sheet = src('PaymentSettingsSheet.tsx')
    expect(sheet).not.toMatch(/\[\s*stripe(?:Secret|Key|Value)\s*,/i)
    expect(sheet.indexOf("field.value = ''")).toBeGreaterThan(-1)
    expect(sheet.indexOf("field.value = ''")).toBeLessThan(sheet.indexOf('void write'))
  })
})

describe('ServedTeamCard — who is on, on the thing you published', () => {
  const team: ServedTeam = {
    serviceId: 'svc-research-crew',
    templateId: 'Research Crew',
    slug: 'research-crew',
    access: 'paid',
    priceUsd: '2.50',
    paymentRails: ['x402', 'stripe'],
    transport: 'lan' as const,
    address: 'http://192.168.1.20:8639/research-crew'
  }

  it('leads with the address, because that is the thing you hand over', () => {
    const html = renderToStaticMarkup(
      <ServedTeamCard
        team={team}
        door="Conductor"
        paymentStatus={EMPTY_SERVED_PAYMENT_STATUS}
        onConfigurePayments={noop}
        onStopped={noop}
        onClose={noop}
      />
    )
    expect(html).toContain('http://192.168.1.20:8639/research-crew')
    expect(html).toContain('COPY LINK')
    expect(html).toContain('Research Crew is taking calls.')
  })

  it('names the door and the price on one line', () => {
    const html = renderToStaticMarkup(
      <ServedTeamCard
        team={team}
        door="Conductor"
        paymentStatus={EMPTY_SERVED_PAYMENT_STATUS}
        onConfigurePayments={noop}
        onStopped={noop}
        onClose={noop}
      />
    )
    expect(html).toContain('Callers land on Conductor')
    expect(html).toContain('2.50 USD · per session · USDC · card')
  })

  it('offers STOP SERVING and reassures the owner they can carry on', () => {
    const html = renderToStaticMarkup(
      <ServedTeamCard
        team={team}
        door="Conductor"
        paymentStatus={EMPTY_SERVED_PAYMENT_STATUS}
        onConfigurePayments={noop}
        onStopped={noop}
        onClose={noop}
      />
    )
    expect(html).toContain('STOP SERVING')
    expect(html).toContain('Keep working exactly as you did before')
  })

  it('an existing paid door with no rail offers the same setup sheet', () => {
    const html = renderToStaticMarkup(
      <ServedTeamCard
        team={{ ...team, paymentRails: [] }}
        door="Conductor"
        paymentStatus={EMPTY_SERVED_PAYMENT_STATUS}
        onConfigurePayments={noop}
        onStopped={noop}
        onClose={noop}
      />
    )
    expect(html).toContain('Research Crew needs a way to get paid.')
    expect(html).toContain('A paid door needs at least one way to pay you.')
    expect(html).toContain('Set up ways to get paid')
  })
})

describe('ImportServedSheet — one address, one orch card', () => {
  it('paints, and asks only for the address', () => {
    const html = renderToStaticMarkup(<ImportServedSheet onClose={noop} onImported={noop} />)
    expect(html).toContain('Import a team')
    expect(html).toContain('LOOK UP')
    expect(html).toContain('Paste the address')
  })

  it('the primary is disabled until something is pasted', () => {
    expect(renderToStaticMarkup(<ImportServedSheet onClose={noop} onImported={noop} />)).toContain(
      'disabled'
    )
  })
})

describe('served caller face — the page tells a caller what they can actually do', () => {
  const face = (
    access: CrewFace['access'],
    paymentRails: readonly ServedPaymentRail[]
  ): CrewFace => ({
    name: 'Research Crew',
    serviceId: 'svc-research-crew',
    slug: 'research-crew',
    address: 'http://192.168.1.20:8639/research-crew',
    version: 1,
    access,
    ...(access === 'paid' ? { priceUsd: '2.50' } : {}),
    door: 'Conductor',
    agents: 4,
    paymentRails
  })

  it('a paid face with no rails makes no promise of price or payment methods', () => {
    const html = renderServedCrewFace(face('paid', []), false)
    expect(html).toContain('This crew is not taking new callers right now.')
    expect(html).not.toContain('Choose any payment method')
    expect(html).not.toContain('2.50 USD to start')
  })

  it('an account face sends the caller through + IMPORT with a copy-ready address', () => {
    const html = renderServedCrewFace(face('account', []), false)
    expect(html).toContain('+ IMPORT')
    expect(html).toContain('http://192.168.1.20:8639/research-crew')
    expect(html).toContain('signs you in when it starts')
    expect(html).toContain('Conductor')
    expect(html).not.toContain('one tap')
  })

  it('a paid face with live rails explains that the card asks for payment at start', () => {
    const html = renderServedCrewFace(face('paid', ['x402']), false)
    expect(html).toContain('2.50 USD to start')
    expect(html).toContain('Pay with USDC on Base')
    expect(html).toContain('+ IMPORT')
    expect(html).toContain('takes the payment once, before anything is placed')
  })
})

describe('a serving save SHOWS the address it minted', () => {
  // The user-reported gap: SAVE · START SERVING succeeded and the address was
  // set in state — and never rendered. These pin the receipt to the source.
  it('SelectionBar renders the address card, held until DONE', () => {
    const bar = src('SelectionBar.tsx')
    expect(bar).toContain('cr-selbar-served')
    expect(bar).toContain('COPY LINK')
    expect(bar).toMatch(/servedAt && !naming/)
  })

  it('a serving save does not bury the address under a transient flash', () => {
    const bar = src('SelectionBar.tsx')
    expect(bar).toMatch(/if \(access === 'just-me'\) showFlash/)
  })
})

describe('save and fork are separate product acts', () => {
  it('keeps FORK TEAM pure while retaining passive serving state', () => {
    const fork = src('TeamForkPicker.tsx')
    expect(fork).toContain('teamFork(spec)')
    expect(fork).toContain('TAKING CALLS ·')
    expect(fork).toContain('<span className="cr-chip cr-serving-badge"')
    expect(fork).not.toContain('<ShareOnSave')
    expect(fork).not.toContain('<ServedTeamCard')
    expect(fork).not.toContain('<PaymentSettingsSheet')
    expect(fork).not.toContain('.teamSave(')
    expect(fork).not.toContain('.servingServe(')
    expect(fork).not.toContain('SAVE TEAM')
    expect(fork).not.toContain('COPY LINK')
  })

  it('keeps every publication and serve-management capability on SAVE', () => {
    const save = src('SelectionBar.tsx')
    expect(save).toContain('.teamSave(')
    expect(save).toContain('.servingServe(')
    expect(save).toContain('<ShareOnSave')
    expect(save).toContain('<PaymentSettingsSheet')
    expect(save).toContain('<ServedTeamCard')
    expect(save).toContain('COPY LINK')
    expect(save).toContain('setOpenServedTeam(team)')
  })
})

describe('the retirements are real, not merely unmounted', () => {
  it('no per-agent export toggle survives on a roster row', () => {
    const row = src('AgentRow.tsx')
    expect(row).not.toContain('<ExportToggle')
    expect(row).not.toContain("from './ExportToggle'")
  })

  it('no crew chip family survives in the dock — the one entry is + IMPORT', () => {
    const dock = src('Dock.tsx')
    expect(dock).not.toContain('crew-chip')
    expect(dock).not.toContain('+ ADD BY LINK')
    expect(dock).toContain('+ IMPORT')
  })
})

describe('the card says who can open the link it just gave you', () => {
  /**
   * The address was handed out with no indication of how far it carries, so a
   * person could copy a 192.168 link and send it to another city. Reach is a
   * fact ABOUT the link, and the moment it matters is the moment it is copied.
   */
  const served = (transport: ServedTeam['transport']): ServedTeam => ({
    serviceId: 'svc-research-crew',
    templateId: 'Research Crew',
    slug: 'research-crew',
    access: 'account',
    address: 'http://192.168.1.20:8639/research-crew',
    transport,
    paymentRails: []
  })

  const render = (transport: ServedTeam['transport']): string =>
    renderToStaticMarkup(
      <ServedTeamCard
        team={served(transport)}
        door="Conductor"
        paymentStatus={EMPTY_SERVED_PAYMENT_STATUS}
        onConfigurePayments={noop}
        onStopped={noop}
        onClose={noop}
      />
    )

  it('a private door says so, and says what would widen it', () => {
    const html = render('lan')
    expect(html).toContain('Only people on this network can open it.')
    expect(html).toContain('turn on Tailscale')
  })

  it('a tailnet door names the tailnet, not the network', () => {
    const html = render('tailnet')
    expect(html).toContain('Only people on your tailnet can open it.')
    expect(html).not.toContain('Only people on this network')
  })

  it('a door anyone can reach needs no explanation beside it', () => {
    const html = render('relay')
    expect(html).toContain('Anyone with the link can open it.')
    expect(html).not.toContain('turn on Tailscale')
  })

  it('a relayed door hands out a name, and nothing about this machine', () => {
    // What a person copies and sends. It must be openable by whoever they send
    // it to, and it must not carry their home network's address to get there.
    const html = renderToStaticMarkup(
      <ServedTeamCard
        team={{
          ...served('relay'),
          slug: 'cookrew-alpha',
          address: 'https://cookrew.dev/@drej/cookrew-alpha'
        }}
        door="Pilot"
        paymentStatus={EMPTY_SERVED_PAYMENT_STATUS}
        onConfigurePayments={noop}
        onStopped={noop}
        onClose={noop}
      />
    )
    expect(html).toContain('https://cookrew.dev/@drej/cookrew-alpha')
    expect(html).toContain('Anyone with the link can open it.')
    expect(html).not.toContain('192.168')
    expect(html).not.toContain('8639')
  })

  it('reach is about reaching, never about being let in', () => {
    // The gate — sign-in, price, the owner's lending limit — is a different
    // sentence in a different place; this line must not imply entitlement.
    for (const transport of ['lan', 'tailnet', 'public', 'relay'] as const) {
      const line = MKT_SERVE[`mkt.serve.reach.${transport}` as const]
      expect(line, transport).not.toMatch(/free|pay|paid|price|sign in|account/i)
    }
  })
})
