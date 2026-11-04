import { describe, expect, it, vi } from 'vitest'
import type { BrowserNodeData } from '../src/shared/model'
import { HeadlessBrowserManager } from '../src/main/headless-browser-manager'
import type { HeadlessInstance, HeadlessOptions } from '../src/main/headless-chrome'

function browser(id = 'browser-1'): BrowserNodeData {
  return {
    kind: 'browser',
    id,
    name: 'Browser',
    url: 'https://example.test',
    tabs: [{ id: `${id}-tab`, url: 'https://example.test', title: '' }],
    activeTabId: `${id}-tab`,
    position: { x: 0, y: 0 },
    size: { width: 720, height: 560 }
  }
}

function fakeInstance(start: () => Promise<void> = () => Promise.resolve()): HeadlessInstance {
  return {
    start: vi.fn(start),
    stop: vi.fn(() => Promise.resolve({ pid: 1, forced: false })),
    syncTabs: vi.fn(() => Promise.resolve()),
    resize: vi.fn(() => Promise.resolve()),
    onExit: () => undefined,
    onPageState: () => undefined,
    onTabClosed: () => undefined
  } as unknown as HeadlessInstance
}

function managerWith(
  instanceFactory: (options: HeadlessOptions) => HeadlessInstance,
  deleteProfile?: (browserId: string) => void | Promise<void>,
  now?: () => number
) {
  const nodes = new Map([[browser().id, browser()]])
  return new HeadlessBrowserManager({
    enabled: () => true,
    chromePath: () => '/fake/chrome',
    profileRoot: () => '/profiles',
    resolveNode: (id) => nodes.get(id) ?? null,
    onPageState: vi.fn(),
    onTabOpened: vi.fn(),
    onTabClosed: vi.fn(),
    deleteProfile,
    makeInstance: instanceFactory,
    now
  })
}

describe('HeadlessBrowserManager node ownership', () => {
  it('restores cold browser cards without launching Chromium', async () => {
    const makeInstance = vi.fn(() => fakeInstance())
    const manager = managerWith(makeInstance)

    await manager.replaceNodes([browser(), browser('browser-2')])

    expect(makeInstance).not.toHaveBeenCalled()
    expect(manager.activeCount()).toBe(0)
    expect(manager.startingCount()).toBe(0)
  })

  it('keeps an already-live instance synchronized across restoration', async () => {
    const instance = fakeInstance()
    const makeInstance = vi.fn(() => instance)
    const manager = managerWith(makeInstance)
    await manager.get(browser().id)
    const restored = { ...browser(), size: { width: 900, height: 700 } }
    vi.mocked(instance.syncTabs).mockClear()
    vi.mocked(instance.resize).mockClear()

    await manager.replaceNodes([restored, browser('browser-2')])

    expect(makeInstance).toHaveBeenCalledTimes(1)
    expect(instance.syncTabs).toHaveBeenCalledTimes(1)
    expect(instance.resize).toHaveBeenCalledWith(900, 700)
    expect(manager.activeCount()).toBe(1)
  })

  it('starts one instance for a node and reuses it across syncs', async () => {
    const instance = fakeInstance()
    const makeInstance = vi.fn(() => instance)
    const manager = managerWith(makeInstance)

    await manager.syncNode(browser())
    await manager.syncNode(browser())

    expect(makeInstance).toHaveBeenCalledTimes(1)
    expect(instance.start).toHaveBeenCalledTimes(1)
    expect(instance.syncTabs).toHaveBeenCalledTimes(2)
    expect(manager.activeCount()).toBe(1)
  })

  it('lists the cards whose page is running, never a cold one', async () => {
    // residentBrowsers() keeps these through a switch (owner ruling
    // 2026-11-04): a page an agent is driving in a workspace nobody is looking
    // at must not be stopped by the switch's replace-the-world call.
    const manager = managerWith(vi.fn(() => fakeInstance()))
    await manager.replaceNodes([browser(), browser('browser-2')])
    expect(manager.liveIds()).toEqual([])
    await manager.syncNode(browser())
    expect(manager.liveIds()).toEqual(['browser-1'])
  })

  it('names only the pages used since a moment — an idle page may be reclaimed', async () => {
    // Review finding (HIGH): keeping EVERY live page through every switch
    // left no reclaim but delete or quit. A page counts as in use when an
    // agent command or a viewer touched it (syncNode/get); a thumbnail peek
    // is not use.
    let clock = 1_000
    const manager = managerWith(vi.fn(() => fakeInstance()), undefined, () => clock)
    await manager.syncNode(browser())
    clock = 5_000
    await manager.syncNode(browser('browser-2'))
    manager.peek('browser-1')
    expect(manager.liveIds(4_000)).toEqual(['browser-2'])
    clock = 9_000
    await manager.get('browser-1')
    expect(manager.liveIds(8_000)).toEqual(['browser-1'])
    await manager.remove('browser-1')
    expect(manager.liveIds(0)).toEqual(['browser-2'])
  })

  it('stops and forgets an instance when its node is removed', async () => {
    const instance = fakeInstance()
    const manager = managerWith(() => instance)
    await manager.syncNode(browser())

    await manager.remove(browser().id)

    expect(instance.stop).toHaveBeenCalledTimes(1)
    expect(manager.activeCount()).toBe(0)
  })

  it('keeps a profile when a workspace switch only deactivates its node', async () => {
    const deleteProfile = vi.fn()
    const manager = managerWith(() => fakeInstance(), deleteProfile)
    await manager.replaceNodes([browser()])

    await manager.replaceNodes([])

    expect(deleteProfile).not.toHaveBeenCalled()
  })

  it('deletes a profile only after permanent node discard', async () => {
    const instance = fakeInstance()
    const deleteProfile = vi.fn()
    const manager = managerWith(() => instance, deleteProfile)
    await manager.syncNode(browser())

    await manager.discard(browser().id)

    expect(instance.stop).toHaveBeenCalledTimes(1)
    expect(deleteProfile).toHaveBeenCalledWith(browser().id)
  })

  it('waits for an in-flight workspace deactivation before deleting the profile', async () => {
    let finishStop!: () => void
    const instance = fakeInstance()
    instance.stop = vi.fn(
      () => new Promise<{ pid: number | null; forced: boolean }>((resolve) => {
        finishStop = () => resolve({ pid: 1, forced: false })
      }),
    )
    const deleteProfile = vi.fn()
    const manager = managerWith(() => instance, deleteProfile)
    await manager.syncNode(browser())

    const deactivating = manager.remove(browser().id)
    const discarding = manager.discard(browser().id)
    await Promise.resolve()
    expect(instance.stop).toHaveBeenCalledTimes(1)
    expect(deleteProfile).not.toHaveBeenCalled()

    finishStop()
    await Promise.all([deactivating, discarding])
    expect(deleteProfile).toHaveBeenCalledWith(browser().id)
  })

  it('cancels a starting instance on node removal without promoting it', async () => {
    let finishStart!: () => void
    const instance = fakeInstance(
      () => new Promise<void>((resolve) => (finishStart = resolve))
    )
    const manager = managerWith(() => instance)
    const starting = manager.syncNode(browser())

    expect(manager.startingCount()).toBe(1)
    const removed = manager.remove(browser().id)
    expect(instance.stop).toHaveBeenCalledTimes(1)
    finishStart()

    await removed
    await expect(starting).resolves.toBeNull()
    expect(manager.activeCount()).toBe(0)
    expect(manager.startingCount()).toBe(0)
  })

  it('stops instances in the starting map during app shutdown', async () => {
    let finishStart!: () => void
    const instance = fakeInstance(
      () => new Promise<void>((resolve) => (finishStart = resolve))
    )
    const manager = managerWith(() => instance)
    const starting = manager.syncNode(browser())

    const shutdown = manager.shutdown()
    expect(instance.stop).toHaveBeenCalledTimes(1)
    finishStart()

    await shutdown
    await expect(starting).resolves.toBeNull()
    expect(manager.activeCount()).toBe(0)
    expect(manager.startingCount()).toBe(0)
  })

  it('does not resolve shutdown until an active child has exited', async () => {
    let finishStop!: () => void
    const instance = fakeInstance()
    instance.stop = vi.fn(
      () =>
        new Promise<{ pid: number | null; forced: boolean }>((resolve) => {
          finishStop = () => resolve({ pid: 1, forced: false })
        })
    )
    const manager = managerWith(() => instance)
    await manager.syncNode(browser())

    let settled = false
    const shutdown = manager.shutdown().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    finishStop()
    await shutdown
    expect(settled).toBe(true)
  })
})

