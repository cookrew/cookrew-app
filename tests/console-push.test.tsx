import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { CONSOLE_OPEN_MESSAGE as WORKER_SAYS } from '../scripts/console-sw.mjs'
import {
  CONSOLE_OPEN_MESSAGE,
  PUSH_KEPT_KEY,
  createConsolePush,
  isIos,
  keyBytes,
  pushLabel,
  pushRowLine,
  pushSupport,
  pushWords,
  routeOfOpenMessage,
  type PushDeps,
  type PushEnv,
  type PushManagerLike,
  type PushState,
  type PushSubscriptionLike
} from '../src/renderer/src/console/console-push'
import { PushMenuItem } from '../src/renderer/src/console/ConsolePushItem'
import type { Answer } from '../src/renderer/src/console/console-session'

/**
 * THE CONSOLE'S "TURN ON NOTIFICATIONS" (HITL phase 4): what the browser can
 * do, the order a press runs in (permission first, while the press still
 * counts), what is filed at the registry and kept here, and the way off.
 */

const MACHINE = '1a2b3c4d-1111-4111-8111-11111111abcd'
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
const IPAD_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const WIN_FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0'
const WIN_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'

const PUBLIC_KEY = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url')
const READY: PushEnv = { notification: true, serviceWorker: true, pushManager: true, ios: false, standalone: false }

describe('what this browser can do', () => {
  it('is ready with notifications, a worker and a push manager; an iPhone outside the Home Screen is told to add it', () => {
    expect(pushSupport(READY)).toBe('ready')
    expect(pushSupport({ ...READY, pushManager: false, notification: false, ios: true, standalone: false })).toBe('home-screen')
    expect(pushSupport({ ...READY, pushManager: false, ios: true, standalone: true })).toBe('unsupported')
    expect(pushSupport({ ...READY, pushManager: false })).toBe('unsupported')
    expect(pushSupport({ ...READY, serviceWorker: false })).toBe('unsupported')
  })

  it('knows an iPhone, and an iPad that says it is a Mac', () => {
    expect(isIos(IPHONE_SAFARI, 5)).toBe(true)
    expect(isIos(IPAD_DESKTOP_UA, 5)).toBe(true)
    expect(isIos(IPAD_DESKTOP_UA, 0)).toBe(false)
    expect(isIos(ANDROID_CHROME, 5)).toBe(false)
  })

  it('labels the subscription by platform and browser, in a line the registry takes', () => {
    expect(pushLabel(IPHONE_SAFARI, 5)).toBe('iPhone · Safari')
    expect(pushLabel(IPAD_DESKTOP_UA, 5)).toBe('iPad · Safari')
    expect(pushLabel(ANDROID_CHROME, 5)).toBe('Android · Chrome')
    expect(pushLabel(MAC_CHROME, 0)).toBe('Mac · Chrome')
    expect(pushLabel(WIN_FIREFOX, 0)).toBe('Windows · Firefox')
    expect(pushLabel(WIN_EDGE, 0)).toBe('Windows · Edge')
    expect(pushLabel('', 0)).toBe('Browser')
    for (const ua of [IPHONE_SAFARI, ANDROID_CHROME, WIN_EDGE, '']) expect(pushLabel(ua, 0).length).toBeLessThanOrEqual(64)
  })

  it('reads the registry’s key as the bytes a subscribe takes, and nothing else as a key', () => {
    const bytes = keyBytes(PUBLIC_KEY)
    expect(bytes?.byteLength).toBe(65)
    expect(bytes?.[0]).toBe(4)
    expect(keyBytes('short')).toBeNull()
    expect(keyBytes(`${PUBLIC_KEY}+`)).toBeNull()
    expect(keyBytes(Buffer.alloc(65, 4).toString('base64url'))?.byteLength).toBe(65)
  })
})

