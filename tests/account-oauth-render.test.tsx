// THE PROVIDER SURFACE PAINTS, AND ONLY WHEN IT SHOULD.
//
// A static render runs the component body, so the markup is the picture: with
// no providers there is no button, a passwordless account is never offered a
// password field, and a passcode Mac's lock asks for the right word.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AccountStatus } from '../src/shared/account-v2'
import { AccountSheet } from '../src/renderer/src/account/AccountSheet'
import { HandleCard } from '../src/renderer/src/account/HandleCard'
import { LockScreen } from '../src/renderer/src/account/LockScreen'
import { AccountPasswordCard } from '../src/renderer/src/account/AccountPasswordCard'
import { ProviderButtons, TripWait } from '../src/renderer/src/account/ProviderButtons'
import { LinkRows } from '../src/renderer/src/account/LinkRows'
import { ResumeSession } from '../src/renderer/src/account/ResumeSession'
import {
  PROVIDER_COPY,
  handleView,
  firstPasswordView,
  providerRefusal,
  shouldAskAccountPassword,
  tripGuard,
} from '../src/renderer/src/account/provider-store'
import { SecurityCard } from '../src/renderer/src/account/SecurityCard'

const GITHUB = { id: 'github', label: 'GitHub', device: true } as const
const GOOGLE = { id: 'google', label: 'Google', device: false } as const

const status = (over: Partial<AccountStatus> = {}): AccountStatus => ({
  username: 'octo',
  displayName: 'octo',
  avatar: null,
  locked: true,
  lockAfterMs: 900_000,
  requests: 0,
  envUsername: null,
  legacy: null,
  sessionExpired: false,
  passwordPending: false,
  passwordless: true,
  unlockBy: 'passcode',
  lockWaits: null,
  fromTerminal: false,
  touchId: { available: false, on: false },
  registryMismatch: null,
  signInAgainBecause: null,
  workspacesReachable: true,
  recoveryCodesSavedAt: null,
  recoveryCodesLeft: null,
  ...over,
})

beforeEach(() => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    cookrew: { accountStatus: () => Promise.resolve(status()) },
  }
})

describe('the buttons', () => {
  it('are absent with no provider: nothing renders at all', () => {
    expect(renderToStaticMarkup(<ProviderButtons offers={[]} waiting={null} onStart={() => undefined} onCancel={() => undefined} />)).toBe('')
  })

  it('name each provider, GitHub first as the registry orders them', () => {
    const html = renderToStaticMarkup(
      <ProviderButtons offers={[GITHUB, GOOGLE]} waiting={null} onStart={() => undefined} onCancel={() => undefined} />,
    )
    expect(html).toContain('CONTINUE WITH GITHUB')
    expect(html).toContain('CONTINUE WITH GOOGLE')
    expect(html.indexOf('GITHUB')).toBeLessThan(html.indexOf('GOOGLE'))
  })

  it('while waiting say where the person went, and offer a way out', () => {
    const html = renderToStaticMarkup(
      <ProviderButtons offers={[GITHUB]} waiting="github" onStart={() => undefined} onCancel={() => undefined} />,
    )
    expect(html).toContain('Finish in your browser')
    expect(html).toContain('CANCEL')
    expect(html).not.toContain('CONTINUE WITH GITHUB')
  })

  it('the sheet opens with none, so an unconfigured registry draws no button', () => {
    expect(renderToStaticMarkup(<AccountSheet onClose={() => undefined} onDone={() => undefined} />)).not.toContain('CONTINUE WITH')
  })
})

describe('choosing a handle', () => {
  it('prefills the provider name and says it is only a suggestion', () => {
    const html = renderToStaticMarkup(
      <HandleCard asked={{ provider: 'github', suggest: 'octo-cat', free: true, email: 'o@x.dev' }} onDone={() => undefined} onBack={() => undefined} />,
    )
    expect(html).toContain('value="octo-cat"')
    expect(html).toContain('o@x.dev')
    expect(html).toContain(PROVIDER_COPY.ALREADY_HAVE)
  })

  it('a clash blocks the primary and asks; a free name goes', () => {
    expect(handleView('octo', 'taken').canGo).toBe(false)
    expect(handleView('octo', 'taken').note).toContain('taken')
    expect(handleView('octo', 'free').canGo).toBe(true)
    expect(handleView('Octo Cat', 'invalid').canGo).toBe(false)
    expect(handleView('octo', 'checking').canGo).toBe(false)
  })
})

