// A USE CARD'S INSTANCE (main/headless-browser-manager.ts): the address picks
// the device, no Chrome is spent on one, and a card re-addressed to another
// device lets the old one go and gets the new one.
import { describe, expect, it, vi } from 'vitest'
import type { BrowserInstance } from '../src/main/browser-instance'
import { HeadlessBrowserManager, backingOf } from '../src/main/headless-browser-manager'
import type { BrowserNodeData } from '../src/shared/model'
import type { UseTarget } from '../src/shared/use-url'

const card = (url: string): BrowserNodeData => ({
  kind: 'browser',
  id: 'card-1',
  name: 'Card',
  url,
  tabs: [{ id: 'tab-1', url, title: '' }],
  activeTabId: 'tab-1',
  position: { x: 0, y: 0 },
  size: { width: 720, height: 560 }
})

const fake = (): BrowserInstance =>
  ({
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => ({ pid: null, forced: false })),
    syncTabs: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    onExit: () => undefined,
    onPageState: () => undefined,
    onTabOpened: () => undefined,
    onTabClosed: () => undefined
  }) as unknown as BrowserInstance

function bed(url: string) {
  const nodes = new Map([['card-1', card(url)]])
  const chrome = vi.fn(() => fake())
  const made: Array<{ target: UseTarget; instance: BrowserInstance }> = []
  const gone: string[] = []
  const manager = new HeadlessBrowserManager({
    onInstanceGone: (id) => void gone.push(id),
    enabled: () => true,
    chromePath: () => '/fake/chrome',
    profileRoot: () => '/profiles',
    resolveNode: (id) => nodes.get(id) ?? null,
    onPageState: vi.fn(),
    onTabOpened: vi.fn(),
    onTabClosed: vi.fn(),
    makeInstance: chrome,
    uses: {
      makeInstance: (target) => {
        const instance = fake()
        made.push({ target, instance })
        return instance
      }
    }
  })
  return { manager, chrome, made, nodes, gone }
}

describe('a use card', () => {
  it('is backed by its device, with no Chrome', async () => {
    const { manager, chrome, made } = bed('adb://default')
    const got = await manager.get('card-1')
    expect(got).toBe(made[0].instance)
    expect(made[0].target).toMatchObject({ kind: 'adb', name: 'default' })
    expect(chrome).not.toHaveBeenCalled()
  })

  it('re-addressed to another device: the old one is stopped, its viewers let go, the new one made', async () => {
    const { manager, made, gone } = bed('adb://default')
    await manager.syncNode(card('adb://default'))
    await manager.syncNode(card('adb://default'))
    expect(made).toHaveLength(1)
    const second = await manager.syncNode(card('window://Simulator'))
    expect(made).toHaveLength(2)
    expect(made[0].instance.stop).toHaveBeenCalled()
    expect(gone).toEqual(['card-1'])
    expect(second).toBe(made[1].instance)
    await manager.remove('card-1')
    expect(gone).toEqual(['card-1', 'card-1'])
  })

  it('a web card navigating between pages keeps its one Chrome', async () => {
    const { manager, chrome } = bed('https://a.test')
    await manager.syncNode(card('https://a.test'))
    await manager.syncNode(card('https://b.test'))
    expect(chrome).toHaveBeenCalledTimes(1)
  })
})

describe('backingOf', () => {
  it('one string per thing that needs its own instance', () => {
    expect(backingOf(card('https://a.test'))).toBe('chrome')
    expect(backingOf(card('https://b.test'))).toBe('chrome')
    expect(backingOf(card('vphone://m/com.apple.Maps'))).toBe(backingOf(card('vphone://m')))
    expect(backingOf(card('screen://main?roi=0,0,100,100'))).not.toBe(backingOf(card('screen://main')))
  })
})