describe('where a press on a notification goes', () => {
  it('speaks the worker’s word', () => {
    expect(CONSOLE_OPEN_MESSAGE).toBe(WORKER_SAYS)
  })

  it('takes the worker’s address as a route of this page, and nothing else', () => {
    expect(routeOfOpenMessage({ type: CONSOLE_OPEN_MESSAGE, path: `/d/${MACHINE}/w/ws_1/a/agent-7` })).toEqual({ kind: 'machine', machine: MACHINE, workspace: 'ws_1', agent: 'agent-7', side: 'agents' })
    expect(routeOfOpenMessage({ type: CONSOLE_OPEN_MESSAGE, path: '/' })).toEqual({ kind: 'devices' })
    for (const data of [null, 'take-over', { type: 'other', path: '/' }, { type: CONSOLE_OPEN_MESSAGE }, { type: CONSOLE_OPEN_MESSAGE, path: '//evil.example/x' }, { type: CONSOLE_OPEN_MESSAGE, path: 'https://evil.example/' }, { type: CONSOLE_OPEN_MESSAGE, path: '/auth/complete?code=x&state=y' }]) {
      expect(routeOfOpenMessage(data), JSON.stringify(data)).toBeNull()
    }
  })
})

// ── the controller ──────────────────────────────────────────────────────────

interface Rig {
  deps: PushDeps
  calls: { method: string; path: string; body?: unknown }[]
  answers: Map<string, Answer>
  kept: Map<string, string>
  manager: PushManagerLike & { held: PushSubscriptionLike | null; subscribed: unknown[] }
  order: string[]
  permission: { now: NotificationPermission; after: NotificationPermission }
}

function subscription(endpoint: string, key: Uint8Array | null, order: string[]): PushSubscriptionLike {
  return {
    endpoint,
    options: { applicationServerKey: key === null ? null : key.slice().buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: 'P256DH', auth: 'AUTH' } }),
    unsubscribe: vi.fn(async () => {
      order.push(`unsubscribe ${endpoint}`)
      return true
    })
  }
}

function rig(env: PushEnv = READY): Rig {
  const calls: Rig['calls'] = []
  const order: string[] = []
  const answers = new Map<string, Answer>([
    ['GET /v2/me/push/key', { status: 200, body: { publicKey: PUBLIC_KEY } }],
    ['POST /v2/me/push/subscriptions', { status: 201, body: { id: 'S'.repeat(22) } }]
  ])
  const kept = new Map<string, string>()
  const permission = { now: 'default' as NotificationPermission, after: 'granted' as NotificationPermission }
  const manager: Rig['manager'] = {
    held: null,
    subscribed: [],
    getSubscription: async () => manager.held,
    subscribe: async (options) => {
      order.push('subscribe')
      manager.subscribed.push(options)
      manager.held = subscription('https://fcm.googleapis.com/fcm/send/new', options.applicationServerKey, order)
      return manager.held
    }
  }
  const deps: PushDeps = {
    call: async (method, path, body) => {
      order.push(`${method} ${path}`)
      calls.push({ method, path, ...(body === undefined ? {} : { body }) })
      return answers.get(`${method} ${path.replace(/[A-Za-z0-9_-]{22}$/, ':id')}`) ?? answers.get(`${method} ${path}`) ?? { status: 404, body: { error: 'not_found' } }
    },
    env,
    permission: () => permission.now,
    requestPermission: () => {
      order.push('requestPermission')
      return Promise.resolve(permission.after).then((after) => {
        permission.now = after
        return after
      })
    },
    pushManager: async () => manager,
    kept: { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v), removeItem: (k) => void kept.delete(k) },
    label: 'Android · Chrome'
  }
  return { deps, calls, answers, kept, manager, order, permission }
}

