// THE ACCOUNT SHEETS ARE CREAM, and the stylesheet that makes them so parses.
//
// Two things went wrong at once on dev (2026-09-06), and each hid the other:
//
//   1. Every account sheet put the house `cr-sheet` class on its SCRIM and a
//      different class on its PANEL, so team-fork.css's cream re-dress never
//      reached the panel and it fell to grant-surface's dark fallback — ink
//      text on a #1c1a16 box. The lock card had neither.
//   2. A D7 block was pasted INSIDE an unclosed rule in styles.css, and the
//      browser read one block running to the end of the file: the approval
//      card, the must-change card, the lock select and the seat rows were all
//      dead CSS while the file read fine to a person.
//
// A render test cannot see either, because the markup was right. So this file
// reads what the browser reads: it parses the stylesheets, and it checks the
// class every panel needs is on the element that needs it.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss from 'postcss'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AccountStatus } from '../src/shared/account-v2'
import type { FactorsView } from '../src/shared/account-approvals'
import { ClaimSheet } from '../src/renderer/src/account/ClaimSheet'
import { FactorRows } from '../src/renderer/src/account/FactorRows'
import { LockScreen } from '../src/renderer/src/account/LockScreen'
import { PairPhoneSheet } from '../src/renderer/src/account/PairPhoneSheet'
import { ProfileSheet } from '../src/renderer/src/account/ProfileSheet'
import { TotpSheet } from '../src/renderer/src/account/TotpSheet'

const RENDERER = join(__dirname, '..', 'src', 'renderer', 'src')
const css = (name: string): string => readFileSync(join(RENDERER, name), 'utf8')

function stubBridge(): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    cookrew: {
      accountCheck: async () => 'free',
      accountUnlock: async () => ({ ok: true }),
      accountTotpEnrol: async () => ({ ok: false, reason: 'offline' }),
    },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
  }
}
stubBridge()
beforeEach(stubBridge)

const STATUS: AccountStatus = {
  username: 'drej',
  displayName: '',
  avatar: null,
  locked: false,
  lockAfterMs: 900_000,
  requests: 0,
  envUsername: null,
  legacy: null,
  sessionExpired: false,
  registryMismatch: null,
  workspacesReachable: true,
  recoveryCodesSavedAt: null,
  recoveryCodesLeft: null,
}

/** Every `class="gs-sheet …"` on the page — the panels, never the scrims. */
const panels = (html: string): string[] =>
  [...html.matchAll(/class="(gs-sheet(?: [^"]*)?)"/g)].map((m) => m[1])

describe('the stylesheets parse — an unclosed block is a failed test, not dead CSS', () => {
  for (const name of ['styles.css', 'team-fork.css', 'grant-surface.css']) {
    it(`${name} has no unclosed block`, () => {
      expect(() => postcss.parse(css(name), { from: name })).not.toThrow()
    })
  }

  it('the rules after the D7 block are live: they were the ones the unclosed block ate', () => {
    const root = postcss.parse(css('styles.css'))
    const selectors = new Set<string>()
    root.walkRules((rule) => {
      selectors.add(rule.selector)
    })
    for (const sel of [
      '.cr-callers',
      '.cr-acct-grant-name',
      '.cr-acct-select',
      '.cr-acct-request',
      '.cr-acct-mustchange',
      '.cr-acct-secret',
      '.cr-acct-removefactor',
    ]) {
      expect([...selectors].some((s) => s.split(',').map((x) => x.trim()).includes(sel))).toBe(
        true,
      )
    }
  })

  it('no account rule reaches for the grant surface’s dark-theme tokens', () => {
    // `--cr-*` are defined nowhere in this app; every use falls back to a
    // foreign dark theme. The identity rules are the house’s own tokens only.
    const root = postcss.parse(css('styles.css'))
    const offenders: string[] = []
    root.walkRules(/cr-acct-|cr-caller|cr-pair-/, (rule) => {
      rule.walkDecls((decl) => {
        if (/var\(--cr-/.test(decl.value)) offenders.push(`${rule.selector} { ${decl.prop} }`)
      })
    })
    expect(offenders).toEqual([])
  })
})

describe('every account panel wears cr-sheet, on the panel and not only on the scrim', () => {
  it('the claim sheet, both halves', () => {
    for (const legacy of [null, { handle: 'drej' }]) {
      const html = renderToStaticMarkup(
        <ClaimSheet onClose={() => undefined} onClaimed={() => undefined} legacy={legacy} />,
      )
      expect(panels(html)).toHaveLength(1)
      expect(panels(html)[0]).toContain('cr-sheet')
    }
  })

  it('the profile sheet', () => {
    const html = renderToStaticMarkup(
      <ProfileSheet status={STATUS} onClose={() => undefined} onStatus={() => undefined} />,
    )
    expect(panels(html)).toHaveLength(1)
    expect(panels(html)[0]).toContain('cr-sheet')
  })

  it('the authenticator sheet and the pairing popout', () => {
    for (const html of [
      renderToStaticMarkup(
        <TotpSheet username="drej" onClose={() => undefined} onActive={() => undefined} />,
      ),
      renderToStaticMarkup(<PairPhoneSheet onClose={() => undefined} />),
    ]) {
      expect(panels(html)).toHaveLength(1)
      expect(panels(html)[0]).toContain('cr-sheet')
    }
  })

  it('the security overlay in AccountSurface — reached only through a state, so read at the source', () => {
    const source = readFileSync(join(RENDERER, 'account', 'AccountSurface.tsx'), 'utf8')
    expect(source).toContain('className="gs-sheet gs-small cr-sheet cr-acct-sheet"')
  })

  it('the lock card, which is not a gs-sheet but holds a gs-input and a gs-primary', () => {
    const html = renderToStaticMarkup(
      <LockScreen status={{ ...STATUS, locked: true }} onUnlocked={() => undefined} />,
    )
    expect(html).toContain('class="cr-acct-lockcard cr-sheet"')
  })
})

describe('the neutral acts are marked, the destructive ones are not', () => {
  it('PAIR A PHONE is an act in the neutral ink; REVOKE and REMOVE stay rose', () => {
    const html = renderToStaticMarkup(
      <ProfileSheet
        status={STATUS}
        initialTab="DEVICES"
        onClose={() => undefined}
        onStatus={() => undefined}
      />,
    )
    expect(html).toContain('class="gs-revoke cr-acct-act">PAIR A PHONE')
    const enrolled: FactorsView = {
      totp: true,
      passkeys: [{ id: 'pk-1', name: 'Touch ID on this Mac', addedAt: 1_757_116_800_000 }],
      mustChangePassword: false,
      registry: 'https://registry.test',
    }
    const rows = renderToStaticMarkup(
      <FactorRows
        factors={enrolled}
        onAdd={() => undefined}
        onRemove={() => undefined}
        onOpenBrowser={() => undefined}
      />,
    )
    expect(rows).toContain('class="gs-revoke">REMOVE')
    expect(rows).not.toContain('cr-acct-act')
  })
})
