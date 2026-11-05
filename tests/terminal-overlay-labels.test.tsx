import { describe, expect, it } from 'vitest'

// xterm's addons read `self` at import time
;(globalThis as { self?: unknown }).self ??= globalThis
const { languageName, openedLabel } = await import('../src/renderer/src/TerminalOverlay')

describe('languageName', () => {
  it('names a missing code as another language', () => {
    expect(languageName(null)).toBe('another language')
  })

  it('degrades an unknown code to the code itself', () => {
    expect(languageName('zz-unknown')).toBe('zz-unknown')
  })

  it('shows the menu name for a known code', () => {
    expect(languageName('fr')).not.toBe('fr')
  })
})

describe('openedLabel', () => {
  it('says today while the session opened today', () => {
    const now = new Date()
    now.setHours(0, 5, 0, 0)
    expect(openedLabel(now.getTime())).toMatch(/^today /)
  })

  it('shows the date once the session is older than today', () => {
    const old = Date.now() - 3 * 24 * 60 * 60 * 1000
    expect(openedLabel(old)).not.toMatch(/^today/)
  })
})
