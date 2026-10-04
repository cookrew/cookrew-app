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
import { AccountSheet } from '../src/renderer/src/account/AccountSheet'
import { FirstRunCard } from '../src/renderer/src/account/FirstRunCard'
import { JoinCard } from '../src/renderer/src/account/JoinCard'
import { LockScreen } from '../src/renderer/src/account/LockScreen'
import { SecurityCard } from '../src/renderer/src/account/SecurityCard'
import { ProfileSheet } from '../src/renderer/src/account/ProfileSheet'
import { ResumeSession } from '../src/renderer/src/account/ResumeSession'
import { ACCOUNT_COPY, firstRunView } from '../src/renderer/src/account/account-store'

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
  legacy: null,
  sessionExpired: false,
  passwordPending: false,
  registryMismatch: null,
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
      onWall={() => undefined}
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
  it('NO ACCOUNT is a dashed circle with the hover sentence, named for the door it opens', () => {
    const html = renderToStaticMarkup(
      <AccountAvatar status={status({ username: null })} onOpen={() => undefined} />,
    )
    expect(html).toContain('cr-acct-none')
    expect(html).toContain('Sign in or create an account')
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

describe('the account sheet opens on SIGN IN, and paints the create side under a tab (D9)', () => {
  const html = renderToStaticMarkup(
    <AccountSheet onClose={() => undefined} onDone={() => undefined} />,
  )

  it('SIGN IN is the default tab, CREATE ACCOUNT the other', () => {
    expect(html).toMatch(/role="tab" aria-selected="true"[^>]*>SIGN IN</)
    expect(html).toMatch(/role="tab" aria-selected="false"[^>]*>CREATE ACCOUNT</)
    expect(html).toContain(ACCOUNT_COPY.SIGNIN_USERNAME_HINT)
    expect(html).toContain('CONTINUE')
  })

  it('labels the field "Username" — not "Username or email"', () => {
    expect(html).toContain('>Username<')
    expect(html).not.toContain('Username or email')
  })

  it('asks for the name, then the password, and measures nothing on the sign-in side', () => {
    expect(html.indexOf('Username')).toBeLessThan(html.indexOf('Password'))
    expect((html.match(/type="password"/g) ?? []).length).toBe(1)
    expect(html).not.toContain('At least 12 characters')
  })

  it('starts with the primary DOWN', () => {
    expect(html).toMatch(/<button class="gs-primary" disabled=""/)
  })

  it('offers NOT NOW, and says what it keeps', () => {
    expect(html).toContain('NOT NOW')
    expect(html).toContain(ACCOUNT_COPY.NOT_NOW)
  })

  it('the create side is D2: the rule beside the password, and the repeat', () => {
    const create = renderToStaticMarkup(
      <AccountSheet initial="register" onClose={() => undefined} onDone={() => undefined} />,
    )
    expect(create).toMatch(/role="tab" aria-selected="true"[^>]*>CREATE ACCOUNT</)
    expect(create).toContain('At least 12 characters')
    expect(create).toContain('only to cookrew.dev')
    expect((create.match(/type="password"/g) ?? []).length).toBe(2)
    expect(create).toContain('>CREATE<')
  })
})

/**
 * THE SAME SHEET ON A MAC THAT IS ALREADY SOMEBODY (phase 6).
 *
 * The name is not a field: it is the handle this Mac's key holds and the
 * doors are published under. What the sheet must show is that nothing is at
 * stake here — the name is already theirs, and only the password is missing.
 */
describe('the account sheet, for a handle from before passwords', () => {
  const crossing = renderToStaticMarkup(
    <AccountSheet onClose={() => undefined} onDone={() => undefined} legacy={{ handle: 'drej' }} />,
  )

  it('says the name is already yours, in the copy table’s words', () => {
    expect(crossing).toContain('You are @drej here already — set a password to keep it.')
  })

  it('does not offer the name as something to type, and offers no tabs', () => {
    expect(crossing).toContain('readonly=""')
    expect(crossing).toContain('@drej')
    expect(crossing).not.toContain('placeholder="@drej"')
    expect(crossing).not.toContain('role="tab"')
  })

  it('is the password half of D2 — the rule, the confirmation, and nothing else', () => {
    expect(crossing).toContain('At least 12 characters')
    expect((crossing.match(/type="password"/g) ?? []).length).toBe(2)
    expect(crossing).toContain('SET A PASSWORD')
    expect(crossing).not.toContain('CREATE')
  })

  it('starts with the primary DOWN, like every other sheet here', () => {
    expect(crossing).toMatch(/<button class="gs-primary" disabled=""/)
  })

  it('says what NOT NOW keeps for a Mac that is serving', () => {
    expect(crossing).toContain(ACCOUNT_COPY.LEGACY_KEEP_SERVING)
    expect(crossing).toContain('serving under the name it has')
  })
})

describe('the first-run card paints as a card, not a wall (D8)', () => {
  const view = firstRunView({
    status: status({ username: null }),
    workspaceCount: 1,
    dismissed: false,
  })
  const html = view === null ? '' : renderToStaticMarkup(<FirstRunCard view={view} onAction={() => undefined} />)

  it('has no scrim and no dialog role: the canvas behind it keeps working', () => {
    expect(html).not.toContain('gs-scrim')
    expect(html).not.toContain('aria-modal')
    expect(html).toContain('cr-acct-firstrun')
  })

  it('offers the three buttons and a close, and no JOIN in cut 1', () => {
    expect(html).toContain('SIGN IN WITH PASSWORD')
    expect(html).toContain('CREATE AN ACCOUNT')
    expect(html).toContain('NOT NOW')
    expect(html).toContain('aria-label="Close"')
    expect(html).not.toContain('>JOIN<')
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

describe('the security card offers the whole ladder (D3)', () => {
  const html = card()

  it('offers passkey first and RECOMMENDED, then the authenticator — both live', () => {
    expect(html).toContain('Add a passkey (Touch ID)')
    expect(html).toContain('Add an authenticator app')
    expect(html.indexOf('passkey')).toBeLessThan(html.indexOf('authenticator'))
    // The ruling puts the passkey first and recommends only that one.
    expect(html.match(/RECOMMENDED/g)).toHaveLength(1)
    // PHASE 4 TURNED THESE ON. Nothing on this card is inert any more, so a
    // disabled attribute here would mean a row that cannot do what it says.
    expect(html).not.toContain('COMING')
    expect(html).not.toContain('disabled=""')
    expect(html.match(/>ADD</g)).toHaveLength(2)
  })

  it('draws NO muted row at all — the COMING pair is what phase 4 replaced', () => {
    // The fix-up drew the inert rows grey with a dashed badge so nobody spent
    // a click on them. Phase 4 removes the reason: every factor row now does
    // what it says, so a muted marker here would be describing an account
    // state that no longer exists.
    expect(html).not.toContain('cr-acct-coming')
    expect(html).not.toContain('cr-acct-soon')
    expect(html).toContain('<li class="cr-acct-secrow"><span class="cr-acct-kind">FACTOR')
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

  it('says nothing about requests when nobody is waiting', () => {
    expect(html).not.toContain('waiting to join')
  })
})

describe('the lock screen knows who is waiting (D13)', () => {
  // The count rides the status and is on screen at once; the names take a
  // read the server renderer never makes, so the sentence here is the
  // count-only one — which is exactly what the first paint shows.
  const one = renderToStaticMarkup(
    <LockScreen status={status({ locked: true, requests: 1 })} onUnlocked={() => undefined} />,
  )
  const three = renderToStaticMarkup(
    <LockScreen status={status({ locked: true, requests: 3 })} onUnlocked={() => undefined} />,
  )

  it('says a device is waiting, beside the reason it is locked', () => {
    expect(one).toContain('Locked while you were away. Your agents kept working.')
    expect(one).toContain('A device is waiting to join — unlock to answer.')
    expect(one).toContain('cr-acct-lock-waiting')
  })

  it('counts several', () => {
    expect(three).toContain('3 devices are waiting to join — unlock to answer.')
  })

  it('offers nothing to approve from under the lock', () => {
    for (const html of [one, three]) {
      expect(html).not.toContain('APPROVE')
      expect(html).not.toContain('NOT ME')
      expect(html.match(/<button/g)?.length).toBe(1) // UNLOCK, and only UNLOCK
    }
  })
})

describe('the Devices tab knows which Mac it is on (v3, D12)', () => {
  const devices = [
    { id: 'dev-here', kind: 'desktop' as const, name: 'MacBook Pro · drej-mbp', addedAt: 1, lastSeenAt: Date.now(), current: true },
    { id: 'dev-there', kind: 'desktop' as const, name: 'Mac Studio · studio', addedAt: 1, lastSeenAt: Date.now(), current: false },
    { id: 'dev-phone', kind: 'phone' as const, name: 'iPhone', addedAt: 1, lastSeenAt: Date.now(), current: false },
  ]
  const html = renderToStaticMarkup(
    <ProfileSheet
      status={status()}
      initialTab="DEVICES"
      initialProfile={{ username: 'drej', displayName: '', avatar: null, claimedAt: 1, devices, desktops: [] }}
      onClose={() => undefined}
      onStatus={() => undefined}
    />,
  )

  it('marks this Mac, and gives it the one verb that is its own', () => {
    expect(html).toContain('THIS MAC')
    expect(html).not.toContain('THIS DEVICE')
    expect(html.match(/SIGN OUT ON THIS MAC/g)?.length).toBe(1)
  })

  it('offers REVOKE on every other device and never on this one', () => {
    // Two other devices, two REVOKE buttons — and the confirmation's own
    // REVOKE is not on screen until a row is opened.
    expect(html.match(/>REVOKE</g)?.length).toBe(2)
  })

  it('shows the names as "<model> · <host>", distinguishable at a glance', () => {
    expect(html).toContain('MacBook Pro · drej-mbp')
    expect(html).toContain('Mac Studio · studio')
  })

  it('renders ADD A MAC and ADD A PHONE live now that cut 2 ships them (V3-10)', () => {
    for (const verb of ['ADD A MAC', 'ADD A PHONE']) {
      const button = html.match(new RegExp(`<button[^>]*>${verb}</button>`))?.[0]
      expect(button, verb).toBeDefined()
      // They were disabled with "Coming in cut 2" while there was no route
      // behind them. There is one now, so the placeholder is gone with it.
      expect(button).not.toContain('disabled=""')
      expect(button).not.toContain('Coming in cut 2')
    }
    expect(html).not.toContain('Coming in cut 2')
  })

  it('mints nothing until ADD is pressed — the panel is closed on open', () => {
    expect(html).not.toContain('Type your password to make a code')
    expect(html).not.toContain('MAKE A CODE')
    expect(html).not.toContain('cr-acct-addmac')
  })

  it('asks for nothing until a verb is pressed', () => {
    expect(html).not.toContain('type="password"')
    expect(html).not.toContain('Everything on the canvas stays')
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

/**
 * THE SENTENCE NEVER COMES ALONE.
 *
 * The live bug in one line: "Your session ended. Type your password once and
 * this carries on." was on screen with nowhere to type it, because
 * `sessionExpired` was derived from the token's clock and the surface had no
 * field to offer even when it was true. So the invariant asserted here is not
 * "the resume card renders" — it is that WHEREVER that sentence appears, a
 * password input appears with it.
 */
const saysSessionEnded = (html: string): boolean => html.includes(ACCOUNT_COPY.SESSION_ENDED)
const offersAPassword = (html: string): boolean => html.includes('type="password"')

describe('a session cookrew.dev threw away is answerable on screen', () => {
  it('the resume card is the sentence AND the field, never one of them', () => {
    const html = renderToStaticMarkup(<ResumeSession onResumed={() => undefined} />)
    expect(saysSessionEnded(html)).toBe(true)
    expect(offersAPassword(html)).toBe(true)
    expect(html).toContain('CARRY ON')
  })

  it('the profile sheet grows the field the moment the session is expired', () => {
    const before = renderToStaticMarkup(
      <ProfileSheet status={status()} onClose={() => undefined} onStatus={() => undefined} />,
    )
    expect(saysSessionEnded(before)).toBe(false)

    const after = renderToStaticMarkup(
      <ProfileSheet
        status={status({ sessionExpired: true })}
        onClose={() => undefined}
        onStatus={() => undefined}
      />,
    )
    expect(saysSessionEnded(after)).toBe(true)
    expect(offersAPassword(after)).toBe(true)
  })

  it('carries the field on EVERY tab, not only the one it was noticed on', () => {
    for (const tab of ['PROFILE', 'DEVICES', 'SECURITY', 'WORKSPACES'] as const) {
      const html = renderToStaticMarkup(
        <ProfileSheet
          status={status({ sessionExpired: true })}
          initialTab={tab}
          onClose={() => undefined}
          onStatus={() => undefined}
        />,
      )
      expect(saysSessionEnded(html), `${tab} says it`).toBe(true)
      expect(offersAPassword(html), `${tab} offers a field`).toBe(true)
    }
  })

  it('the security card alone never says it — it has no field to offer', () => {
    // The guarantee that makes the invariant hold: the sentence lives in
    // ResumeSession and nowhere else, so no card can print it on its own.
    expect(saysSessionEnded(card({ sessionExpired: true }))).toBe(false)
  })
})

describe('the card a join code opens (v3, D8)', () => {
  const html = renderToStaticMarkup(
    <JoinCard code="7KQ4-M2XB" onJoined={() => undefined} onDismiss={() => undefined} />,
  )

  it('asks, shows the code it is about to spend, and offers both answers', () => {
    expect(html).toContain(ACCOUNT_COPY.JOIN_TITLE)
    expect(html).toContain(ACCOUNT_COPY.JOIN_LEDE)
    expect(html).toContain('7KQ4-M2XB')
    expect(html).toContain('>JOIN</button>')
    expect(html).toContain('>NOT NOW</button>')
    expect(html).toContain(ACCOUNT_COPY.JOIN_ONCE)
  })

  it('does not name a handle it cannot know yet', () => {
    // The link carries eight characters. The account's name arrives in the
    // registry's 201 — the mock's "JOIN @DREJ ON THIS MAC?" would be this
    // Mac inventing one.
    expect(html).not.toContain('@')
  })

  it('spends nothing by being on screen — the code has to be pressed', () => {
    // A static render runs the component body. If it reached for the bridge,
    // this would have thrown on a window without one.
    expect(html).toContain('cr-acct-joincode')
  })
})

describe('the first-run card’s JOIN half (v3, D8)', () => {
  // A fresh Mac: no account, and only the seeded workspace.
  const view = firstRunView({
    status: status({ username: null }),
    workspaceCount: 1,
    dismissed: false,
  })

  it('draws a field and a JOIN when there is somewhere for a code to go', () => {
    if (view === null) throw new Error('the first-run card should be placed here')
    const html = renderToStaticMarkup(
      <FirstRunCard view={view} onAction={() => undefined} onJoin={() => undefined} />,
    )
    expect(html).toContain(ACCOUNT_COPY.FIRST_RUN_JOIN_ASK)
    expect(html).toContain(ACCOUNT_COPY.FIRST_RUN_JOIN_HOW)
    expect(html).toContain('placeholder="7KQ4-M2XB"')
    // Empty is not a code, so the button starts refused rather than sending
    // nothing to the registry.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>JOIN<\/button>/)
  })

  it('draws no field at all when there is nowhere for a code to go', () => {
    if (view === null) throw new Error('the first-run card should be placed here')
    const html = renderToStaticMarkup(<FirstRunCard view={view} onAction={() => undefined} />)
    expect(html).not.toContain(ACCOUNT_COPY.FIRST_RUN_JOIN_ASK)
    expect(html).not.toContain('placeholder="7KQ4-M2XB"')
  })
})