describe('no passcode is asked for any more (owner, 2026-11-09)', () => {
  it('a provider-only account is asked for its ACCOUNT password, which becomes this Mac’s lock', () => {
    const html = renderToStaticMarkup(
      <AccountPasswordCard status={status({ lockWaits: 'set-password', unlockBy: 'password' })} onDone={() => undefined} onLater={() => undefined} />
    )
    expect(html).toContain('Set your account password')
    expect(html).toContain(PROVIDER_COPY.ACCOUNT_PASSWORD_WHY)
    expect(html.toLowerCase()).not.toContain('passcode')
  })

  it('holds the primary until it is twelve characters and repeated', () => {
    expect(firstPasswordView('short one', 'short one').canGo).toBe(false)
    expect(firstPasswordView('twelve chars ok', 'twelve chars no').canGo).toBe(false)
    expect(firstPasswordView('twelve chars ok', 'twelve chars ok').canGo).toBe(true)
  })

  it('is asked only on a machine a person signed in at, only for an account with no password, not again after LATER', () => {
    const ask = (over: Partial<AccountStatus>, later = false): boolean =>
      shouldAskAccountPassword(status({ locked: false, unlockBy: 'password', ...over }), later)
    expect(ask({ lockWaits: 'set-password', fromTerminal: false })).toBe(true)
    expect(ask({ lockWaits: 'set-password', fromTerminal: false }, true)).toBe(false)
    // `cookrew login`: nobody can type at that screen, so no modal at all.
    expect(ask({ lockWaits: 'set-password', fromTerminal: true })).toBe(false)
    // The account has a password: nothing is asked up front.
    expect(ask({ lockWaits: null })).toBe(false)
    expect(ask({ lockWaits: 'type-password', fromTerminal: true })).toBe(false)
    expect(shouldAskAccountPassword(null, false)).toBe(false)
  })
})

describe('the lock on a Mac that CHOSE a passcode before there were none', () => {
  const lock = (over: Partial<AccountStatus>): string =>
    renderToStaticMarkup(<LockScreen status={status(over)} onUnlocked={() => undefined} />)

  it('asks for the passcode, never a password, and offers the rescue code', () => {
    const html = lock({})
    expect(html).toContain('placeholder="passcode"')
    expect(html).not.toContain('placeholder="password"')
    expect(html).toContain(PROVIDER_COPY.CHOSEN_PASSCODE_FORGOT)
  })

  it('offers Touch ID only when it is on', () => {
    expect(lock({})).not.toContain('USE TOUCH ID')
    expect(lock({ touchId: { available: true, on: true } })).toContain('USE TOUCH ID')
  })

  it('never offers the provider', () => {
    expect(lock({})).not.toContain('CONTINUE WITH')
  })

  it('a password Mac is unchanged', () => {
    const html = lock({ passwordless: false, unlockBy: 'password' })
    expect(html).toContain('placeholder="password"')
    expect(html).not.toContain(PROVIDER_COPY.CHOSEN_PASSCODE_FORGOT)
  })
})

describe('a session that ended', () => {
  it('asks a passwordless account for no password', () => {
    const html = renderToStaticMarkup(<ResumeSession passwordless onResumed={() => undefined} />)
    expect(html).not.toContain('type="password"')
    expect(html).toContain(PROVIDER_COPY.SESSION_ENDED)
  })

  it('still asks a password account for its password', () => {
    expect(renderToStaticMarkup(<ResumeSession onResumed={() => undefined} />)).toContain('type="password"')
  })
})

describe('the security rows', () => {
  const rows = (over: Partial<Parameters<typeof LinkRows>[0]>): string =>
    renderToStaticMarkup(
      <ul>
        <LinkRows
          offers={[GITHUB, GOOGLE]}
          links={[]}
          email={null}
          status={status({ locked: false })}
          onStatus={() => undefined}
          onChanged={() => undefined}
          {...over}
        />
      </ul>,
    )

  it('offer to link what is not linked, and say which is', () => {
    const html = rows({ links: [{ provider: 'github', login: 'octo', linkedAt: 1, paused: false }] })
    expect(html).toContain('REMOVE')
    expect(html).toContain('LINK')
    expect(html).toContain('octo')
  })

  it('name a paused link and the way back', () => {
    expect(rows({ links: [{ provider: 'github', login: 'octo', linkedAt: 1, paused: true }] })).toContain('LINK AGAIN')
  })

  it('show a verified email with where it came from, and no field to type one', () => {
    const html = rows({ email: { address: 'o@x.dev', via: 'github', verifiedAt: 1 } })
    expect(html).toContain('o@x.dev')
    expect(html).toContain('Verified by GitHub')
    expect(html).not.toContain('type="email"')
  })

  it('draw nothing about linking with no provider and no link', () => {
    expect(rows({ offers: [] })).not.toContain('LINK')
  })

  it('offer Touch ID only where it is available', () => {
    expect(rows({})).not.toContain('Touch ID')
    expect(rows({ status: status({ locked: false, touchId: { available: true, on: false } }) })).toContain('Touch ID')
  })

  it('a password Mac gets no passcode row', () => {
    expect(rows({ status: status({ locked: false, passwordless: false, unlockBy: 'password' }) })).not.toContain('passcode')
  })
})

