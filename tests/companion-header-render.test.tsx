// THE COMPANION BAR IN V2 — the badge where the hand was, the avatar where the
// violet handset was, and nothing else moved.
//
// A static render runs the component body and every branch reachable without
// effects, and because the markup IS the picture, the picture can be asserted:
// the badge sits INSIDE the brand group and BEFORE the wordmark, the hand mark
// is gone in remote mode and still there on the desktop, and the badge carries
// one dot and one word.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Header } from '../src/renderer/src/Header'
import { PathBadge, PathSheet } from '../src/renderer/src/PathBadge'
import { pathBadgeView } from '../src/shared/path-badge'
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

const bar = (): string =>
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
    />
  )

/** The brand group only, so ordering inside it can be asserted. */
const brandGroup = (html: string): string =>
  html.slice(html.indexOf('cr-header-brand'), html.indexOf('cr-viewseg'))

beforeEach(() => resetPathLink())
afterEach(() => resetPathLink())

describe('the companion bar', () => {
  it('puts the path badge in the brand group, right after the C hand', () => {
    stubPhone()
    const group = brandGroup(bar())
    expect(group).toContain('cr-path')
    expect(group.indexOf('cr-hand-mark')).toBeLessThan(group.indexOf('cr-path'))
    expect(group.indexOf('cr-path')).toBeLessThan(group.indexOf('cr-logo'))
  })

  it('wears the C hand alone in remote mode — the lockup stays on the desktop, the badge refreshes', () => {
    stubPhone()
    const html = bar()
    expect(html).toContain('cr-hand-mark')
    expect(html).not.toContain('cr-logo-mark')
    expect(html).not.toContain('Refresh the canvas')
  })

  it('keeps the hand mark on the desktop, where there is no path to report', () => {
    stubDesktop()
    const html = bar()
    expect(html).toContain('cr-logo-mark')
    expect(html).not.toContain('cr-path')
  })

  it('turns the violet handset slot into the avatar', () => {
    stubPhone()
    const group = brandGroup(bar())
    expect(group).not.toContain('cr-mode-icon')
    expect(group).toContain('cr-acct-avatar')
  })

  it('shows the avatar dashed when the desktop holds no account', () => {
    stubPhone()
    expect(brandGroup(bar())).toContain('cr-acct-none')
  })
})

describe('the badge itself', () => {
  it('is one dot and one word', () => {
    stubPhone()
    const html = renderToStaticMarkup(<PathBadge onRefresh={() => undefined} />)
    expect(html).toContain('cr-path-dot')
    expect(html).toContain('>LAN<')
    expect((html.match(/cr-path-dot/g) ?? [])).toHaveLength(1)
  })

  it('wears the state as a class, so the dot can be coloured', () => {
    stubPhone('https://mac.tail9.ts.net:8643')
    expect(renderToStaticMarkup(<PathBadge onRefresh={() => undefined} />))
      .toContain('cr-path-tailnet')
    stubPhone('https://cookrew.dev')
    expect(renderToStaticMarkup(<PathBadge onRefresh={() => undefined} />))
      .toContain('cr-path-relay')
  })

  it('reads OFFLINE when the channel failed, whatever the address bar says', () => {
    stubPhone('https://192.168.1.24:8643')
    setPathLink('failed')
    const html = renderToStaticMarkup(<PathBadge onRefresh={() => undefined} />)
    expect(html).toContain('cr-path-offline')
    expect(html).toContain('>OFFLINE<')
  })

  it('reads PROBING while reconnecting', () => {
    stubPhone()
    setPathLink('reconnecting')
    expect(renderToStaticMarkup(<PathBadge onRefresh={() => undefined} />))
      .toContain('cr-path-probing')
  })

  it('says what it is for, for a screen reader', () => {
    stubPhone()
    const html = renderToStaticMarkup(<PathBadge onRefresh={() => undefined} />)
    expect(html).toContain('aria-label="Connection: LAN. Tap to refresh and see details."')
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
    expect(html).toContain('Via cookrew.dev relay — your Mac is not on this network.')
  })

  it('offers a way to another desktop, once the desktop has said where', () => {
    const html = paint({
      origin: 'https://cookrew.dev',
      link: 'live',
      registryOrigin: 'https://cookrew.dev'
    })
    expect(html).toContain('href="https://cookrew.dev/me"')
    expect(html).toContain('Switch desktop')
  })

  it('offers NOTHING rather than a guessed address', () => {
    const html = paint({ origin: 'https://cookrew.dev', link: 'live' })
    expect(html).not.toContain('Switch desktop')
    expect(html).not.toContain('href=')
  })
})