describe('a vphone card', () => {
  const phone = (): BrowserNodeData => ({
    ...browser('phone-1'),
    url: 'vphone://myphone',
    tabs: [{ id: 'phone-1-tab', url: 'vphone://myphone', title: '' }],
    activeTabId: 'phone-1-tab'
  })

  it('is backed by a vphone instance for its machine, with no Chrome at all', async () => {
    const makeInstance = vi.fn(() => fakeInstance())
    const vphoneInstance = fakeInstance()
    const makeVphone = vi.fn(() => vphoneInstance)
    const nodes = new Map([[phone().id, phone()]])
    const manager = new HeadlessBrowserManager({
      enabled: () => true,
      chromePath: () => null,
      profileRoot: () => '/profiles',
      resolveNode: (id) => nodes.get(id) ?? null,
      onPageState: vi.fn(),
      onTabOpened: vi.fn(),
      onTabClosed: vi.fn(),
      makeInstance,
      vphone: { makeInstance: makeVphone }
    })
    const got = await manager.get('phone-1')
    expect(got).toBe(vphoneInstance)
    expect(makeInstance).not.toHaveBeenCalled()
    expect(makeVphone).toHaveBeenCalledWith('myphone', expect.objectContaining({ id: 'phone-1' }))
    expect(manager.activeCount()).toBe(1)
  })

  it('is unavailable, not a Chrome, when the desktop has no vphone wired', async () => {
    const makeInstance = vi.fn(() => fakeInstance())
    const nodes = new Map([[phone().id, phone()]])
    const manager = new HeadlessBrowserManager({
      enabled: () => true,
      chromePath: () => '/fake/chrome',
      profileRoot: () => '/profiles',
      resolveNode: (id) => nodes.get(id) ?? null,
      onPageState: vi.fn(),
      onTabOpened: vi.fn(),
      onTabClosed: vi.fn(),
      makeInstance
    })
    expect(await manager.get('phone-1')).toBeNull()
    expect(makeInstance).not.toHaveBeenCalled()
  })
})
