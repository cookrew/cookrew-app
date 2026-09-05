// THE AVATAR IS IN THE BAR, AND THE SHEET PAINTS — the cheapest half of "it is
// tappable on the card" (the bar grant-panel-render and gate-sheet-render keep).
//
// A static render runs the component body and every branch reachable without
// effects, and because the markup IS the picture, the picture can be asserted:
// the avatar sits inside the brand group, wears the same rose badge the BOARD
// button uses, and the claim sheet's primary is down until it should not be.

import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AccountStatus } from '../src/shared/account-v2'
import { Header } from '../src/renderer/src/Header'
import { AccountAvatar } from '../src/renderer/src/account/Avatar'
import { ClaimSheet } from '../src/renderer/src/account/ClaimSheet'
import { LockScreen } from '../src/renderer/src/account/LockScreen'
import { SecurityCard } from '../src/renderer/src/account/SecurityCard'
import { ACCOUNT_COPY } from '../src/renderer/src/account/account-store'

/**
 * The Electron bridge, as the surface feature-detects it. Set on globalThis
 * because these components run under `react-dom/server`, where there is no DOM
 * — the same stub grant-panel-render uses.
 */
function stubBridge(): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    cookrew: {
      accountStatus: async () => status(),
      accountCheck: async () => 'free',
      accountRecoveryCodes: async () => ({ ok: true, value: [] }),
      accountUnlock: async () => ({ ok: true }),
    },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  }
}
const status = (over: Partial<AccountStatus> = {}): AccountStatus => ({
  username: 'drej',
  displayName: '',
  avatar: null,
  locked: false,
  lockAfterMs: 900_000,
  requests: 0,
  envUsername: null,
  sessionExpired: false,
  workspacesReachable: true,
  ...over,
})

// Collection time as well as test time: the sheets below are painted in their
// describe bodies, which run before any hook.
stubBridge()
beforeEach(stubBridge)

const bar = (avatar: React.ReactNode): string =>
  renderToStaticMarkup(
    <Header
      workspaceName="Cookrew Dev"
      dir="/tmp"
      terminalCount={2}
      busyCount={0}
      attentionCount={0}
      view="canvas"
      onViewChange={() => undefined}
      onActivity={() => undefined}
      onResync={() => undefined}
      avatar={avatar}
    />,
  )

const brandGroup = (html: string): string => {
  const start = html.indexOf('cr-header-brand')
  const rest = html.slice(start)
  // The brand group ends where the view switch begins.
  return rest.slice(0, rest.indexOf('cr-viewseg'))
}

describe('the avatar joins the brand group, after the wordmark (D1)', () => {
  it('is inside cr-header-brand and after COOKREW', () => {
    const html = bar(<AccountAvatar status={status()} onOpen={() => undefined} />)
    const group = brandGroup(html)
    expect(group).toContain('cr-acct-avatar')
    expect(group.indexOf('COOKREW')).toBeLessThan(group.indexOf('cr-acct-avatar'))
  })

  it('changes nothing about the bar when there is no account surface', () => {
    // The phone companion and a demo tab pass null; the header must be the
    // header it is today, not a header with a hole in it.
    expect(bar(null)).not.toContain('cr-acct-')
  })
})

