// THE COMPANION BAR: the route on the left (device / workspace / agent), the
// function bar on the right, and the path badge said in two smaller ways — its
// dot on the device step, its word in the More menu's Connection row.
//
// A static render runs the component body and every branch reachable without
// effects, and because the markup IS the picture, the picture can be asserted.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Header } from '../src/renderer/src/Header'
import { BoardSearch } from '../src/renderer/src/BoardSearch'
import { PathBadge, PathDot, PathSheet } from '../src/renderer/src/PathBadge'
import { pathBadgeView } from '../src/shared/path-badge'
import { currentPathBadge } from '../src/renderer/src/path-link'
import { resetPathLink, setPathLink } from '../src/renderer/src/path-link'

/**
 * The PHONE, as api.ts detects it: no Electron bridge, and the marker the
 * mobile server injects into the served index.
 */
const stubPhone = (origin = 'https://192.168.1.24:8643'): void => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    COOKREW_MOBILE: 1,
    location: { origin, search: '' },
    setTimeout: () => 0,
    clearTimeout: () => undefined
  }
}

/** The DESKTOP: an Electron bridge and no mobile marker. */
const stubDesktop = (): void => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    cookrew: { accountStatus: async () => null },
    setTimeout: () => 0,
    clearTimeout: () => undefined
  }
}

const bar = (attention = 0): string =>
  renderToStaticMarkup(
    <Header
      workspaceName="Cookrew Dev"
      dir="/tmp"
      terminalCount={2}
      busyCount={0}
      view="stage"
      onViewChange={() => undefined}
      onWall={() => undefined}
      onResync={() => undefined}
      onActivity={() => undefined}
      search={<BoardSearch workspace={null} activeWorkspaceId={null} attentionCount={attention} />}
    />
  )

/** The route only (the left of the bar), so what is on it can be asserted. */
const route = (html: string): string => html.slice(html.indexOf('cr-route'), html.indexOf('cr-fn'))
/** The function bar only (the right of the bar). */
const functions = (html: string): string => html.slice(html.indexOf('class="cr-fn"'))

beforeEach(() => resetPathLink())
afterEach(() => resetPathLink())

