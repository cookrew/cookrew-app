// FULL SCREEN ON THE PHONE (owner 2026-11-04: "how do I go full screen in Chrome on the phone? — do it").
//
// Chrome on Android hides its address bar, the status bar and the navigation bar only for the
// Fullscreen API, and only from a tap. So the phone gets one row in ⋯ that asks for it, and the
// row reads the browser's own state: the back gesture leaves full screen without asking us, and
// the row must not keep saying "on" after it. viewport-fit=cover, added at the moment of asking,
// lets the page reach into the camera cutout, where the phone bar's safe-area padding keeps the
// route clear of it.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  canFullscreen,
  coverInstalledApp,
  installedFullscreen,
  isFullscreen,
  subscribeFullscreen,
  toggleFullscreen,
  withCover,
  type FullscreenDoc
} from '../src/renderer/src/fullscreen'

interface FakeDoc extends FullscreenDoc {
  fullscreenElement: Element | null
  calls: string[]
  /** What the browser does when a request lands: grant it, or refuse (no gesture, a policy). */
  refuse: boolean
  fire: () => void
  listenerCount: () => number
  viewport: string | null
}

function fakeDoc(enabled = true): FakeDoc {
  const listeners = new Set<() => void>()
  const root = {} as Element
  const doc: FakeDoc = {
    fullscreenEnabled: enabled,
    fullscreenElement: null,
    calls: [],
    refuse: false,
    // What the companion's boot script leaves on the phone.
    viewport: 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, interactive-widget=resizes-visual',
    querySelector: () =>
      doc.viewport === null
        ? null
        : {
            getAttribute: () => doc.viewport,
            setAttribute: (_name: string, value: string) => {
              doc.calls.push('viewport')
              doc.viewport = value
            }
          },
    documentElement: {
      requestFullscreen: async (options?: FullscreenOptions): Promise<void> => {
        doc.calls.push(`request:${options?.navigationUI ?? 'auto'}`)
        if (doc.refuse) throw new TypeError('Permissions check failed')
        doc.fullscreenElement = root
        doc.fire()
      }
    },
    exitFullscreen: async (): Promise<void> => {
      doc.calls.push('exit')
      doc.fullscreenElement = null
      doc.fire()
    },
    addEventListener: (_type, cb) => {
      listeners.add(cb)
    },
    removeEventListener: (_type, cb) => {
      listeners.delete(cb)
    },
    fire: () => {
      for (const cb of listeners) cb()
    },
    listenerCount: () => listeners.size
  }
  return doc
}