describe('the avatar, in three states', () => {
  it('NO ACCOUNT is a dashed circle with the hover sentence', () => {
    const html = renderToStaticMarkup(
      <AccountAvatar status={status({ username: null })} onOpen={() => undefined} />,
    )
    expect(html).toContain('cr-acct-none')
    expect(html).toContain('Claim a username')
    expect(html).toContain(ACCOUNT_COPY.NO_ACCOUNT.slice(0, 40))
    expect(html).not.toContain('cr-viewseg-badge')
  })

  it('CLAIMED is initials, with no badge', () => {
    const html = renderToStaticMarkup(<AccountAvatar status={status()} onOpen={() => undefined} />)
    expect(html).toContain('cr-acct-claimed')
    expect(html).toContain('>DR<')
    expect(html).not.toContain('cr-viewseg-badge')
  })

  it('A DEVICE WAITING wears the BOARD button’s own rose badge', () => {
    const html = renderToStaticMarkup(
      <AccountAvatar status={status({ requests: 1 })} onOpen={() => undefined} />,
    )
    // The same class, deliberately: two badge styles for "something needs you"
    // would leave neither meaning anything.
    expect(html).toContain('cr-viewseg-badge cr-acct-badge')
    expect(html).toContain('>1<')
  })

  it('draws an uploaded picture instead of the initials', () => {
    const html = renderToStaticMarkup(
      <AccountAvatar
        status={status({ avatar: 'https://x.test/a.png' })}
        onOpen={() => undefined}
      />,
    )
    expect(html).toContain('cr-acct-face')
    expect(html).not.toContain('cr-acct-initials')
  })
})

describe('the claim sheet paints, and refuses in sentences (D2)', () => {
  const html = renderToStaticMarkup(
    <ClaimSheet onClose={() => undefined} onClaimed={() => undefined} />,
  )

  it('asks for the name, then the thing that protects it', () => {
    expect(html.indexOf('Username')).toBeLessThan(html.indexOf('Password'))
    expect(html).toContain('type="password"')
  })

  it('states the password rule beside the field', () => {
    expect(html).toContain('At least 12 characters')
    expect(html).toContain('only to cookrew.dev')
  })

  it('starts with the primary DOWN', () => {
    expect(html).toMatch(/<button class="gs-primary" disabled=""/)
  })

  it('offers NOT NOW, and says what it keeps', () => {
    expect(html).toContain('NOT NOW')
    expect(html).toContain(ACCOUNT_COPY.NOT_NOW)
  })
})

describe('the security card is honest about what is coming (D3)', () => {
  const html = renderToStaticMarkup(
    <SecurityCard username="drej" lockAfterMs={900_000} onLockAfterMs={() => undefined} />,
  )

  it('offers passkey and authenticator as COMING, and inert', () => {
    expect(html).toContain('Add a passkey (Touch ID)')
    expect(html).toContain('Add an authenticator app')
    expect(html.match(/COMING/g)).toHaveLength(2)
    expect(html.match(/disabled=""/g)).toHaveLength(2)
  })

  it('offers the one factor it can give, and the one lock it can enforce', () => {
    expect(html).toContain('Save your recovery codes')
    expect(html).toContain('>SHOW<')
    expect(html).toContain('Lock Cookrew after 15 min idle')
    expect(html).toContain('>ON<')
  })

  it('says why a second factor is worth it', () => {
    expect(html).toContain(ACCOUNT_COPY.SECURITY_WHY)
  })

  it('says OFF when the idle lock is off', () => {
    const off = renderToStaticMarkup(
      <SecurityCard username="drej" lockAfterMs={0} onLockAfterMs={() => undefined} />,
    )
    expect(off).toContain('>OFF<')
  })
})

describe('the lock screen (D5)', () => {
  const html = renderToStaticMarkup(
    <LockScreen status={status({ locked: true })} onUnlocked={() => undefined} />,
  )

  it('says why it is locked and that the agents kept working', () => {
    expect(html).toContain('Locked while you were away. Your agents kept working.')
  })

  it('takes a password, and nothing else', () => {
    expect(html).toContain('type="password"')
    expect(html).toContain('UNLOCK')
    // TOUCH ID IS HIDDEN until a passkey exists (phase 4). An inert Touch ID
    // button on the screen a locked-out person meets is the cruellest place
    // to put a control that does nothing.
    expect(html).not.toContain('TOUCH ID')
  })

  it('covers the canvas as its own layer, not as a sheet', () => {
    expect(html).toContain('cr-acct-lock')
    expect(html).toContain('aria-modal="true"')
  })
})