describe('review: a trip belongs to the surface that started it', () => {
  it('leaving cancels a trip in flight, once, and an ended trip is left alone', () => {
    const cancels: number[] = []
    const guard = tripGuard(() => cancels.push(1))
    guard.leave()
    expect(cancels).toHaveLength(0)
    guard.begin()
    guard.end()
    guard.leave()
    expect(cancels).toHaveLength(0)
    guard.begin()
    guard.leave()
    guard.leave()
    expect(cancels).toHaveLength(1)
  })
})

describe('review: every surface that can start a trip owns it', () => {
  it('two trips at once: one ending does not disarm the other', () => {
    const cancels: number[] = []
    const guard = tripGuard(() => cancels.push(1))
    guard.begin()
    guard.begin()
    guard.end()
    guard.leave()
    expect(cancels).toHaveLength(1)
  })

  it('a trip that ended late cannot disarm the one that replaced it', () => {
    const cancels: number[] = []
    const guard = tripGuard(() => cancels.push(1))
    const stale = guard.begin()
    guard.leave()
    guard.begin()
    guard.end(stale)
    guard.leave()
    expect(cancels).toHaveLength(2)
  })

  it('the rescue row says the code is spent whatever happens next', () => {
    expect(PROVIDER_COPY.LOST_PROVIDER_WHY).toContain('even if you cancel')
  })

  it('the cards a provider proof runs behind all hold a guard', () => {
    for (const file of ['SecurityCard', 'TotpSheet', 'SeatsTab', 'LinkRows', 'ProfileSheet']) {
      const source = readFileSync(path.join(process.cwd(), `src/renderer/src/account/${file}.tsx`), 'utf8')
      expect(source, file).toMatch(/useTripGuard\(\)|useWatchedTrip\(/)
    }
  })

  it('the wait names where the person went, with a way out', () => {
    const html = renderToStaticMarkup(<TripWait shown onCancel={() => undefined} />)
    expect(html).toContain(PROVIDER_COPY.WAITING)
    expect(html).toContain('CANCEL')
    expect(renderToStaticMarkup(<TripWait shown={false} onCancel={() => undefined} />)).toBe('')
  })
})

describe('a lock that waits (owner, 2026-11-09)', () => {
  const rows = (over: Partial<AccountStatus>): string =>
    renderToStaticMarkup(
      <ul>
        <LinkRows offers={[]} links={[]} email={null} status={status({ locked: false, unlockBy: 'password', ...over })} onStatus={() => undefined} onChanged={() => undefined} />
      </ul>
    )

  it('a machine signed in from a terminal says so in its rows and takes the account password typed once', () => {
    const html = rows({ passwordless: false, lockWaits: 'type-password', fromTerminal: true })
    expect(html).toContain(PROVIDER_COPY.LOCK_WAITS_TYPE)
    expect(html).toContain('TURN THE LOCK ON')
    expect(html.toLowerCase()).not.toContain('passcode')
  })

  it('a provider-only account is pointed at setting its password, never at a passcode', () => {
    const html = rows({ passwordless: true, lockWaits: 'set-password', fromTerminal: true })
    expect(html).toContain(PROVIDER_COPY.LOCK_WAITS_SET)
    expect(html).not.toContain('CHOOSE')
    expect(html.toLowerCase()).not.toContain('passcode')
  })

  it('LOCK NOW is not offered while there is nothing to unlock with', () => {
    const card = (over: Partial<AccountStatus>): string =>
      renderToStaticMarkup(
        <SecurityCard
          username="octo"
          lockAfterMs={900_000}
          recoveryCodesSavedAt={null}
          status={status({ locked: false, ...over })}
          onLockAfterMs={() => undefined}
          onLockNow={() => undefined}
          onCodesSaved={() => undefined}
        />,
      )
    expect(card({ lockWaits: 'set-password' })).not.toContain('LOCK NOW')
    expect(card({ lockWaits: 'type-password' })).not.toContain('LOCK NOW')
    expect(card({ lockWaits: null })).toContain('LOCK NOW')
  })
})

describe('words', () => {
  it('a cancelled sign-in is not an error', () => {
    expect(providerRefusal('cancelled')).toBeNull()
  })

  it('each refusal keeps its own sentence, and the registry wins', () => {
    expect(providerRefusal('link_taken')).toContain('another Cookrew account')
    expect(providerRefusal('wrong_identity')).toContain('this Mac')
    expect(providerRefusal('link_taken', 'From the registry.')).toBe('From the registry.')
  })
})
