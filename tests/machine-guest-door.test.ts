import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  builtAssetPath,
  createMachineGuestDoor,
  devAssetAllowed,
  guestAttach,
  guestBootScript,
  guestResponseHeaders,
  planGuestRequest,
  relayRequestHeaders,
  staysInGuest,
  withGuestBoot,
  type MachineGuestDeps,
  type RelayedAnswer
} from '../src/main/machine-guest'

/**
 * THE GUEST'S ONE DOOR (main/machine-guest.ts): a guest machine's page and its
 * relay path, served in the guest's own session. The page from this app's own
 * build, `/api/m…` down the account's relay for that machine only, the account
 * session added in main and never taken from the page.
 */

const SOLIS = '0f8c7b1e-1234-4abc-9def-0123456789ab'
const ATTIC = '1a2b3c4d-1234-4abc-9def-0123456789ab'
const ORIGIN = `cookrew-machine://${SOLIS}`
const KEY = 'K'.repeat(32)
const PAGE = '<!doctype html>\n<html>\n  <head>\n    <meta charset="UTF-8" />\n  </head>\n  <body><script type="module" src="/src/main.tsx"></script></body>\n</html>'

const one = (headers: Record<string, string>): Headers => new Headers(headers)

describe('what a request to the guest’s origin is', () => {
  it('the page, at its root', () => {
    expect(planGuestRequest(`${ORIGIN}/?w=w-1`, one({}))).toEqual({ kind: 'page' })
    expect(planGuestRequest(`${ORIGIN}/index.html`, one({}))).toEqual({ kind: 'page' })
  })

  it('the relay at its one address, for this machine only', () => {
    expect(planGuestRequest(`${ORIGIN}/api/m`, one({ 'x-cookrew-machine': SOLIS, 'x-cookrew-route': 'api/workspaces?x=1' }))).toEqual({ kind: 'relay', machine: SOLIS, route: 'api/workspaces?x=1' })
    // Another machine named in the header: refused, whatever the route.
    expect(planGuestRequest(`${ORIGIN}/api/m`, one({ 'x-cookrew-machine': ATTIC, 'x-cookrew-route': 'api/workspaces' }))).toEqual({ kind: 'refuse', status: 403 })
    // A route the relay does not carry: refused as the registry would.
    expect(planGuestRequest(`${ORIGIN}/api/m`, one({ 'x-cookrew-machine': SOLIS, 'x-cookrew-route': 'v2/me' }))).toEqual({ kind: 'refuse', status: 403 })
    expect(planGuestRequest(`${ORIGIN}/api/m`, one({}))).toEqual({ kind: 'refuse', status: 403 })
  })

  it('the relay’s path form, for this machine only', () => {
    expect(planGuestRequest(`${ORIGIN}/api/m/${SOLIS}/api/terminal/t-1/stream?x=1`, one({}))).toEqual({ kind: 'relay', machine: SOLIS, route: 'api/terminal/t-1/stream?x=1' })
    expect(planGuestRequest(`${ORIGIN}/api/m/${ATTIC}/api/workspaces`, one({}))).toEqual({ kind: 'refuse', status: 403 })
  })

  it('no other `/api` at all: a machine is reached by the relay path and nothing else', () => {
    expect(planGuestRequest(`${ORIGIN}/api/workspaces`, one({}))).toEqual({ kind: 'refuse', status: 404 })
    expect(planGuestRequest(`${ORIGIN}/api`, one({}))).toEqual({ kind: 'refuse', status: 404 })
  })

  it('an asset of the page, and nothing at all on an origin that is not a machine’s', () => {
    expect(planGuestRequest(`${ORIGIN}/assets/index-abc.js`, one({}))).toEqual({ kind: 'asset', pathname: '/assets/index-abc.js', search: '' })
    expect(planGuestRequest('cookrew-machine://evil.example/', one({}))).toEqual({ kind: 'refuse', status: 404 })
  })
})