describe('checking, when the menu opens', () => {
  it('hides the control on a registry with push off', async () => {
    const r = rig()
    r.answers.set('GET /v2/me/push/key', { status: 404, body: { error: 'push_off' } })
    const push = createConsolePush(r.deps)
    await push.check()
    expect(push.get().status).toBe('hidden')
  })

  it('says off, on, blocked, or what to do on an iPhone', async () => {
    const off = createConsolePush(rig().deps)
    await off.check()
    expect(off.get().status).toBe('off')

    const r = rig()
    r.permission.now = 'granted'
    r.manager.held = subscription('https://fcm.googleapis.com/fcm/send/mine', keyBytes(PUBLIC_KEY), r.order)
    r.kept.set(PUSH_KEPT_KEY, JSON.stringify({ id: 'S'.repeat(22), endpoint: 'https://fcm.googleapis.com/fcm/send/mine' }))
    const on = createConsolePush(r.deps)
    await on.check()
    expect(on.get().status).toBe('on')

    const b = rig()
    b.permission.now = 'denied'
    const blocked = createConsolePush(b.deps)
    await blocked.check()
    expect(blocked.get().status).toBe('blocked')

    const phone = createConsolePush(rig({ ...READY, pushManager: false, ios: true }).deps)
    await phone.check()
    expect(phone.get().status).toBe('home-screen')
  })

  it('a subscription the browser holds that this page did not file is off, not on', async () => {
    const r = rig()
    r.permission.now = 'granted'
    r.manager.held = subscription('https://fcm.googleapis.com/fcm/send/stray', keyBytes(PUBLIC_KEY), r.order)
    const push = createConsolePush(r.deps)
    await push.check()
    expect(push.get().status).toBe('off')
  })
})

describe('turning on, from a press', () => {
  it('asks permission before anything else, subscribes with the registry’s key, files it, and keeps its id', async () => {
    const r = rig()
    const push = createConsolePush(r.deps)
    await push.check()
    r.order.length = 0
    await push.turnOn()
    expect(r.order[0]).toBe('requestPermission')
    expect(r.order).toEqual(['requestPermission', 'subscribe', 'POST /v2/me/push/subscriptions', 'GET /v2/me/push/subscriptions/mine'])
    expect(r.manager.subscribed).toEqual([{ userVisibleOnly: true, applicationServerKey: keyBytes(PUBLIC_KEY) }])
    expect(r.calls.find((call) => call.method === 'POST')).toEqual({
      method: 'POST',
      path: '/v2/me/push/subscriptions',
      body: { endpoint: 'https://fcm.googleapis.com/fcm/send/new', keys: { p256dh: 'P256DH', auth: 'AUTH' }, label: 'Android · Chrome' }
    })
    expect(JSON.parse(r.kept.get(PUSH_KEPT_KEY) ?? '{}')).toEqual({ id: 'S'.repeat(22), endpoint: 'https://fcm.googleapis.com/fcm/send/new' })
    expect(push.get().status).toBe('on')
  })

  it('asks permission first even when the key was never fetched, and fetches it after', async () => {
    const r = rig()
    const push = createConsolePush(r.deps)
    await push.turnOn()
    expect(r.order.slice(0, 2)).toEqual(['requestPermission', 'GET /v2/me/push/key'])
    expect(push.get().status).toBe('on')
  })

  it('stops at a refusal, and at a dismissal says nothing was allowed', async () => {
    const denied = rig()
    denied.permission.after = 'denied'
    const blocked = createConsolePush(denied.deps)
    await blocked.turnOn()
    expect(blocked.get().status).toBe('blocked')
    expect(denied.manager.subscribed).toEqual([])

    const dismissed = rig()
    dismissed.permission.after = 'default'
    const off = createConsolePush(dismissed.deps)
    await off.turnOn()
    expect(off.get()).toMatchObject({ status: 'off', line: expect.stringContaining('not allowed') })
  })

  it('lets go of a subscription made with another key before making one with this one', async () => {
    const r = rig()
    r.manager.held = subscription('https://fcm.googleapis.com/fcm/send/old', new Uint8Array(65).fill(9), r.order)
    const push = createConsolePush(r.deps)
    await push.check()
    await push.turnOn()
    expect(r.order).toContain('unsubscribe https://fcm.googleapis.com/fcm/send/old')
    expect(r.order.indexOf('unsubscribe https://fcm.googleapis.com/fcm/send/old')).toBeLessThan(r.order.indexOf('subscribe'))
  })

  it('a registry that will not file it leaves this browser unsubscribed, and says so', async () => {
    const r = rig()
    r.answers.set('POST /v2/me/push/subscriptions', { status: 0, body: null })
    const push = createConsolePush(r.deps)
    await push.turnOn()
    expect(r.order).toContain('unsubscribe https://fcm.googleapis.com/fcm/send/new')
    expect(push.get()).toMatchObject({ status: 'off', line: expect.stringContaining('could not be reached') })
    expect(r.kept.has(PUSH_KEPT_KEY)).toBe(false)
  })

  it('a browser that will not subscribe says so and stays off', async () => {
    const r = rig()
    r.manager.subscribe = async () => {
      throw new DOMException('no', 'AbortError')
    }
    const push = createConsolePush(r.deps)
    await push.turnOn()
    expect(push.get()).toMatchObject({ status: 'off', line: expect.any(String) })
  })
})

