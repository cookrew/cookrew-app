// EVERY CARD'S CHROME KEEPS ITS LOGINS ACROSS A RESTART (owner 11-28: all
// cards, all sites, default on). A Chrome being let go hands its cookies to the
// vault first, inside a bound; the next Chrome for the card starts with them.
import { describe, expect, it, vi } from 'vitest'
import type { BrowserNodeData } from '../src/shared/model'
import { HeadlessBrowserManager, type HeadlessBrowserManagerDeps } from '../src/main/headless-browser-manager'
import { HeadlessInstance, type HeadlessCookie, type HeadlessOptions } from '../src/main/headless-chrome'
import type { VaultCookie } from '../src/main/card-cookie-shape'

const KEPT: VaultCookie = { name: 'login_aliyunid_ticket', value: 'T-1', domain: '.aliyun.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' }
const PRIMED: HeadlessCookie = { name: 'magpie_web_3433', value: 'k', url: 'http://127.0.0.1:3433/', domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }
const RAW = [{ ...KEPT, expires: -1, session: true, size: 24 }]

const card = (id = 'card-1'): BrowserNodeData => ({
  kind: 'browser',
  id,
  name: 'Aliyun',
  url: 'https://www.aliyun.com/',
  tabs: [{ id: `${id}-tab`, url: 'https://www.aliyun.com/', title: '' }],
  activeTabId: `${id}-tab`,
  position: { x: 0, y: 0 },
  size: { width: 720, height: 560 }
})