describe('what crosses', () => {
  it('the guest’s own credential at that machine and its content go on; the relay’s and the browser’s headers do not', () => {
    const sent = relayRequestHeaders(one({
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      'x-cookrew-session': 'desktop',
      'x-cookrew-machine': SOLIS,
      'x-cookrew-route': 'api/x',
      cookie: 'a=b',
      origin: ORIGIN,
      'sec-fetch-mode': 'cors',
      'last-event-id': '7'
    }))
    expect(sent).toEqual({ authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'last-event-id': '7' })
  })

  it('an answer read here is already decoded: its encoding, its length and anything the relay set for a browser are dropped', () => {
    const kept = guestResponseHeaders(one({ 'content-type': 'text/event-stream', 'content-encoding': 'br', 'content-length': '9', 'set-cookie': 'x', 'access-control-allow-origin': '*', etag: 'W/"1"' }))
    expect(Object.fromEntries(kept)).toEqual({ 'content-type': 'text/event-stream', etag: 'W/"1"' })
  })
})

describe('the boot line', () => {
  it('is written before every other script of the page', () => {
    const html = withGuestBoot(PAGE, { machine: SOLIS, key: KEY })
    expect(html.indexOf('window.COOKREW_GUEST')).toBeLessThan(html.indexOf('<script type="module"'))
    expect(html.indexOf('<head>')).toBeLessThan(html.indexOf('window.COOKREW_GUEST'))
  })

  it('can never close its own tag or break its line, whatever it carries', () => {
    const key = '</script><script>alert(1)//\u2028\u2029'
    const script = guestBootScript({ machine: SOLIS, key })
    expect(script.match(/<\/script>/g)).toHaveLength(1)
    expect(script).not.toContain('\u2028')
    expect(script).not.toContain('\u2029')
    // And reads back as it was written.
    const json = script.slice('<script>window.COOKREW_GUEST = '.length, script.indexOf('; document.currentScript'))
    expect(JSON.parse(json)).toEqual({ machine: SOLIS, key })
    // Run once, its tag leaves the page: the key is not left in the document's text.
    expect(script).toContain('document.currentScript.remove()')
  })

})

const world = (over: Partial<MachineGuestDeps> = {}) => {
  const relayed = vi.fn(async (_machine: string, _route: string, _init: RequestInit): Promise<RelayedAnswer> => ({
    ok: true,
    response: new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } })
  }))
  const deps: MachineGuestDeps = {
    relayed,
    keyOf: () => KEY,
    asset: async (pathname) => (pathname === '/index.html' ? { body: PAGE, type: 'text/html' } : pathname === '/assets/a.js' ? { body: 'export {}', type: 'text/javascript' } : null),
    locked: () => false,
    refused: vi.fn(),
    ...over
  }
  const door = createMachineGuestDoor(deps)
  return { deps, relayed, handle: door.handle, door }
}

