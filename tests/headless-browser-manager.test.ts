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

function managerWith(instanceFactory: (options: HeadlessOptions) => HeadlessInstance) {
  const nodes = new Map([[browser().id, browser()]])
  return new HeadlessBrowserManager({
    enabled: () => true,
    chromePath: () => '/fake/chrome',
    profileRoot: () => '/profiles',
    resolveNode: (id) => nodes.get(id) ?? null,
    onPageState: vi.fn(),
    onTabOpened: vi.fn(),
    onTabClosed: vi.fn(),
    makeInstance: instanceFactory
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

  it('stops and forgets an instance when its node is removed', async () => {
    const instance = fakeInstance()
    const manager = managerWith(() => instance)
    await manager.syncNode(browser())

    await manager.remove(browser().id)

    expect(instance.stop).toHaveBeenCalledTimes(1)
    expect(manager.activeCount()).toBe(0)
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