interface Fake {
  instance: HeadlessInstance
  order: string[]
  getCookies: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

function fake(getCookies: () => Promise<readonly unknown[]> = async () => RAW): Fake {
  const order: string[] = []
  const get = vi.fn(async () => {
    order.push('getCookies')
    return getCookies()
  })
  const stop = vi.fn(async () => {
    order.push('stop')
    return { pid: 1, forced: false }
  })
  const instance = {
    start: vi.fn(async () => {}),
    stop,
    syncTabs: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    setCookies: vi.fn(async () => {}),
    getCookies: get,
    onExit: () => undefined,
    onPageState: () => undefined,
    onTabClosed: () => undefined
  } as unknown as HeadlessInstance
  return { instance, order, getCookies: get, stop }
}

function vault(kept: readonly VaultCookie[] | null = null) {
  const saved: Array<[string, readonly unknown[]]> = []
  return {
    saved,
    load: vi.fn((_id: string) => kept),
    save: vi.fn((id: string, cookies: readonly unknown[]) => {
      saved.push([id, cookies])
      return { saved: cookies.length }
    })
  }
}

function manager(make: (o: HeadlessOptions) => HeadlessInstance, over: Partial<HeadlessBrowserManagerDeps> = {}) {
  const nodes = new Map([card(), card('card-2')].map((n) => [n.id, n]))
  return new HeadlessBrowserManager({
    enabled: () => true,
    chromePath: () => '/fake/chrome',
    profileRoot: () => '/profiles',
    resolveNode: (id) => nodes.get(id) ?? null,
    onPageState: vi.fn(),
    onTabOpened: vi.fn(),
    onTabClosed: vi.fn(),
    makeInstance: make,
    ...over
  })
}

describe('restore on start', () => {
  it('starts a card Chrome with the cookies its vault kept', async () => {
    const made: HeadlessOptions[] = []
    const v = vault([KEPT])
    const m = manager((o) => (made.push(o), fake().instance), { cookieVault: v })
    await m.syncNode(card())
    expect(v.load).toHaveBeenCalledWith('card-1')
    expect(made[0].restoredCookies).toEqual([KEPT])
    expect(made[0].cookies).toBeUndefined()
  })

  it('hands primed cookies alongside, so the restore can let them win', async () => {
    const made: HeadlessOptions[] = []
    const m = manager((o) => (made.push(o), fake().instance), { cookieVault: vault([KEPT]) })
    await m.primeCookies('card-1', [PRIMED])
    await m.syncNode(card())
    expect(made[0].cookies).toEqual([PRIMED])
    expect(made[0].restoredCookies).toEqual([KEPT])
  })

  it('starts as before when there is no vault, an empty one, or one that throws', async () => {
    const made: HeadlessOptions[] = []
    const throwing = { load: () => { throw new Error('boom') }, save: () => ({ saved: 0 }) }
    for (const cookieVault of [undefined, vault(null), vault([]), throwing]) {
      const m = manager((o) => (made.push(o), fake().instance), { cookieVault })
      expect(await m.syncNode(card())).not.toBeNull()
    }
    expect(made.map((o) => o.restoredCookies)).toEqual([undefined, undefined, undefined, undefined])
  })
})

describe('capture before Chrome is closed', () => {
  it('saves every live card at shutdown, before its Chrome is stopped', async () => {
    const a = fake()
    const b = fake(async () => [])
    const queue = [a, b]
    const v = vault()
    const m = manager(() => queue.shift()!.instance, { cookieVault: v })
    await m.syncNode(card())
    await m.syncNode(card('card-2'))
    await m.shutdown()
    expect(v.saved).toEqual([['card-1', RAW], ['card-2', []]])
    expect(a.order).toEqual(['getCookies', 'stop'])
    expect(b.order).toEqual(['getCookies', 'stop'])
  })

  it('also keeps them when a card is stopped mid-run (a switch, an idle stop)', async () => {
    const a = fake()
    const v = vault()
    const m = manager(() => a.instance, { cookieVault: v })
    await m.syncNode(card())
    await m.remove('card-1')
    expect(v.saved.map(([id]) => id)).toEqual(['card-1'])
    expect(a.order).toEqual(['getCookies', 'stop'])
  })

  it('keeps nothing for a card being deleted', async () => {
    const a = fake()
    const v = vault()
    const m = manager(() => a.instance, { cookieVault: v, deleteProfile: vi.fn() })
    await m.syncNode(card())
    await m.discard('card-1')
    expect(a.getCookies).not.toHaveBeenCalled()
    expect(v.save).not.toHaveBeenCalled()
    expect(a.stop).toHaveBeenCalled()
  })

  it('bounds the whole capture: a Chrome that never answers is closed anyway, its old vault kept', async () => {
    vi.useFakeTimers()
    try {
      const hung = fake(() => new Promise<readonly unknown[]>(() => undefined))
      const fine = fake()
      const queue = [hung, fine]
      const v = vault()
      const lines: string[] = []
      const m = manager(() => queue.shift()!.instance, { cookieVault: v, cookieCaptureMs: 3000, log: (line) => lines.push(line) })
      await m.syncNode(card())
      await m.syncNode(card('card-2'))
      let done = false
      const shut = m.shutdown().then(() => (done = true))
      await vi.advanceTimersByTimeAsync(2999)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await shut
      expect(hung.stop).toHaveBeenCalled()
      expect(v.saved.map(([id]) => id)).toEqual(['card-2'])
      expect(lines.join('\n')).toMatch(/card-1.*3000 ms/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a failing capture or a failing save not block the stop', async () => {
    const broken = fake(async () => {
      throw new Error('Target closed')
    })
    const fine = fake()
    const queue = [broken, fine]
    const throwingSave = { load: () => null, save: vi.fn(() => { throw new Error('disk full') }) }
    const m = manager(() => queue.shift()!.instance, { cookieVault: throwingSave, log: () => undefined })
    await m.syncNode(card())
    await m.syncNode(card('card-2'))
    await expect(m.shutdown()).resolves.toBeUndefined()
    expect(broken.stop).toHaveBeenCalled()
    expect(fine.stop).toHaveBeenCalled()
    expect(throwingSave.save).toHaveBeenCalledTimes(1)
  })

  it('skips an instance that has no cookies to give (a device card)', async () => {
    const device = fake()
    delete (device.instance as { getCookies?: unknown }).getCookies
    const v = vault()
    const m = manager(() => device.instance, { cookieVault: v })
    await m.syncNode(card())
    await m.shutdown()
    expect(v.save).not.toHaveBeenCalled()
    expect(device.stop).toHaveBeenCalled()
  })
})

describe('HeadlessInstance.getCookies', () => {
  const options: HeadlessOptions = { executablePath: '/x', profileDir: '/tmp/p', width: 800, height: 600, tabs: [], activeTabId: 't' }

  it('asks the browser for every cookie in its default context', async () => {
    const instance = new HeadlessInstance(options)
    const send = vi.fn(async () => ({ cookies: RAW }))
    ;(instance as unknown as { browserCdp: { send: typeof send } }).browserCdp = { send }
    expect(await instance.getCookies()).toEqual(RAW)
    expect(send).toHaveBeenCalledWith('Storage.getCookies', {})
  })

  it('rejects when the browser is not attached', async () => {
    await expect(new HeadlessInstance(options).getCookies()).rejects.toThrow(/not running/)
  })
})
