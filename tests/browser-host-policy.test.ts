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
    expect(browserHostsToRender(browsers, true, null)).toEqual([])
  })

  it('mounts only the remote browser selected by shared LOD arbitration', () => {
    expect(browserHostsToRender(browsers, true, 'b')).toEqual([browsers[1]])
  })

  it('mounts none when a terminal, not a browser, owns the remote overlay', () => {
    expect(browserHostsToRender(browsers, true, 'terminal-1')).toEqual([])
  })

  it('preserves every native Electron host for legacy webview residency', () => {
    expect(browserHostsToRender(browsers, false, null)).toBe(browsers)
  })
})
