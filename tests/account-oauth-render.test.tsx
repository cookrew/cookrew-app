// THE PROVIDER SURFACE PAINTS, AND ONLY WHEN IT SHOULD.
//
// A static render runs the component body, so the markup is the picture: with
// no providers there is no button, a passwordless account is never offered a
// password field, and a passcode Mac's lock asks for the right word.

import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AccountStatus } from '../src/shared/account-v2'
import { AccountSheet } from '../src/renderer/src/account/AccountSheet'
import { HandleCard } from '../src/renderer/src/account/HandleCard'
import { LockScreen } from '../src/renderer/src/account/LockScreen'
import { PasscodeCard } from '../src/renderer/src/account/PasscodeCard'
import { ProviderButtons } from '../src/renderer/src/account/ProviderButtons'
import { LinkRows } from '../src/renderer/src/account/LinkRows'
import { ResumeSession } from '../src/renderer/src/account/ResumeSession'
import {
  PROVIDER_COPY,
  handleView,
  passcodeView,
  providerRefusal,
  shouldAskPasscode,
} from '../src/renderer/src/account/provider-store'

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
  passcodePending: false,
  touchId: { available: false, on: false },
  registryMismatch: null,
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

describe('the passcode', () => {
  it('asks twice and says it stays on this Mac', () => {
    const html = renderToStaticMarkup(<PasscodeCard status={status({ passcodePending: true })} onDone={() => undefined} onLater={() => undefined} />)
    expect(html).toContain('Choose a passcode')
    expect(html).toContain(PROVIDER_COPY.PASSCODE_LOCAL)
  })

  it('holds the primary until it is long enough and repeated', () => {
    expect(passcodeView('12345', '12345').canGo).toBe(false)
    expect(passcodeView('123456', '123457').canGo).toBe(false)
    expect(passcodeView('123456', '123456').canGo).toBe(true)
  })

  it('is asked for on a Mac with none, once a sheet is out of the way, and not again this run after LATER', () => {
    expect(shouldAskPasscode(status({ passcodePending: true, locked: false }), false)).toBe(true)
    expect(shouldAskPasscode(status({ passcodePending: true, locked: false }), true)).toBe(false)
    expect(shouldAskPasscode(status({ passcodePending: false, locked: false }), false)).toBe(false)
    expect(shouldAskPasscode(null, false)).toBe(false)
  })
})

describe('the lock on a passcode Mac', () => {
  const lock = (over: Partial<AccountStatus>): string =>
    renderToStaticMarkup(<LockScreen status={status(over)} onUnlocked={() => undefined} />)

  it('asks for the passcode, never a password, and offers the rescue code', () => {
    const html = lock({})
    expect(html).toContain('placeholder="passcode"')
    expect(html).not.toContain('placeholder="password"')
    expect(html).toContain(PROVIDER_COPY.FORGOT_PASSCODE)
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
    expect(html).not.toContain(PROVIDER_COPY.FORGOT_PASSCODE)
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
