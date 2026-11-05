// BOX ROUND 3, BUG 1. A use card (screen://, window://, cam://, adb://,
// vphone://) is drawn by main's stream from a device, and a device needs no
// Chrome. Pages are the only thing the Chrome decision (launch-defaults.ts)
// owns. On a box with no Chrome both must work at once: pages in the webview,
// use cards on the stream, with nothing set and nothing to choose.
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserInstance } from '../src/main/browser-instance'
import { createBrowserCastIpc } from '../src/main/browser-cast-ipc'
import { commandRunsInMain, mainDrawsCard } from '../src/main/browser-owner'
import { HeadlessBrowserManager } from '../src/main/headless-browser-manager'
import { interactiveBrowserDefault } from '../src/main/launch-defaults'
import { browserRenderMode } from '../src/renderer/src/browser-stream'
import { shouldSnapshotLocally } from '../src/renderer/src/browser-thumb-policy'
import type { BrowserNodeData } from '../src/shared/model'

const USE_URLS = ['screen://main', 'window://Safari?id=12', 'cam://default', 'adb://default', 'vphone://iphone-a']

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

/** A machine with no Chrome: the page decision is off and there is no path to one. */
function noChrome(url: string) {
  const nodes = new Map([['card-1', card(url)]])
  const chrome = vi.fn(() => fake())
  const device = vi.fn(() => fake())
  const gone: string[] = []
  const manager = new HeadlessBrowserManager({
    enabled: () => false,
    chromePath: () => null,
    profileRoot: () => '/profiles',
    resolveNode: (id) => nodes.get(id) ?? null,
    onPageState: vi.fn(),
    onTabOpened: vi.fn(),
    onTabClosed: vi.fn(),
    onInstanceGone: (id) => void gone.push(id),
    makeInstance: chrome,
    vphone: { makeInstance: device },
    uses: { makeInstance: device }
  })
  return { manager, chrome, device, nodes, gone }
}

describe('the manager on a machine with no Chrome', () => {
  it.each(USE_URLS)('%s starts its device for a viewer', async (url) => {
    const { manager, device, chrome } = noChrome(url)
    expect(await manager.get('card-1')).not.toBeNull()
    expect(device).toHaveBeenCalledTimes(1)
    expect(chrome).not.toHaveBeenCalled()
  })

  it.each(USE_URLS)('%s starts its device for a sync', async (url) => {
    const { manager, device } = noChrome(url)
    expect(await manager.syncNode(card(url))).not.toBeNull()
    expect(device).toHaveBeenCalledTimes(1)
  })

  it('a page stays with the webview: no instance, no Chrome', async () => {
    const { manager, chrome, device } = noChrome('https://example.com/')
    expect(await manager.get('card-1')).toBeNull()
    expect(await manager.syncNode(card('https://example.com/'))).toBeNull()
    expect(chrome).not.toHaveBeenCalled()
    expect(device).not.toHaveBeenCalled()
  })

  it('a use card sent to a page lets its device go, and the viewers with it', async () => {
    const { manager, gone } = noChrome('screen://main')
    const running = await manager.syncNode(card('screen://main'))
    expect(await manager.syncNode(card('https://example.com/'))).toBeNull()
    expect(running?.stop).toHaveBeenCalledTimes(1)
    expect(gone).toEqual(['card-1'])
    expect(manager.peek('card-1')).toBeNull()
  })
})

describe('who draws a card', () => {
  it('main draws every use card, whatever owns pages', () => {
    for (const url of USE_URLS) expect(mainDrawsCard(card(url), false)).toBe(true)
  })
  it('main draws a page only when headless Chrome owns pages', () => {
    expect(mainDrawsCard(card('https://example.com/'), false)).toBe(false)
    expect(mainDrawsCard(card('https://example.com/'), true)).toBe(true)
  })
  it('a card that does not exist is drawn by nobody on a webview machine', () => {
    expect(mainDrawsCard(null, false)).toBe(false)
  })
})

