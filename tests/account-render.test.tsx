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
import { ProfileSheet } from '../src/renderer/src/account/ProfileSheet'
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
/** A complete status; `over` is spread over it so the result stays AccountStatus
 *  rather than every field widening to include undefined. */
const BASE: AccountStatus = {
  username: 'drej',
  displayName: '',
  avatar: null,
  locked: false,
  lockAfterMs: 900_000,
  requests: 0,
  envUsername: null,
  sessionExpired: false,
  workspacesReachable: true,
  recoveryCodesSavedAt: null,
  recoveryCodesLeft: null,
}

const status = (over: Partial<AccountStatus> = {}): AccountStatus => ({ ...BASE, ...over })

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

const card = (over: Partial<React.ComponentProps<typeof SecurityCard>> = {}): string =>
  renderToStaticMarkup(
    <SecurityCard
      username="drej"
      lockAfterMs={900_000}
      recoveryCodesSavedAt={null}
      onLockAfterMs={() => undefined}
      onLockNow={() => undefined}
      onCodesSaved={() => undefined}
      {...over}
    />,
  )

describe('the security card is honest about what is coming (D3)', () => {
  const html = card()

  it('offers passkey and authenticator as COMING, and inert', () => {
    expect(html).toContain('Add a passkey (Touch ID)')
    expect(html).toContain('Add an authenticator app')
    expect(html.match(/COMING/g)).toHaveLength(2)
    expect(html.match(/disabled=""/g)).toHaveLength(2)
  })

  it('draws the COMING rows VISIBLY disabled, not as live rows', () => {
    // They used to be the same grey as the working rows: a person clicks, gets
    // nothing, and the card loses its claim to be describing their account.
    expect(html.match(/cr-acct-secrow cr-acct-coming/g)).toHaveLength(2)
    expect(html.match(/cr-acct-secstate cr-acct-soon/g)).toHaveLength(2)
    // A live row carries neither marker.
    expect(html).toContain('<li class="cr-acct-secrow"><span class="cr-acct-kind">RESCUE')
  })

  it('says why a second factor is worth it', () => {
    expect(html).toContain(ACCOUNT_COPY.SECURITY_WHY)
  })
})

describe('the lock can be set AND reached from the card', () => {
  it('offers the five delays, with the current one selected', () => {
    const html = card({ lockAfterMs: 300_000 })
    for (const label of ['1 min', '5 min', '15 min', '30 min', 'off']) {
      expect(html).toContain(`>${label}</option>`)
    }
    expect(html).toContain('<option value="300000" selected="">5 min</option>')
    expect(html).toContain('Lock Cookrew after 5 min idle')
  })

  it('offers LOCK NOW — a lock you can only meet by walking away is not one', () => {
    expect(card()).toContain('LOCK NOW')
    expect(card()).toContain('Lock this Mac now')
  })

  it('says the delay is off without pretending the row is gone', () => {
    const off = card({ lockAfterMs: 0 })
    expect(off).toContain('<option value="0" selected="">off</option>')
    expect(off).toContain('Lock Cookrew when idle')
    expect(off).toContain('LOCK NOW')
  })
})

describe('the RESCUE row tracks what was actually saved', () => {
  it('says NOT SAVED, with SHOW, before anything happened', () => {
    const html = card()
    expect(html).toContain('NOT SAVED')
    expect(html).toContain('>SHOW<')
  })

  it('says when they were saved, with a check, and offers SHOW NEW', () => {
    const html = card({ recoveryCodesSavedAt: 1_757_116_800_000 })
    expect(html).not.toContain('NOT SAVED')
    expect(html).toContain('Saved ')
    expect(html).toContain('✓')
    expect(html).toContain('SHOW NEW')
  })

  it('adds the registry’s remaining count when it sent one', () => {
    expect(card({ recoveryCodesSavedAt: 1_757_116_800_000, recoveryCodesLeft: 6 })).toContain(
      '6 left',
    )
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

describe('the profile sheet (D4)', () => {
  const sheet = (over: Partial<React.ComponentProps<typeof ProfileSheet>> = {}): string =>
    renderToStaticMarkup(
      <ProfileSheet
        status={status()}
        onClose={() => undefined}
        onStatus={() => undefined}
        {...over}
      />,
    )

  it('shows all five tabs, so a person knows where a thing will appear', () => {
    const html = sheet()
    // `&` arrives escaped, as it must in markup.
    for (const tab of ['PROFILE', 'DEVICES', 'SECURITY', 'WORKSPACES', 'SEATS &amp; TEAMS']) {
      expect(html).toContain(tab)
    }
  })

  it('offers EDIT for the display name — the one profile fact this phase can change', () => {
    expect(sheet()).toContain('>EDIT<')
  })

  it('says No seats yet. rather than leaving the tab blank', () => {
    expect(sheet({ initialTab: 'SEATS & TEAMS' })).toContain('No seats yet.')
  })

  it('says what leaves this Mac before offering the reachability toggle', () => {
    const html = sheet({ initialTab: 'WORKSPACES' })
    expect(html).toContain('Reachable from my other devices')
    expect(html).toContain('Names and ids only leave this Mac')
    // Recorded program decision: reachability defaults ON.
    expect(html).toContain('checked=""')
  })
})
