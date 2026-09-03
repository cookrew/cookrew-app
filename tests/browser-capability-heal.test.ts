import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { nextCapability } from '../src/renderer/src/browser-stream'

/**
 * The phone rendered "BROWSER PREVIEW" on black forever (2026-09-04): its
 * page had resolved interactiveBrowserEnabled() ONCE at mount, against a
 * flag-off run, and the tab outlived the app restart — the shared stream
 * healed the canvas while the frozen capability kept the dead legacy-thumb
 * branch mounted against a server that had long since gone headless-stream.
 */
describe('browser capability heals with the link', () => {
  const hook = ((): string => {
    const layer = readFileSync(
      path.join(__dirname, '..', 'src/renderer/src', 'BrowserLayer.tsx'),
      'utf8'
    )
    const start = layer.indexOf('export function useInteractiveBrowserCapability')
    expect(start).toBeGreaterThan(-1)
    const end = layer.indexOf('\n}', layer.indexOf('return capability', start))
    expect(end).toBeGreaterThan(-1)
    return layer.slice(start, end)
  })()

  it('re-resolves on foreground and network return, not once at mount', () => {
    expect(hook).toContain("addEventListener('visibilitychange'")
    expect(hook).toContain("removeEventListener('visibilitychange'")
    expect(hook).toContain("addEventListener('online'")
    expect(hook).toContain("removeEventListener('online'")
  })

  it('the latest answer wins — an older resolve landing late cannot overwrite', () => {
    expect(hook).toContain('seq !== latest')
  })

  it('an unchanged answer keeps object identity — pinned as a fact, not a regex', () => {
    const a = { enabled: true, desktopToken: 'x' }
    expect(nextCapability(a, { ...a })).toBe(a)
    expect(nextCapability(a, { enabled: false, desktopToken: 'x' })).not.toBe(a)
    expect(nextCapability(a, { enabled: true, desktopToken: null })).not.toBe(a)
    expect(nextCapability(null, a)).toBe(a)
  })

  it('a non-boolean 200 is no answer — a stranger on the port cannot blank a live view', () => {
    expect(hook).toContain("typeof enabled !== 'boolean'")
  })

  it('the webview surface never downgrades — the double-ownership guard is explicit', () => {
    expect(hook).toMatch(/hasNativeWebview\(\) && prev\?\.enabled === true/)
  })
})