describe('turning off', () => {
  it('unsubscribes here, takes the row off the registry, and forgets the id', async () => {
    const r = rig()
    const push = createConsolePush(r.deps)
    await push.turnOn()
    r.answers.set('DELETE /v2/me/push/subscriptions/:id', { status: 204, body: null })
    r.order.length = 0
    await push.turnOff()
    expect(r.order).toEqual(['unsubscribe https://fcm.googleapis.com/fcm/send/new', `DELETE /v2/me/push/subscriptions/${'S'.repeat(22)}`, 'GET /v2/me/push/subscriptions/mine'])
    expect(r.kept.has(PUSH_KEPT_KEY)).toBe(false)
    expect(push.get().status).toBe('off')
  })

  it('signed out: lets go of the subscription here and keeps nothing, without asking the registry', async () => {
    const r = rig()
    const push = createConsolePush(r.deps)
    await push.turnOn()
    r.order.length = 0
    await push.forget()
    expect(r.order).toEqual(['unsubscribe https://fcm.googleapis.com/fcm/send/new'])
    expect(r.kept.has(PUSH_KEPT_KEY)).toBe(false)
  })

  it('signed out with nothing filed here: touches nothing', async () => {
    const r = rig()
    r.manager.held = subscription('https://fcm.googleapis.com/fcm/send/other-site', null, r.order)
    await createConsolePush(r.deps).forget()
    expect(r.order).toEqual([])
  })
})

// ── the menu item ───────────────────────────────────────────────────────────

const fixed = (state: PushState) => ({
  get: () => state,
  remove: vi.fn(async () => undefined),
  subscribe: () => () => undefined,
  check: vi.fn(async () => undefined),
  turnOn: vi.fn(async () => undefined),
  turnOff: vi.fn(async () => undefined),
  forget: vi.fn(async () => undefined)
})

