// ONE AVATAR IN THE BRAND GROUP, on the phone as on the desktop.
//
// Phase 2 gave the companion a READ-ONLY `accountStatus` over HTTP so its own
// avatar could draw initials. The desktop's account surface feature-detected
// that same method as "there is an owner surface here" and mounted a SECOND
// avatar beside it — two identical circles in .cr-header-brand, one of which
// opened sheets whose IPC a phone does not have.
//
// The marker is now `accountClaim`, which only main exposes. This is the test
// that would have caught it: render the bar in each mode and count.

import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Header } from '../src/renderer/src/Header'
import { useAccountSurface } from '../src/renderer/src/account/AccountSurface'

/** The phone: no `window.cookrew` at all, and the mobile marker set. */
function companionWindow(): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    COOKREW_MOBILE: 1,
    location: { origin: 'https://desktop.test', pathname: '/', search: '' },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
}

/** The desktop: the Electron bridge, with the owner's own channels. */
function desktopWindow(): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    cookrew: {
      accountStatus: async () => null,
      accountClaim: async () => ({ ok: false, reason: 'offline' }),
      accountActivity: async () => false,
    },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

/** The bar exactly as App mounts it: the surface decides, the header draws. */
function Bar(): React.JSX.Element {
  const account = useAccountSurface()
  return (
    <Header
      workspaceName="Cookrew Dev"
      dir="/tmp"
      terminalCount={1}
      busyCount={0}
      attentionCount={0}
      view="canvas"
      onViewChange={() => undefined}
      onActivity={() => undefined}
      onResync={() => undefined}
      avatar={account.avatar}
    />
  )
}

const avatars = (html: string): number => html.match(/cr-acct-avatar/g)?.length ?? 0

describe('the brand group holds exactly one avatar', () => {
  it('on the companion, where the phone mounts its own', () => {
    companionWindow()
    const html = renderToStaticMarkup(<Bar />)
    expect(avatars(html)).toBe(1)
    // And it is the companion's, in the handset's old slot (M3).
    expect(html).toContain('No account on this desktop')
  })

  it('on the desktop, where the account surface mounts it', () => {
    desktopWindow()
    const html = renderToStaticMarkup(<Bar />)
    expect(avatars(html)).toBe(1)
    expect(html).toContain('Claim a username')
  })
})
