import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ShareDevicesBound } from '../src/renderer/src/routing/ShareDevices'
import { createShareDevicesStore, problemText, type ShareBridge } from '../src/renderer/src/routing/share-devices-store'
import type { PendingKey, SharedKey, ShareListAnswer, ShareWhere } from '../src/shared/share-devices'

/**
 * KEYS LEFT BEHIND, AND A WINDOW THAT RELOADS MID-ISSUE (key recovery v1).
 * Main keeps the warning, the in-flight issue and the key until Done; the store
 * shows them on any mount, and a failed check stays on screen until one works.
 */

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const WHERE: ShareWhere = { onNetwork: true, urls: [] }
const NAME = `device-laptop--${'a'.repeat(32)}`
const KEY = 'sk-magpie-key-handover-handover'
const shared: SharedKey = { id: 'f'.repeat(24), name: `device-phone--${'b'.repeat(32)}`, device: 'phone', limit: '$5 per day' }

const pending = (over: Partial<PendingKey> = {}): PendingKey => ({ name: NAME, device: 'laptop', at: '2026-11-18T10:00:00.000Z', revoked: null, checked: null, clearable: false, ...over })
const listed = (over: Partial<Extract<ShareListAnswer, { ok: true }>> = {}): ShareListAnswer => ({ ok: true, keys: [], where: WHERE, pending: [], issuing: false, handover: null, ...over })

const render = (store: ReturnType<typeof createShareDevicesStore>): string => renderToStaticMarkup(createElement(ShareDevicesBound, { store, sharingEnabled: true }))

describe('a key left behind', () => {
  it('warns on every mount until cleared, with Clear offered only once main allows it', async () => {
    let answer = listed({ pending: [pending()] })
    const bridge: ShareBridge = { routeShareList: vi.fn(async () => answer) }
    const store = createShareDevicesStore(bridge)
    await store.read()
    expect(render(store)).toContain('A key may have been left behind')
    expect(render(store)).toMatch(/<button[^>]*disabled=""[^>]*>Clear warning<\/button>/)
    answer = listed({ pending: [pending({ clearable: true, revoked: { at: 'x', left: 0 }, checked: { at: 'y', live: 0 } })] })
    await store.read()
    expect(render(store)).toMatch(/<button[^>]*class="cr-routing-btn"[^>]*>Clear warning<\/button>/)
    expect(render(store)).not.toMatch(/disabled=""[^>]*>Clear warning/)
  })

  it('keeps a failed check on screen, and clears it when the retry works', async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, why: 'The process check could not list running programs.' })
      .mockResolvedValueOnce({ ok: true, left: 0, live: 0 })
    let answer = listed({ pending: [pending()] })
    const bridge: ShareBridge = { routeShareList: vi.fn(async () => answer), routeShareResolve: resolve }
    const store = createShareDevicesStore(bridge)
    await store.read()
    await store.resolve(NAME)
    expect(problemText(store.getSnapshot())).toContain('process check')
    // A read in between does not wipe it: the name is still pending.
    await store.read()
    expect(problemText(store.getSnapshot())).toContain('process check')
    answer = listed({ pending: [pending({ clearable: true })] })
    await store.resolve(NAME)
    await flush()
    expect(problemText(store.getSnapshot())).toBeNull()
    expect(store.getSnapshot().pending[0].clearable).toBe(true)
  })

  it('finishes a revoke-and-check that answers while the panel is closed, and sends one per name', async () => {
    let release: (v: unknown) => void = () => {}
    const resolve = vi.fn(() => new Promise((r) => (release = r)))
    let answer = listed({ pending: [pending()] })
    const store = createShareDevicesStore({ routeShareList: vi.fn(async () => answer), routeShareResolve: resolve as never })
    await store.read()
    const unsubscribe = store.subscribe(() => {})
    const first = store.resolve(NAME)
    void store.resolve(NAME)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(render(store)).toContain('Checking…')
    unsubscribe()
    answer = listed({ pending: [pending({ clearable: true })] })
    release({ ok: true, left: 0, live: 0 })
    await first
    await flush()
    // Reopened: the answer landed on the store, not on the closed panel.
    expect(render(store)).not.toContain('Checking…')
    expect(store.getSnapshot().pending[0].clearable).toBe(true)
  })

  it('drops the warning once a clear is accepted and the list no longer has it', async () => {
    let answer = listed({ pending: [pending({ clearable: true })] })
    const clear = vi.fn(async () => {
      answer = listed()
      return { ok: true as const }
    })
    const store = createShareDevicesStore({ routeShareList: vi.fn(async () => answer), routeShareClear: clear })
    await store.read()
    await store.clear(NAME)
    await flush()
    expect(clear).toHaveBeenCalledWith(NAME)
    expect(store.getSnapshot().pending).toEqual([])
    expect(render(store)).not.toContain('left behind')
  })
})

describe('a window that reloads while main makes a key', () => {
  it('shows busy, looks again until main is done, then shows the key main kept', async () => {
    const timers: (() => void)[] = []
    let answer = listed({ issuing: true })
    const store = createShareDevicesStore({ routeShareList: vi.fn(async () => answer) }, (fn) => void timers.push(fn))
    await store.read()
    expect(store.getSnapshot().issuing).toBe(true)
    expect(render(store)).toContain('Making…')
    expect(timers).toHaveLength(1)
    answer = listed({ keys: [shared], handover: { id: shared.id, device: 'phone', key: KEY } })
    timers.shift()?.()
    await flush()
    expect(store.getSnapshot()).toMatchObject({ issuing: false, issued: { id: shared.id, key: KEY } })
    expect(timers).toHaveLength(0)
  })

  it('tells main Done and never shows that key again from a read that began before', async () => {
    let answer = listed({ keys: [shared], handover: { id: shared.id, device: 'phone', key: KEY } })
    const done = vi.fn(async () => ({ ok: true as const }))
    const store = createShareDevicesStore({ routeShareList: vi.fn(async () => answer), routeShareDone: done })
    await store.read()
    expect(store.getSnapshot().issued?.key).toBe(KEY)
    store.done()
    expect(done).toHaveBeenCalledWith(shared.id)
    await store.read()
    expect(store.getSnapshot().issued).toBeNull()
    answer = listed({ keys: [shared] })
    await store.read()
    expect(store.getSnapshot().issued).toBeNull()
  })

  it('reads again after a failed issue so a key it left behind is warned of at once', async () => {
    let answer = listed()
    const issue = vi.fn(async () => {
      answer = listed({ pending: [pending()] })
      return { ok: false as const, why: 'timed out. Every key it may have made was revoked; a warning stays until you check.' }
    })
    const store = createShareDevicesStore({ routeShareList: vi.fn(async () => answer), routeShareIssue: issue })
    await store.read()
    await store.issue('laptop', 5)
    await flush()
    expect(store.getSnapshot().pending.map((p) => p.name)).toEqual([NAME])
    expect(problemText(store.getSnapshot())).toContain('timed out')
  })

  it('refuses a malformed pending list instead of reading it as none', async () => {
    const store = createShareDevicesStore({ routeShareList: vi.fn(async () => ({ ...listed(), pending: [{ name: 1 }] }) as never) })
    await store.read()
    expect(problemText(store.getSnapshot())).not.toBeNull()
  })
})