describe('the full screen switch', () => {
  it('is offered only where the browser can go full screen', () => {
    expect(canFullscreen(fakeDoc(true))).toBe(true)
    // iPhone (WebKit, Chrome included): no fullscreenEnabled for a page, so no row.
    expect(canFullscreen(fakeDoc(false))).toBe(false)
    const bare = { ...fakeDoc(true), documentElement: {} }
    expect(canFullscreen(bare)).toBe(false)
  })

  it('goes full screen with the navigation bar hidden, and comes back out', async () => {
    const doc = fakeDoc()
    expect(await toggleFullscreen(doc)).toBe(true)
    expect(isFullscreen(doc)).toBe(true)
    expect(await toggleFullscreen(doc)).toBe(false)
    expect(isFullscreen(doc)).toBe(false)
    expect(doc.calls).toEqual(['viewport', 'request:hide', 'exit'])
  })

  it('lets the page into the camera cutout before asking, keeping the rest of the viewport', async () => {
    const doc = fakeDoc()
    await toggleFullscreen(doc)
    expect(doc.viewport).toBe(
      'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, interactive-widget=resizes-visual, viewport-fit=cover'
    )
    // Once is enough: going back in does not write the tag again.
    await toggleFullscreen(doc)
    await toggleFullscreen(doc)
    expect(doc.calls.filter((c) => c === 'viewport')).toHaveLength(1)
  })

  it('replaces any other fit rather than adding a second one', () => {
    expect(withCover('width=device-width, viewport-fit=contain')).toBe('width=device-width, viewport-fit=cover')
    expect(withCover('')).toBe('viewport-fit=cover')
    expect(withCover('width=device-width,initial-scale=1')).toBe('width=device-width, initial-scale=1, viewport-fit=cover')
  })

  it('still asks on a page with no viewport tag', async () => {
    const doc = fakeDoc()
    doc.viewport = null
    await expect(toggleFullscreen(doc)).resolves.toBe(true)
  })

  it('never throws into the app when the browser refuses', async () => {
    const doc = fakeDoc()
    doc.refuse = true
    await expect(toggleFullscreen(doc)).resolves.toBe(false)
    expect(isFullscreen(doc)).toBe(false)
  })

  it('does nothing where full screen is not offered', async () => {
    const doc = fakeDoc(false)
    await expect(toggleFullscreen(doc)).resolves.toBe(false)
    expect(doc.calls).toEqual([])
  })

  it('follows the browser when the back gesture leaves full screen', async () => {
    const doc = fakeDoc()
    const seen: boolean[] = []
    const stop = subscribeFullscreen(doc, () => seen.push(isFullscreen(doc)))
    await toggleFullscreen(doc)
    // The system back gesture: the browser drops full screen and only tells us.
    doc.fullscreenElement = null
    doc.fire()
    expect(seen).toEqual([true, false])
    stop()
    expect(doc.listenerCount()).toBe(0)
  })
})

describe('the app installed on the home screen', () => {
  const matching = (query: string): { matches: boolean } => ({ matches: query === '(display-mode: fullscreen)' })
  const noMatch = (): { matches: boolean } => ({ matches: false })

  it('is full screen from the manifest, with no element in the Fullscreen API', () => {
    expect(installedFullscreen(fakeDoc(), matching)).toBe(true)
    expect(installedFullscreen(fakeDoc(), noMatch)).toBe(false)
  })

  it('is not a browser tab that went full screen from the row: that matches the same query', async () => {
    const doc = fakeDoc()
    await toggleFullscreen(doc)
    expect(installedFullscreen(doc, matching)).toBe(false)
  })

  it('lets the page into the camera cutout at boot, since nothing ever asks for full screen there', () => {
    const doc = fakeDoc()
    coverInstalledApp(doc, matching)
    expect(doc.viewport).toContain('viewport-fit=cover')
    const tab = fakeDoc()
    coverInstalledApp(tab, noMatch)
    expect(tab.viewport).not.toContain('viewport-fit')
  })
})

describe('the row and the page', () => {
  const more = readFileSync('src/renderer/src/HeaderMore.tsx', 'utf8')
  const index = readFileSync('src/renderer/index.html', 'utf8')
  const styles = readFileSync('src/renderer/src/styles.css', 'utf8')

  it('sits in ⋯, on the phone only, and says which way it goes', () => {
    expect(more).toMatch(/isRemoteMode\(\)\s*&&[^\n]*canFullscreen\(document\)/)
    // An installed app is already full screen: the row would offer what it has.
    expect(more).toContain('!installedFullscreen(document')
    expect(more).toContain("'Exit full screen'")
    expect(more).toContain("'Full screen'")
    expect(more).toContain('aria-pressed={fullscreen}')
  })

  it('leaves the page viewport alone until full screen is asked for, and pads the phone bar clear of the cutout', () => {
    const viewport = index.match(/<meta name="viewport" content="([^"]+)"/)?.[1] ?? ''
    expect(viewport).not.toContain('viewport-fit')
    const phoneBar = styles.slice(styles.lastIndexOf('body.cookrew-mobile .cr-header {'))
    const rule = phoneBar.slice(0, phoneBar.indexOf('}'))
    expect(rule).toContain('env(safe-area-inset-top)')
    expect(rule).toContain('env(safe-area-inset-left)')
    expect(rule).toContain('env(safe-area-inset-right)')
  })
})
