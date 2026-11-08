// THE ONE SIGN-IN PAGE, AS THE SHEETS DRAW IT.
//
// A static render runs the component body, so the markup is the picture: with
// the page offered the sheet asks for no password and draws one way out to the
// browser; with the bridge missing it, or once a registry has said it has no
// page, the sheet is exactly what it was. The trip itself is a plain async
// function, so how each answer lands is tested here without a DOM.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AccountStatus, SignInAnswer } from '../src/shared/account-v2'
import { AccountSheet } from '../src/renderer/src/account/AccountSheet'
import { ResumeSession } from '../src/renderer/src/account/ResumeSession'
import { BrowserWait } from '../src/renderer/src/account/BrowserPane'
import {
  BROWSER_COPY,
  forgetPageMissing,
  linkCallFor,
  pageKnownMissing,
  runPageTrip,
} from '../src/renderer/src/account/browser-auth-store'
import { tripGuard } from '../src/renderer/src/account/provider-store'

const status = (over: Partial<AccountStatus> = {}): AccountStatus => ({
  username: 'octo',
  displayName: 'octo',
  avatar: null,
  locked: false,
  lockAfterMs: 900_000,
  requests: 0,
  envUsername: null,
  legacy: null,
  sessionExpired: true,
  passwordPending: false,
  passwordless: false,
  unlockBy: 'passcode',
  passcodePending: false,
  touchId: { available: false, on: false },
  registryMismatch: null,
  workspacesReachable: true,
  recoveryCodesSavedAt: null,
  recoveryCodesLeft: null,
  ...over,
})

const bridge = (api: Record<string, unknown>): void => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    cookrew: { accountStatus: () => Promise.resolve(status()), ...api },
  }
}

const PAGE = {
  accountBrowserSignIn: () => Promise.resolve({ ok: true, value: status() }),
  accountBrowserResume: () => Promise.resolve({ ok: true, value: status() }),
}

beforeEach(() => forgetPageMissing())
afterEach(() => forgetPageMissing())

describe('the sheet, with the page offered', () => {
  it('asks for no password and sends the person to the browser', () => {
    bridge(PAGE)
    const html = renderToStaticMarkup(<AccountSheet onClose={() => undefined} onDone={() => undefined} />)
    expect(html).toContain(BROWSER_COPY.SIGN_IN)
    expect(html).toContain(BROWSER_COPY.SIGN_IN_LEDE)
    expect(html).not.toContain('type="password"')
    expect(html).toContain('SIGN IN')
    expect(html).toContain('CREATE ACCOUNT')
  })

  it('the create tab goes to the page too', () => {
    bridge(PAGE)
    const html = renderToStaticMarkup(<AccountSheet initial="register" onClose={() => undefined} onDone={() => undefined} />)
    expect(html).toContain(BROWSER_COPY.CREATE)
    expect(html).not.toContain('type="password"')
  })

  it('a Mac setting a password on an old key keeps its form', () => {
    bridge(PAGE)
    const html = renderToStaticMarkup(
      <AccountSheet legacy={{ handle: 'drej' }} onClose={() => undefined} onDone={() => undefined} />,
    )
    expect(html).toContain('type="password"')
    expect(html).not.toContain(BROWSER_COPY.SIGN_IN)
  })
})

describe('the sheet falls back to what it was', () => {
  it('when the bridge has no page', () => {
    bridge({})
    const html = renderToStaticMarkup(<AccountSheet onClose={() => undefined} onDone={() => undefined} />)
    expect(html).toContain('type="password"')
    expect(html).not.toContain(BROWSER_COPY.SIGN_IN)
  })

  it('once a registry has said it has none', async () => {
    bridge({ ...PAGE, accountBrowserSignIn: () => Promise.resolve({ ok: false, reason: 'unsupported' }) })
    await runPageTrip(
      () => Promise.resolve({ ok: false, reason: 'unsupported' }),
      tripGuard(() => undefined),
      { done: () => undefined, fallback: () => undefined, refused: () => undefined },
    )
    expect(pageKnownMissing()).toBe(true)
    const html = renderToStaticMarkup(<AccountSheet onClose={() => undefined} onDone={() => undefined} />)
    expect(html).toContain('type="password"')
    expect(html).not.toContain(BROWSER_COPY.SIGN_IN)
  })
})

