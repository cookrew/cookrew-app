import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bareWindow } from './support/memory-storage'
import { inConsole } from './support/console-scope'

/**
 * ON THE CONSOLE THE LEVEL IS THE ADDRESS, so the zoom keeps nothing in
 * storage: a level remembered there would fight the address on every load, and
 * would carry one machine's place into another. A machine's own page and the
 * desktop app have no address for it and remember it as before.
 */

const M = '11111111-1111-4111-8111-111111111111'
let stored: Storage

beforeEach(() => {
  vi.resetModules()
  const page = bareWindow('https://console.cookrew.dev/')
  stored = page.localStorage as Storage
  vi.stubGlobal('window', { ...page, COOKREW_MOBILE: 1 })
  vi.stubGlobal('localStorage', stored)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('the zoom on the console', () => {
  it('does not start from a level some page left in storage, and leaves none there', async () => {
    stored.setItem('cookrew.zoom', JSON.stringify({ dir: 'items', v: 0 }))
    await inConsole(M)
    const { zoomStore } = await import('../src/renderer/src/zoom/zoom-store')
    expect(zoomStore.get()).toMatchObject({ dir: 'agents', v: -1 })
    zoomStore.go(1, 'agents')
    zoomStore.jumpTo('card', 'agent-1')
    expect(stored.getItem('cookrew.zoom')).toBe(JSON.stringify({ dir: 'items', v: 0 }))
  })
})

describe('the zoom on a machine’s own page', () => {
  it('remembers its level, as it always did', async () => {
    stored.setItem('cookrew.zoom', JSON.stringify({ dir: 'items', v: 0 }))
    const { zoomStore } = await import('../src/renderer/src/zoom/zoom-store')
    expect(zoomStore.get()).toMatchObject({ dir: 'items', v: 0 })
    zoomStore.go(1, 'agents')
    expect(stored.getItem('cookrew.zoom')).toBe(JSON.stringify({ dir: 'agents', v: 1 }))
  })
})