describe('the door', () => {
  it('the page carries the machine and the key held for it', async () => {
    const { handle } = world()
    const answer = await handle(new Request(`${ORIGIN}/?w=w-1`))
    expect(answer.status).toBe(200)
    expect(answer.headers.get('cache-control')).toBe('no-store')
    const html = await answer.text()
    expect(html).toContain(`"machine":"${SOLIS}"`)
    expect(html).toContain(`"key":"${KEY}"`)
  })

  it('locked, the page is drawn but holds no key, and nothing is carried to the machine', async () => {
    const { handle, relayed } = world({ locked: () => true })
    expect(await (await handle(new Request(`${ORIGIN}/`))).text()).toContain('"key":null')
    const answer = await handle(new Request(`${ORIGIN}/api/m`, { headers: { 'x-cookrew-machine': SOLIS, 'x-cookrew-route': 'api/workspaces' } }))
    expect(answer.status).toBe(423)
    expect(relayed).not.toHaveBeenCalled()
  })

  it('no key held yet: the page says so (null), and the guest says it to the window', async () => {
    const { handle } = world({ keyOf: () => null })
    expect(await (await handle(new Request(`${ORIGIN}/`))).text()).toContain('"key":null')
  })

  it('a relayed call goes to that machine with its method, body and own credential; the answer comes back as it stands', async () => {
    const { handle, relayed } = world()
    const answer = await handle(new Request(`${ORIGIN}/api/m`, {
      method: 'POST',
      headers: { 'x-cookrew-machine': SOLIS, 'x-cookrew-route': 'api/terminal/t-1/input', 'x-cookrew-session': 'desktop', authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: '{"text":"hi"}'
    }))
    expect(answer.status).toBe(200)
    expect(answer.headers.get('content-encoding')).toBeNull()
    expect(await answer.json()).toEqual({ ok: true })
    const [machine, route, init] = relayed.mock.calls[0]!
    expect(machine).toBe(SOLIS)
    expect(route).toBe('api/terminal/t-1/input')
    expect(init.method).toBe('POST')
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe('{"text":"hi"}')
    // The stand-in session never goes on: main's relay adds the account's own.
    expect(init.headers).toEqual({ authorization: `Bearer ${KEY}`, 'content-type': 'application/json' })
  })

  it('a stream is handed back as it arrives, not read whole first', async () => {
    let push: ((chunk: string) => void) | null = null
    const body = new ReadableStream<Uint8Array>({ start: (controller) => void (push = (chunk) => controller.enqueue(new TextEncoder().encode(chunk))) })
    const { handle } = world({ relayed: async () => ({ ok: true, response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }) }) })
    const answer = await handle(new Request(`${ORIGIN}/api/m/${SOLIS}/api/events`))
    const reader = answer.body!.getReader()
    push!('data: one\n\n')
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: one\n\n')
    await reader.cancel()
  })

  it('nothing answered: said as the relay says a machine with no line to it', async () => {
    const { handle } = world({ relayed: async () => ({ ok: false, reason: 'offline' }) })
    const answer = await handle(new Request(`${ORIGIN}/api/m/${SOLIS}/api/workspaces`))
    expect(answer.status).toBe(503)
    expect(await answer.json()).toEqual({ error: 'offline' })
  })

  it('this desktop’s session gone: said as the relay says it, so the page knows it is signed out', async () => {
    for (const reason of ['no_account', 'session-expired']) {
      const { handle } = world({ relayed: async () => ({ ok: false, reason }) })
      const answer = await handle(new Request(`${ORIGIN}/api/m/${SOLIS}/api/workspaces`))
      expect(answer.status, reason).toBe(401)
      expect(await answer.json()).toEqual({ error: 'unauthenticated' })
    }
  })

  it('that machine refusing the key drops it here; the relay refusing the session does not', async () => {
    const machine401 = world({ relayed: async () => ({ ok: true, response: new Response('{"error":"Unauthorized"}', { status: 401 }) }) })
    const first = await machine401.handle(new Request(`${ORIGIN}/api/m/${SOLIS}/api/workspaces`))
    expect(first.status).toBe(401)
    expect(await first.json()).toEqual({ error: 'Unauthorized' })
    expect(machine401.deps.refused).toHaveBeenCalledWith(SOLIS)
    const relay401 = world({ relayed: async () => ({ ok: true, response: new Response('{"error":"unauthenticated"}', { status: 401 }) }) })
    await relay401.handle(new Request(`${ORIGIN}/api/m/${SOLIS}/api/workspaces`))
    expect(relay401.deps.refused).not.toHaveBeenCalled()
  })

  it('follows no redirect: the account session never goes where one points', async () => {
    const { handle, relayed } = world()
    await handle(new Request(`${ORIGIN}/api/m/${SOLIS}/api/workspaces`))
    expect(relayed.mock.calls[0]![2].redirect).toBe('manual')
  })

  it('a stream the page lets go of aborts the relay call under it', async () => {
    const body = new ReadableStream<Uint8Array>({ start: () => undefined })
    let signal: AbortSignal | undefined
    const { handle } = world({ relayed: async (_m, _r, init) => ((signal = init.signal ?? undefined), { ok: true, response: new Response(body, { status: 200 }) }) })
    const answer = await handle(new Request(`${ORIGIN}/api/m/${SOLIS}/api/events`))
    expect(signal?.aborted).toBe(false)
    await answer.body!.cancel()
    expect(signal?.aborted).toBe(true)
  })

  it('the lock coming on cuts every call still open', async () => {
    const signals: AbortSignal[] = []
    const { handle, door } = world({
      relayed: async (_m, _r, init) => {
        signals.push(init.signal!)
        return { ok: true, response: new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), { status: 200 }) }
      }
    })
    await handle(new Request(`${ORIGIN}/api/m/${SOLIS}/api/events`))
    await handle(new Request(`${ORIGIN}/api/m/${SOLIS}/api/fleet/stream`))
    door.cutAll()
    expect(signals.map((one) => one.aborted)).toEqual([true, true])
  })

  it('another machine, or the rest of `/api`, is refused without asking anyone', async () => {
    const { handle, relayed } = world()
    expect((await handle(new Request(`${ORIGIN}/api/m/${ATTIC}/api/workspaces`))).status).toBe(403)
    expect((await handle(new Request(`${ORIGIN}/api/workspaces`))).status).toBe(404)
    expect(relayed).not.toHaveBeenCalled()
  })

  it('an asset of the build, and a 404 for one it does not have', async () => {
    const { handle } = world()
    const found = await handle(new Request(`${ORIGIN}/assets/a.js`))
    expect(found.headers.get('content-type')).toBe('text/javascript')
    expect(await found.text()).toBe('export {}')
    expect((await handle(new Request(`${ORIGIN}/assets/none.js`))).status).toBe(404)
  })
})