describe('the menu item', () => {
  it('says what a person can do in each state', () => {
    expect(pushWords({ status: 'hidden', line: null })).toBeNull()
    expect(pushWords({ status: 'checking', line: null })).toBeNull()
    expect(pushWords({ status: 'off', line: null })).toMatchObject({ action: 'on', button: 'Turn on notifications' })
    expect(pushWords({ status: 'on', line: null })).toMatchObject({ action: 'off', button: 'Turn off notifications' })
    expect(pushWords({ status: 'home-screen', line: null })).toMatchObject({ action: null, says: 'Add Cookrew to the Home Screen to get notifications.' })
    expect(pushWords({ status: 'blocked', line: null })?.says).toMatch(/blocked/)
    expect(pushWords({ status: 'unsupported', line: null })?.action).toBeNull()
    expect(pushWords({ status: 'off', line: 'Cookrew could not be reached.' })?.says).toBe('Cookrew could not be reached.')
  })

  it('draws a button in the account menu, and nothing when push is off at the registry', () => {
    const on = renderToStaticMarkup(createElement(PushMenuItem, { push: fixed({ status: 'off', line: null }) }))
    expect(on).toContain('<button type="button" class="cd-quiet" role="menuitem">Turn on notifications</button>')
    const phone = renderToStaticMarkup(createElement(PushMenuItem, { push: fixed({ status: 'home-screen', line: null }) }))
    expect(phone).toContain('Add Cookrew to the Home Screen to get notifications.')
    expect(phone).not.toContain('<button')
    expect(renderToStaticMarkup(createElement(PushMenuItem, { push: fixed({ status: 'hidden', line: null }) }))).toBe('')
  })

  it('sits in the account menu of the Devices bar, and the page follows the worker’s press', () => {
    const view = readFileSync('src/renderer/src/console/ConsoleDevicesView.tsx', 'utf8')
    expect(view).toMatch(/cd-acct-menu[\s\S]*<PushMenuItem push=\{push\} \/>[\s\S]*Sign out/)
    const wiring = readFileSync('src/renderer/src/console/console-wiring.ts', 'utf8')
    expect(wiring).toMatch(/serviceWorker[\s\S]*addEventListener\('message'[\s\S]*routeOfOpenMessage\(event\.data\)[\s\S]*router\.go\(/)
  })
})

// ── the owner's list (security review 2026-11-17, M2) ──────────────────────

const ROWS = [
  { id: 'S'.repeat(22), label: 'Android · Chrome', createdAt: Date.UTC(2026, 10, 17), here: true },
  { id: 'T'.repeat(22), label: 'iPhone · Safari', createdAt: Date.UTC(2026, 10, 3), here: false }
]

describe('which browsers the account tells', () => {
  it('reads the list when it checks, and keeps only rows of the right shape', async () => {
    const r = rig()
    r.answers.set('GET /v2/me/push/subscriptions/mine', { status: 200, body: [...ROWS, { id: 'bad', label: 1 }, null] })
    const push = createConsolePush(r.deps)
    await push.check()
    expect(push.get().rows).toEqual(ROWS)
  })

  it('takes another browser off at the registry, and reads the list again', async () => {
    const r = rig()
    r.answers.set('GET /v2/me/push/subscriptions/mine', { status: 200, body: ROWS })
    r.answers.set('DELETE /v2/me/push/subscriptions/:id', { status: 204, body: null })
    const push = createConsolePush(r.deps)
    await push.check()
    r.order.length = 0
    await push.remove('T'.repeat(22))
    expect(r.order).toEqual([`DELETE /v2/me/push/subscriptions/${'T'.repeat(22)}`, 'GET /v2/me/push/subscriptions/mine'])
  })

  it('taking this browser off is turning it off: unsubscribed here too', async () => {
    const r = rig()
    const push = createConsolePush(r.deps)
    await push.turnOn()
    r.answers.set('GET /v2/me/push/subscriptions/mine', { status: 200, body: ROWS })
    r.answers.set('DELETE /v2/me/push/subscriptions/:id', { status: 204, body: null })
    await push.check()
    r.order.length = 0
    await push.remove('S'.repeat(22))
    expect(r.order[0]).toBe('unsubscribe https://fcm.googleapis.com/fcm/send/new')
    expect(r.kept.has(PUSH_KEPT_KEY)).toBe(false)
    expect(push.get().status).toBe('off')
  })

  it('says each row as a line: its label, whether it is this browser, since when', () => {
    expect(pushRowLine(ROWS[0])).toBe('Android · Chrome · this browser · since 2026-11-17')
    expect(pushRowLine(ROWS[1])).toBe('iPhone · Safari · since 2026-11-03')
    expect(pushRowLine({ ...ROWS[1], label: '' })).toBe('A browser · since 2026-11-03')
  })

  it('draws the list with a Remove for each', () => {
    const html = renderToStaticMarkup(createElement(PushMenuItem, { push: { ...fixed({ status: 'on', line: null, rows: ROWS }), remove: vi.fn(async () => undefined) } }))
    expect(html).toContain('Android · Chrome · this browser · since 2026-11-17')
    expect(html).toContain('iPhone · Safari · since 2026-11-03')
    expect(html.match(/>Remove<\/button>/g)).toHaveLength(2)
  })
})
