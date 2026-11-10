import { describe, expect, it, vi } from 'vitest'
import { consoleWorkerKillSwitch, consoleWorkerSource } from '../scripts/console-sw.mjs'

/**
 * THE CONSOLE'S SERVICE WORKER holds the page's own files and nothing else.
 * The source is generated, so it is run here, against a browser made of
 * maps, and held to what it may and may not answer.
 */

const ORIGIN = 'https://console.cookrew.dev'

interface Handlers {
  install?: (event: { waitUntil: (work: Promise<unknown>) => void }) => void
  activate?: (event: { waitUntil: (work: Promise<unknown>) => void }) => void
  fetch?: (event: { request: Request & { mode?: string }; respondWith: (answer: Promise<Response>) => void }) => void
  message?: (event: { data: unknown }) => void
}

function browser(source: string, existing: string[] = []) {
  const stores = new Map<string, Map<string, string>>(existing.map((name) => [name, new Map()]))
  const handlers: Handlers = {}
  const fetched: string[] = []
  const reloads: string[] = []
  const state = { claimed: 0, unregistered: 0, skipped: 0 }
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map())
      const store = stores.get(name)!
      return {
        addAll: async (requests: Request[]) =>
          void requests.forEach((request) => {
            reloads.push(request.cache)
            const key = new URL(request.url).pathname
            store.set(key, `cached ${key}`)
          }),
        // A real cache hands out a fresh answer each time it is asked.
        match: async (key: string) => (store.has(key) ? new Response(store.get(key)) : undefined)
      }
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name)
  }
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: keyof Handlers, handler: never) => void (handlers[type] = handler),
    clients: { claim: async () => void (state.claimed += 1) },
    registration: { unregister: async () => void (state.unregistered += 1) },
    skipWaiting: () => void (state.skipped += 1)
  }
  const fetch = vi.fn(async (request: Request) => {
    fetched.push(request.url)
    return new Response('from the network')
  })
  new Function('self', 'caches', 'fetch', source)(self, caches, fetch)
  const run = async (type: 'install' | 'activate'): Promise<void> => {
    let work: Promise<unknown> = Promise.resolve()
    handlers[type]?.({ waitUntil: (given) => void (work = given) })
    await work
  }
  const ask = async (url: string, init: { method?: string; mode?: string } = {}): Promise<string | null> => {
    let answer: Promise<Response> | null = null
    const request = Object.assign(new Request(url, { method: init.method ?? 'GET' }), {})
    Object.defineProperty(request, 'mode', { value: init.mode ?? 'cors' })
    handlers.fetch?.({ request, respondWith: (given) => void (answer = given) })
    return answer === null ? null : (await (answer as Promise<Response>)).text()
  }
  const tell = (data: unknown): void => handlers.message?.({ data })
  return { stores, state, fetched, reloads, run, ask, tell }
}

const source = (): string => consoleWorkerSource({ version: '0.6.0-abc1234', assets: ['/assets/console-main-AAAA.js', '/assets/App-BBBB.js', '/assets/index-CCCC.css', '/favicon.svg', '/sw.js', '/assets/App-BBBB.js'] })

describe('the worker', () => {
  it('takes the page and every file of its build at install, under its own version', async () => {
    const page = browser(source())
    await page.run('install')
    expect([...page.stores.keys()]).toEqual(['cookrew-console-0.6.0-abc1234'])
    // The page is kept at "/": a static host answers "/index.html" with a redirect, and a redirected answer cannot serve a navigation.
    expect([...page.stores.get('cookrew-console-0.6.0-abc1234')!.keys()].sort()).toEqual(['/', '/assets/App-BBBB.js', '/assets/console-main-AAAA.js', '/assets/index-CCCC.css', '/favicon.svg'])
    // Each taken past the browser's own HTTP cache: a stale copy is not what a new version keeps.
    expect(page.reloads).toEqual(['reload', 'reload', 'reload', 'reload', 'reload'])
    // It does not push itself onto a page that is open: the old page keeps the worker it was opened with.
    expect(page.state.skipped).toBe(0)
  })

  it('lets go of every other version’s cache when it takes over', async () => {
    const page = browser(source(), ['cookrew-console-0.5.9-old', 'something-else'])
    await page.run('install')
    await page.run('activate')
    expect([...page.stores.keys()]).toEqual(['cookrew-console-0.6.0-abc1234'])
    expect(page.state.claimed).toBe(1)
  })

  it('answers any address of the page with the page, from its cache', async () => {
    const page = browser(source())
    await page.run('install')
    expect(await page.ask(`${ORIGIN}/d/11111111-1111-4111-8111-111111111111/w/abc`, { mode: 'navigate' })).toBe('cached /')
    expect(await page.ask(`${ORIGIN}/`, { mode: 'navigate' })).toBe('cached /')
    expect(page.fetched).toEqual([])
  })

  it('answers its build’s files from its cache, whatever query they are asked with', async () => {
    const page = browser(source())
    await page.run('install')
    expect(await page.ask(`${ORIGIN}/assets/App-BBBB.js`)).toBe('cached /assets/App-BBBB.js')
    expect(await page.ask(`${ORIGIN}/favicon.svg?v=2`)).toBe('cached /favicon.svg')
  })

  it('NEVER answers for the registry or a machine: another origin is not even looked at', async () => {
    const page = browser(source())
    await page.run('install')
    for (const url of [
      'https://api.cookrew.dev/v2/me/desktops',
      'https://api.cookrew.dev/api/m/11111111-1111-4111-8111-111111111111/api/workspace',
      'https://192-168-1-7.11111111-1111-4111-8111-111111111111.d.cookrew.dev:8643/api/events',
      'https://auth.cookrew.dev/account'
    ]) {
      expect(await page.ask(url), url).toBeNull()
    }
  })

  it('answers nothing that is not a read, and nothing of its own origin it was not built with', async () => {
    const page = browser(source())
    await page.run('install')
    expect(await page.ask(`${ORIGIN}/assets/App-BBBB.js`, { method: 'POST' })).toBeNull()
    expect(await page.ask(`${ORIGIN}/version.json`)).toBeNull()
    expect(await page.ask(`${ORIGIN}/sw.js`)).toBeNull()
    expect(await page.ask(`${ORIGIN}/assets/App-OLD.js`)).toBeNull()
  })

  it('goes to the network for the page when its cache was taken away', async () => {
    const page = browser(source())
    expect(await page.ask(`${ORIGIN}/`, { mode: 'navigate' })).toBe('from the network')
  })
})

describe('a newer worker waits, until the page itself asks it in', () => {
  it('does not take over at install, and does when the page says so and for nothing else it is told', async () => {
    const page = browser(source())
    await page.run('install')
    expect(page.state.skipped).toBe(0)
    for (const other of [undefined, null, 'hello', { type: 'take-over' }, 'TAKE-OVER']) page.tell(other)
    expect(page.state.skipped).toBe(0)
    page.tell('take-over')
    expect(page.state.skipped).toBe(1)
  })
})

describe('the way out', () => {
  it('deletes every cache and unregisters itself, at once', async () => {
    const page = browser(consoleWorkerKillSwitch(), ['cookrew-console-0.6.0-abc1234', 'cookrew-console-0.6.1-def'])
    await page.run('install')
    expect(page.state.skipped).toBe(1)
    await page.run('activate')
    expect([...page.stores.keys()]).toEqual([])
    expect(page.state.unregistered).toBe(1)
    expect(await page.ask(`${ORIGIN}/`, { mode: 'navigate' })).toBeNull()
  })
})
