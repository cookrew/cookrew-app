// A STREAMED CARD SIGNED IN BY MAIN (magpie-card-open.ts): the cookie goes into
// the running Chrome, and into the options of every Chrome started for the card
// later this run, so its first request already carries it. Removing the card
// forgets it.
import { describe, expect, it, vi } from 'vitest'
import type { BrowserNodeData } from '../src/shared/model'
import { HeadlessBrowserManager } from '../src/main/headless-browser-manager'
import type { HeadlessCookie, HeadlessInstance, HeadlessOptions } from '../src/main/headless-chrome'

const COOKIE: HeadlessCookie = { name: 'magpie_web_3433', value: 'cookrew-key-0123456789', url: 'http://127.0.0.1:3433/', domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }

const card = (id = 'magpie-card'): BrowserNodeData => ({
  kind: 'browser',
  id,
  name: 'Magpie',
  url: 'http://127.0.0.1:3433/',
  tabs: [{ id: `${id}-tab`, url: 'http://127.0.0.1:3433/', title: '' }],
  activeTabId: `${id}-tab`,
  position: { x: 0, y: 0 },
  size: { width: 720, height: 560 }
})

function fake(): HeadlessInstance & { setCookies: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => ({ pid: 1, forced: false })),
    syncTabs: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    setCookies: vi.fn(async () => {}),
    onExit: () => undefined,
    onPageState: () => undefined,
    onTabClosed: () => undefined
  } as unknown as HeadlessInstance & { setCookies: ReturnType<typeof vi.fn> }
}

function manager(make: (o: HeadlessOptions) => HeadlessInstance): HeadlessBrowserManager {
  const nodes = new Map([[card().id, card()]])
  return new HeadlessBrowserManager({
    enabled: () => true,
    chromePath: () => '/fake/chrome',
    profileRoot: () => '/profiles',
    resolveNode: (id) => nodes.get(id) ?? null,
    onPageState: vi.fn(),
    onTabOpened: vi.fn(),
    onTabClosed: vi.fn(),
    makeInstance: make
  })
}

describe('primeCookies', () => {
  it('starts every later Chrome for the card with the cookie already set', async () => {
    const made: HeadlessOptions[] = []
    const m = manager((o) => {
      made.push(o)
      return fake()
    })
    await m.primeCookies(card().id, [COOKIE])
    await m.syncNode(card())
    expect(made[0].cookies).toEqual([COOKIE])
  })

  it('sets it in a Chrome already running for the card', async () => {
    const instance = fake()
    const m = manager(() => instance)
    await m.syncNode(card())
    await m.primeCookies(card().id, [COOKIE])
    expect(instance.setCookies).toHaveBeenCalledWith([COOKIE])
  })

  it('gives no other card the cookie, keeps it across a stop, and forgets it with the card', async () => {
    const made: HeadlessOptions[] = []
    const m = manager((o) => {
      made.push(o)
      return fake()
    })
    await m.primeCookies(card().id, [COOKIE])
    await m.syncNode(card('another'))
    expect(made[0].cookies).toBeUndefined()
    await m.remove(card().id)
    await m.syncNode(card())
    expect(made.at(-1)?.cookies).toEqual([COOKIE])
    await m.discard(card().id)
    await m.syncNode(card())
    expect(made.at(-1)?.cookies).toBeUndefined()
  })

  it('keeps the cookie for the next start when the running Chrome cannot take it now', async () => {
    const instance = fake()
    instance.setCookies.mockRejectedValueOnce(new Error('The browser is not running.'))
    const made: HeadlessOptions[] = []
    const m = manager((o) => {
      made.push(o)
      return instance
    })
    await m.syncNode(card())
    await expect(m.primeCookies(card().id, [COOKIE])).resolves.toBeUndefined()
  })
})