describe('where an agent’s command runs on a webview machine', () => {
  const find = (name: string) => (name === 'Screen' ? card('screen://main') : name === 'Page' ? card('https://example.com/') : undefined)

  it('everything runs in main when headless Chrome owns pages', () => {
    expect(commandRunsInMain(['click', 'Page', '#a'], true, find)).toBe(true)
  })
  it('a command on a use card runs in main', () => {
    expect(commandRunsInMain(['screenshot', 'Screen'], false, find)).toBe(true)
  })
  it('making a use card runs in main: no webview would ever mount for it', () => {
    expect(commandRunsInMain(['create', 'screen://main', 'Screen'], false, find)).toBe(true)
  })
  it('a command on a page, or making one, stays with the renderer', () => {
    expect(commandRunsInMain(['click', 'Page', '#a'], false, find)).toBe(false)
    expect(commandRunsInMain(['create', 'https://example.com/', 'Page'], false, find)).toBe(false)
    expect(commandRunsInMain(['click', 'Nobody', '#a'], false, find)).toBe(false)
  })
})

describe('the two decisions are separate in the renderer', () => {
  it('on a webview machine a use card streams on the desktop and on the phone', () => {
    for (const client of ['desktop', 'remote'] as const) {
      expect(browserRenderMode({ interactive: false, client, selfEmbedding: false, vphone: true })).toBe('headless-stream')
    }
  })
  it('a page on the same machine keeps its webview, and the phone its thumbnail', () => {
    expect(browserRenderMode({ interactive: false, client: 'desktop', selfEmbedding: false })).toBe('legacy-webview')
    expect(browserRenderMode({ interactive: false, client: 'remote', selfEmbedding: false })).toBe('legacy-thumb')
  })
  it('the demo has no main process behind it, so it alone keeps the still card', () => {
    expect(browserRenderMode({ interactive: false, client: 'demo', selfEmbedding: false, vphone: true })).toBe('vphone-off')
  })
  it('a use card on a webview machine still gets a card picture on the desktop', () => {
    expect(shouldSnapshotLocally({ remote: false, interactive: false })).toBe(true)
    expect(shouldSnapshotLocally({ remote: false, interactive: null })).toBe(false)
    expect(shouldSnapshotLocally({ remote: true, interactive: false })).toBe(false)
  })
})

describe('the viewer’s door', () => {
  it('the desktop port opens for a use card with pages on the webview', async () => {
    const posted: unknown[] = []
    const port = { on: vi.fn(), start: vi.fn(), postMessage: (m: unknown) => void posted.push(m), close: vi.fn() }
    const getInstance = vi.fn(async () => null)
    const drawn = (id: string): boolean => id === 'use-card'
    const ipc = createBrowserCastIpc({ enabled: drawn, getInstance })
    ipc.open('page-card', port as never)
    expect(port.close).toHaveBeenCalledTimes(1)
    expect(getInstance).not.toHaveBeenCalled()
    ipc.open('use-card', port as never)
    expect(getInstance).toHaveBeenCalledWith('use-card')
  })

  it('main wires every stream gate to the per-card answer, and the desktop always holds its token', () => {
    const index = readFileSync('src/main/index.ts', 'utf8')
    const gates = index.match(/createBrowserCast(Ipc)?\(\{[\s\S]*?enabled: (\w+)/g) ?? []
    expect(gates).toHaveLength(2)
    for (const gate of gates) expect(gate).toMatch(/enabled: streamsCard$/)
    const hook = readFileSync('src/renderer/src/BrowserLayer.tsx', 'utf8')
    expect(hook).not.toMatch(/!enabled \|\| !hasNativeWebview\(\)/)
  })
})

describe('the launch default', () => {
  it('a Chrome that is not there cannot be switched on: pages keep their webview', () => {
    expect(interactiveBrowserDefault({ COOKREW_INTERACTIVE_BROWSER: '1' }, () => false)).toBe(false)
  })
  it('it can still be switched off with a Chrome there', () => {
    expect(interactiveBrowserDefault({ COOKREW_INTERACTIVE_BROWSER: '0' }, () => true)).toBe(false)
  })
})