describe('the build’s files', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'guest-assets-'))
  mkdirSync(path.join(root, 'assets'))
  writeFileSync(path.join(root, 'assets', 'a.js'), 'x')

  it('only inside the renderer folder, never a hidden file', () => {
    expect(builtAssetPath(root, '/assets/a.js')).toBe(path.join(root, 'assets', 'a.js'))
    expect(builtAssetPath(root, '/../secret')).toBeNull()
    expect(builtAssetPath(root, '/assets/%2e%2e/%2e%2e/etc/passwd')).toBeNull()
    expect(builtAssetPath(root, '/.env')).toBeNull()
    expect(builtAssetPath(root, '/')).toBeNull()
    expect(builtAssetPath(root, '/%E0%A4%A')).toBeNull()
  })

  it('in development, the page and its module graph from the local server, nothing else', () => {
    for (const ok of ['/', '/index.html', '/src/main.tsx', '/@vite/client', '/node_modules/.vite/deps/react.js']) expect(devAssetAllowed(ok), ok).toBe(true)
    for (const no of ['/favicon.svg', '/api/x', '/etc/passwd']) expect(devAssetAllowed(no), no).toBe(false)
  })
})

describe('which webview is the guest', () => {
  it('its partition and a guest address for a machine; either alone is refused', () => {
    expect(guestAttach('cookrew-machine', `cookrew-machine://${SOLIS}/`)).toBe('guest')
    expect(guestAttach('cookrew-machine', 'https://example.com/')).toBe('refuse')
    expect(guestAttach('cookrew-machine', 'cookrew-machine://evil.example/')).toBe('refuse')
    expect(guestAttach('persist:browser-1', `cookrew-machine://${SOLIS}/`)).toBe('refuse')
  })

  it('every other webview (a browser card) is left as it was', () => {
    expect(guestAttach('persist:browser-1', 'https://example.com/')).toBe('pass')
    expect(guestAttach(undefined, undefined)).toBe('pass')
  })
})

describe('where an open guest may go', () => {
  it('its own machine’s pages, and nowhere else: a link out opens outside it', () => {
    expect(staysInGuest(`${ORIGIN}/?w=w-1`, `${ORIGIN}/?w=w-2`)).toBe(true)
    expect(staysInGuest(`${ORIGIN}/`, `cookrew-machine://${ATTIC}/`)).toBe(false)
    expect(staysInGuest(`${ORIGIN}/`, 'https://example.com/')).toBe(false)
    expect(staysInGuest('https://example.com/', `${ORIGIN}/`)).toBe(false)
  })
})
