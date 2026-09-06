import { describe, expect, it } from 'vitest'
import type { BrowserNodeData } from '../src/shared/model'
import { browserHostsToRender } from '../src/renderer/src/browser-host-policy'

const browser = (id: string): BrowserNodeData => ({
  kind: 'browser',
  id,
  name: id,
  url: 'about:blank',
  position: { x: 0, y: 0 },
  size: { width: 400, height: 300 },
})

describe('browserHostsToRender', () => {
  const browsers = [browser('a'), browser('b'), browser('c')]

  it('mounts no hidden browser hosts on a resting remote canvas', () => {
    expect(browserHostsToRender(browsers, true, null, true)).toEqual([])
  })

  it('mounts only the remote browser selected by shared LOD arbitration', () => {
    expect(browserHostsToRender(browsers, true, 'b', true)).toEqual([browsers[1]])
  })

  it('mounts none when a terminal, not a browser, owns the remote overlay', () => {
    expect(browserHostsToRender(browsers, true, 'terminal-1', true)).toEqual([])
  })

  it('preserves every native Electron host for legacy webview residency', () => {
    expect(browserHostsToRender(browsers, false, null, false)).toBe(browsers)
  })

  // The desktop with the headless stream on. A host that is not zoomed does
  // nothing there — the stream opens only while zoomed, thumbnails come from
  // main's snapshot poll — yet every one was mounted as a fixed 1100x780 box
  // with a full popout: 90 hosts were 54% of the live renderer's DOM and 90
  // compositing layers (scripts/perf-dom-probe.mjs --attach, 2026-09-06).
  it('mounts only the zoomed host on a desktop whose browsers are headless streams', () => {
    expect(browserHostsToRender(browsers, false, null, true)).toEqual([])
    expect(browserHostsToRender(browsers, false, 'b', true)).toEqual([browsers[1]])
    expect(browserHostsToRender(browsers, false, 'terminal-1', true)).toEqual([])
  })

  it('mounts nothing on a desktop while ownership is still unresolved', () => {
    // Unresolved renders a neutral body anyway; mounting it 90 times over
    // says nothing a single zoomed host would not.
    expect(browserHostsToRender(browsers, false, null, null)).toEqual([])
  })
})