describe('the session that ended', () => {
  it('offers the browser and no password field when the page is offered', () => {
    bridge(PAGE)
    const html = renderToStaticMarkup(<ResumeSession onResumed={() => undefined} />)
    expect(html).toContain(BROWSER_COPY.RESUME)
    expect(html).toContain(BROWSER_COPY.SESSION_ENDED)
    expect(html).not.toContain('type="password"')
  })

  it('keeps its password prompt without the page', () => {
    bridge({})
    expect(renderToStaticMarkup(<ResumeSession onResumed={() => undefined} />)).toContain('type="password"')
  })

  it('a passwordless account with the page is still asked for no password', () => {
    bridge(PAGE)
    const html = renderToStaticMarkup(<ResumeSession passwordless onResumed={() => undefined} />)
    expect(html).toContain(BROWSER_COPY.RESUME)
    expect(html).not.toContain('type="password"')
  })

  it('falls back to the password prompt after an unsupported answer', async () => {
    bridge(PAGE)
    await runPageTrip(() => Promise.resolve({ ok: false, reason: 'unsupported' }), tripGuard(() => undefined), {
      done: () => undefined,
      fallback: () => undefined,
      refused: () => undefined,
    })
    const html = renderToStaticMarkup(<ResumeSession onResumed={() => undefined} />)
    expect(html).toContain('type="password"')
    expect(html).not.toContain(BROWSER_COPY.RESUME)
  })
})

describe('the wait', () => {
  it('says where the person went and offers the way out', () => {
    const html = renderToStaticMarkup(<BrowserWait onCancel={() => undefined} />)
    expect(html).toContain('Continue in your browser')
    expect(html).toContain('CANCEL')
    expect(html).toContain('role="status"')
  })
})

describe('how a page trip lands', () => {
  const run = async (answer: SignInAnswer<AccountStatus> | Error) => {
    const cancel = vi.fn()
    const guard = tripGuard(cancel)
    const done = vi.fn()
    const fallback = vi.fn()
    const refused = vi.fn()
    let running = 0
    const counted = {
      begin: () => {
        running += 1
        return guard.begin()
      },
      end: (from?: number) => {
        running -= 1
        guard.end(from)
      },
      leave: guard.leave,
    }
    await runPageTrip(
      () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
      counted,
      { done, fallback, refused },
    )
    return { done, fallback, refused, running, cancel }
  }

  it('a landing hands the status on, and the guard is let go', async () => {
    const landed = await run({ ok: true, value: status({ username: 'octo' }) })
    expect(landed.done).toHaveBeenCalledWith(expect.objectContaining({ username: 'octo' }))
    expect(landed.running).toBe(0)
    expect(landed.fallback).not.toHaveBeenCalled()
  })

  it('an older registry is the old way, and is remembered', async () => {
    const old = await run({ ok: false, reason: 'unsupported' })
    expect(old.fallback).toHaveBeenCalledTimes(1)
    expect(old.refused).not.toHaveBeenCalled()
    expect(pageKnownMissing()).toBe(true)
  })

  it('a change of mind says nothing; a refusal says its sentence', async () => {
    const cancelled = await run({ ok: false, reason: 'cancelled' })
    expect(cancelled.refused).toHaveBeenCalledWith(null)
    const cold = await run({ ok: false, reason: 'expired' })
    expect(cold.refused).toHaveBeenCalledWith(expect.stringContaining('too long'))
    const said = await run({ ok: false, reason: 'unknown', message: 'The registry said this.' })
    expect(said.refused).toHaveBeenCalledWith('The registry said this.')
    expect(pageKnownMissing()).toBe(false)
  })

  it('a bridge that throws is a refusal, never a hang', async () => {
    const thrown = await run(new Error('ipc gone'))
    expect(thrown.refused).toHaveBeenCalledWith(expect.any(String))
    expect(thrown.running).toBe(0)
  })
})

describe('the link row', () => {
  it('links on the page when it is offered, and the old way otherwise; an unlink is unchanged', () => {
    const page = vi.fn()
    const old = vi.fn()
    const unlink = vi.fn()
    expect(linkCallFor({ accountBrowserLink: page, accountOAuthLink: old, accountOAuthUnlink: unlink }, 'link')).toBe(page)
    expect(linkCallFor({ accountOAuthLink: old, accountOAuthUnlink: unlink }, 'link')).toBe(old)
    expect(linkCallFor({ accountBrowserLink: page, accountOAuthLink: old, accountOAuthUnlink: unlink }, 'unlink')).toBe(unlink)
  })
})