describe('the companion bar', () => {
  it('starts with the route: the device, then the workspace', () => {
    stubPhone()
    const html = route(bar())
    expect(html).toContain('cr-route-device')
    expect(html).toContain('cr-route-workspace')
    expect(html.indexOf('cr-route-device')).toBeLessThan(html.indexOf('cr-route-workspace'))
    expect(html).toContain('Cookrew Dev')
  })

  it('wears the path as a dot on the device step, not as a button of its own', () => {
    stubPhone()
    const html = bar()
    expect(route(html)).toContain('cr-route-path cr-path-lan')
    expect(html).not.toContain('Tap to refresh and see details')
  })

  it('has no dot on the desktop, where there is no path to report', () => {
    stubDesktop()
    expect(bar()).not.toContain('cr-path')
  })

  it('has no agent step while no terminal is open', () => {
    stubPhone()
    expect(route(bar())).not.toContain('cr-route-agent')
  })

  it("puts the board's search box, the More menu and the avatar on the function bar, in that order", () => {
    stubPhone()
    const html = functions(bar())
    expect(html.indexOf('cr-board-search')).toBeGreaterThan(-1)
    expect(html.indexOf('cr-board-search')).toBeLessThan(html.indexOf('cr-more'))
    expect(html.indexOf('cr-more')).toBeLessThan(html.indexOf('cr-acct-avatar'))
  })

  it('has no view switch and no way back: the board drops under the bar, the stage stays', () => {
    stubPhone()
    const html = functions(bar())
    expect(html).not.toContain('cr-fn-stage')
    expect(html).not.toContain('cr-viewseg')
  })

  it('keeps the board folded until the box is used', () => {
    stubPhone()
    const html = bar()
    expect(html).toContain('aria-label="Search the board"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('cr-board-pop')
  })

  it('counts the agents waiting on you on the folded box', () => {
    stubPhone()
    expect(bar(3)).toMatch(/class="cr-board-badge"[^>]*>3</)
    expect(bar(0)).not.toContain('cr-board-badge')
  })

  it('keeps everything else behind More, closed until it is opened', () => {
    stubPhone()
    const html = bar()
    expect(html).toContain('aria-label="More"')
    expect(html).not.toContain('class="cr-more-menu"')
    for (const gone of ['cr-routing-entry', 'cr-header-status', 'cr-ws-current', 'cr-logo-mark']) expect(html).not.toContain(gone)
  })

  it('shows the avatar dashed when the desktop holds no account', () => {
    stubPhone()
    expect(functions(bar())).toContain('cr-acct-none')
  })
})

describe('the badge itself', () => {
  const badge = (): string => renderToStaticMarkup(<PathBadge view={currentPathBadge()} />)

  it('is one dot and one word', () => {
    stubPhone()
    const html = badge()
    expect(html).toContain('cr-path-dot')
    expect(html).toContain('>LAN<')
    expect((html.match(/cr-path-dot/g) ?? [])).toHaveLength(1)
  })

  it('wears the state as a class, so the dot can be coloured', () => {
    stubPhone('https://mac.tail9.ts.net:8643')
    expect(badge()).toContain('cr-path-tailnet')
    stubPhone('https://cookrew.dev')
    expect(badge()).toContain('cr-path-relay')
  })

  it('reads OFFLINE when the channel failed, whatever the address bar says', () => {
    stubPhone('https://192.168.1.24:8643')
    setPathLink('failed')
    const html = badge()
    expect(html).toContain('cr-path-offline')
    expect(html).toContain('>OFFLINE<')
  })

  it('reads PROBING while reconnecting', () => {
    stubPhone()
    setPathLink('reconnecting')
    expect(badge()).toContain('cr-path-probing')
  })

  it('says what it is for, for a screen reader, as the dot on the route', () => {
    stubPhone()
    const html = renderToStaticMarkup(<PathDot view={currentPathBadge()} />)
    expect(html).toContain('aria-label="Connection: LAN"')
    expect((html.match(/cr-path-dot/g) ?? [])).toHaveLength(1)
  })
})

describe('the badge sheet', () => {
  const paint = (over: Parameters<typeof pathBadgeView>[0]): string =>
    renderToStaticMarkup(<PathSheet view={pathBadgeView(over)} onClose={() => undefined} />)

  it('names the desktop, the sentence and the latency', () => {
    const html = paint({
      origin: 'https://192.168.1.24:8643',
      link: 'live',
      desktopName: 'MacBook Pro',
      latencyMs: 14
    })
    expect(html).toContain('MacBook Pro')
    expect(html).toContain('Direct over this Wi-Fi.')
    expect(html).toContain('14 ms round trip')
  })

  it('is honest when nothing has been measured yet', () => {
    const html = paint({ origin: 'https://192.168.1.24:8643', link: 'live' })
    expect(html).toContain('Latency not measured yet.')
  })

  it('uses the relay sentence, in the owner voice', () => {
    const html = paint({ origin: 'https://cookrew.dev', link: 'live' })
    expect(html).toContain('Via cookrew.dev relay. It goes direct by itself when your Mac can be reached from here.')
  })

  it('offers a way to another desktop, once the desktop has said where', () => {
    const html = paint({
      origin: 'https://cookrew.dev',
      link: 'live',
      registryOrigin: 'https://cookrew.dev'
    })
    // The account's machine list, not plain /me: that goes straight back into the machine this page is (machines.js).
    expect(html).toContain('href="https://cookrew.dev/me/account"')
    expect(html).toContain('Switch desktop')
  })

  it('offers NOTHING rather than a guessed address', () => {
    const html = paint({ origin: 'https://cookrew.dev', link: 'live' })
    expect(html).not.toContain('Switch desktop')
    expect([...html.matchAll(/href="([^"]*)"/g)]).toEqual([])
  })

  it('asks nothing of the reader — no retry, no profile, no table of timeouts', () => {
    // 2026-10-18, the owner on a sheet that said LAN above a yellow TRY AGAIN
    // and five timed-out rows: the path finds itself, so the sheet only says
    // where it is. The one button is the close.
    const html = paint({ origin: 'https://cookrew.dev', link: 'live', relayed: true, plane: 'RELAY' })
    expect(html).not.toMatch(/try again|why this path|certificate|mobileconfig/i)
    expect([...html.matchAll(/<button/g)]).toHaveLength(1)
  })
})
