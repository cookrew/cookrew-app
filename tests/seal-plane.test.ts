// THE CONSOLE'S SEALED PLANE (renderer path/seal-plane.ts) against the real
// registry and a real terminus: the page's own planeFetch, relayFetch and the
// relay's event stream, with the page's own scope, storage and fetch, and a
// carrier in front of the registry that can strip the v2 offer or refuse a
// handshake, as a relay could. Each case starts from fresh page storage.
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { constants, createGzip } from 'node:zlib'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SealTerminus } from '../src/main/canvas-seal-terminus'
import { createSealMarks, SEALED_ONLY_ERROR } from '../src/main/seal-marks'
import { cameOverRelayLine } from '../src/main/seal-proof'
import { takeRelayDevice } from '../src/main/relay-device'
import { connectCodeId, newConnectCode, replacedKeyOf } from '../src/shared/canvas-seal'
import { RELAY_SESSION_HEADER } from '../src/shared/machine-relay'
import { bareWindow } from './support/memory-storage'
import { inConsole } from './support/console-scope'
import { isSealPath, loopbackDialer, routeSeal, startRelayWorld, until, type RelayWorld } from './support/seal2-relay-world'

const BEARER = 'Bearer canary-pairing-token-5e11'
const marksDir = mkdtempSync(path.join(tmpdir(), 'seal-plane-'))
const marks = createSealMarks(path.join(marksDir, 'marks.json'))
let events: ((chunk: string) => void) | null = null
const seen: Array<{ path?: string; auth?: string; session?: string; plain: boolean }> = []

const companion = (terminus: () => SealTerminus | undefined): Server =>
  createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://mac')
    if (isSealPath(url.pathname)) return void routeSeal(request, response, terminus())
    const device = takeRelayDevice(request)
    // Only a plain request down the relay line carries the line's proof; a sealed one comes from the terminus.
    const plain = cameOverRelayLine(request)
    if (plain && marks.refuses(device?.deviceId ?? null)) {
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: SEALED_ONLY_ERROR }))
      return
    }
    seen.push({ path: url.pathname, auth: request.headers.authorization, session: request.headers[RELAY_SESSION_HEADER] as string | undefined, plain })
    const gzip = String(request.headers['accept-encoding'] ?? '').includes('gzip')
    if (url.pathname === '/api/events' || url.pathname === '/api/gz-events') {
      const zipped = url.pathname === '/api/gz-events' && gzip
      response.writeHead(200, { 'content-type': 'text/event-stream', ...(zipped ? { 'content-encoding': 'gzip' } : {}) })
      const out = zipped ? createGzip({ flush: constants.Z_SYNC_FLUSH }) : null
      out?.pipe(response)
      const write = (chunk: string): void => void (out ? out.write(chunk) : response.write(chunk))
      write(': open\n\n')
      events = write
      return
    }
    request.resume()
    request.on('end', () => {
      if (url.pathname === '/api/gz' && gzip) {
        response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
        const out = createGzip()
        out.pipe(response)
        out.end(JSON.stringify({ path: url.pathname, zipped: true }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ path: url.pathname }))
    })
  })

/** The Mac's code, which a case may rotate. */
let current = { code: newConnectCode(), id: '' }
const replaced = new Map<string, Uint8Array>()
let world: RelayWorld
/** What the carrier does to a handshake: pass it, take v2's offer off it, or refuse it. */
let carrier: 'pass' | 'strip' | 'refuse' | 'forge-code' = 'pass'
let hellos = 0
const realFetch = globalThis.fetch

const routeOf = (input: RequestInfo | URL, init?: RequestInit): string => new Headers(init?.headers).get('x-cookrew-route') ?? String(input)

beforeAll(async () => {
  current = { ...current, id: await connectCodeId(current.code) }
  world = await startRelayWorld(companion, (port) => ({
    codeFor: (asked) => (asked === current.id ? current.code : null),
    replacedKeyFor: (asked) => replaced.get(asked) ?? null,
    currentCodeId: async () => current.id,
    dial: loopbackDialer(port),
    onSealed: ({ peer, outer }) => {
      if (peer.mode === 'code' && outer.device !== undefined) marks.mark(outer.device)
    }
  }))
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (routeOf(input, init).endsWith('~seal/hello')) {
      hellos += 1
      if (carrier === 'refuse') return Promise.resolve(new Response('{}', { status: 502 }))
      // The Mac's bare refusal, which carries no proof and so is anyone's to forge.
      if (carrier === 'forge-code') return Promise.resolve(new Response(JSON.stringify({ error: 'no such code' }), { status: 403 }))
      if (carrier === 'strip' && typeof init?.body === 'string') {
        const { vs: _offer, ...v1 } = JSON.parse(init.body) as Record<string, unknown>
        return realFetch(input, { ...init, body: JSON.stringify(v1) })
      }
    }
    return realFetch(input, init)
  })
})

beforeEach(() => {
  vi.stubGlobal('window', bareWindow('https://console.cookrew.dev/'))
  carrier = 'pass'
  hellos = 0
  marks.clearDevices()
  marks.setSealedOnly(false)
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await world?.close()
  rmSync(marksDir, { recursive: true, force: true })
})

const encoded = (code: Uint8Array): string => Buffer.from(code).toString('base64url')

async function consolePage(withCode = true) {
  vi.resetModules()
  const session = world.phoneSession[RELAY_SESSION_HEADER]
  const scope = await inConsole(world.macDevice.id, { origin: world.site.origin, session: () => session })
  const plane = await import('../src/renderer/src/path/seal-plane')
  plane.configureSealPlane({ retryMs: 40, maxRetryMs: 160, refusedMs: 400, oldMacMs: 2_000 })
  const { planeFetch } = await import('../src/renderer/src/plane-fetch')
  const { openEventSource } = await import('../src/renderer/src/rtc-plane')
  const base = scope.machineBaseOf(world.macDevice.id) as string
  const storage = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage
  const codeKey = `cr_code:${world.macDevice.id}`
  if (withCode) storage.setItem(codeKey, encoded(current.code))
  const pinned = (): boolean => storage.getItem(`${codeKey}:seal2`) !== null
  const get = (route: string, init: RequestInit = {}) => planeFetch(`${base}${route}`, { ...init, headers: { authorization: BEARER, ...(init.headers as Record<string, string>) } })
  return { scope, plane, planeFetch, openEventSource, base, storage, codeKey, pinned, get }
}

/** A request reached the Mac under this path, sealed or not. */
const reached = (route: string, since: number): boolean => seen.slice(since).some((request) => request.path === route)

describe('the console and a machine on v2', () => {
  it('with no code, asks in the clear as it always did', async () => {
    const page = await consolePage(false)
    expect((await page.get('/api/no-code')).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(hellos).toBe(0)
  })

  it('with a code, a try finds v2 and pins it; from then on everything goes sealed, and the relay session never reaches the Mac', async () => {
    const page = await consolePage()
    expect((await page.get('/api/first')).status).toBe(200)
    await until(page.pinned, 'the pin', 4000)
    const answer = await page.get('/api/after-pin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' })
    expect(await answer.json()).toEqual({ path: '/api/after-pin' })
    expect(seen.at(-1)).toEqual({ path: '/api/after-pin', auth: BEARER, session: undefined, plain: false })
  })

  it('carries the relay event stream sealed, as it happens', async () => {
    const page = await consolePage()
    await page.get('/api/warm')
    await until(page.pinned, 'the pin', 4000)
    const got: string[] = []
    const source = page.openEventSource(`${page.base}/api/events`)
    source.onmessage = (event: MessageEvent) => got.push(String(event.data))
    await until(() => events !== null, 'the stream', 4000)
    events?.('data: sealed-event\n\n')
    await until(() => got.includes('sealed-event'), 'the event', 4000)
    source.close()
  })

  it('asks for gzip and reads it, an answer and an event stream alike', async () => {
    const page = await consolePage()
    await page.get('/api/warm')
    await until(page.pinned, 'the pin', 4000)
    expect(await (await page.get('/api/gz')).json()).toEqual({ path: '/api/gz', zipped: true })
    events = null
    const got: string[] = []
    const source = page.openEventSource(`${page.base}/api/gz-events`)
    source.onmessage = (event: MessageEvent) => got.push(String(event.data))
    await until(() => events !== null, 'the stream', 4000)
    ;(events as ((chunk: string) => void) | null)?.('data: zipped-event\n\n')
    await until(() => got.includes('zipped-event'), 'the zipped event', 4000)
    source.close()
  })

  it('a plain request the Mac refuses while the try is under way goes again sealed', async () => {
    marks.setSealedOnly(true)
    const page = await consolePage()
    const since = seen.length
    const answer = await page.get('/api/caught-in-flight')
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ path: '/api/caught-in-flight' })
    expect(reached('/api/caught-in-flight', since)).toBe(true)
    expect(page.pinned()).toBe(true)
  })
})

describe('what a carrier can do to the try', () => {
  it('takes v2\'s offer off the hello: the Mac says inside the sealed v1 session that it has v2, so the page pins and never stays plain', async () => {
    carrier = 'strip'
    const page = await consolePage()
    await page.get('/api/before-the-pin')
    await until(page.pinned, 'the pin learned inside v1', 4000)
    // Pinned while the offer is still taken off: the page refuses v1 now, and sends nothing in the clear.
    const since = seen.length
    await expect(page.get('/api/must-not-leak')).rejects.toThrow()
    expect(reached('/api/must-not-leak', since)).toBe(false)
    // The carrier stops: after the wait, sealed.
    carrier = 'pass'
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect((await page.get('/api/after-the-carrier')).status).toBe(200)
  })

  it('refuses the handshake: tried again with backoff, not once per page', async () => {
    carrier = 'refuse'
    const page = await consolePage()
    await page.get('/api/one')
    await until(() => hellos >= 1, 'the first try', 2000)
    await new Promise((resolve) => setTimeout(resolve, 80))
    await page.get('/api/two')
    await until(() => hellos >= 2, 'a second try', 2000)
    expect(page.pinned()).toBe(false)
    carrier = 'pass'
    await new Promise((resolve) => setTimeout(resolve, 200))
    await page.get('/api/three')
    await until(page.pinned, 'the pin once the carrier passes it', 4000)
  })
})

describe('a pinned page when the Mac changes its code', () => {
  const rotate = async (): Promise<Uint8Array> => {
    replaced.set(current.id, await replacedKeyOf(current.code))
    const next = newConnectCode()
    current = { code: next, id: await connectCodeId(next) }
    world.terminus().endSessions('the pairing was rotated')
    marks.clearDevices()
    return next
  }

  const pinnedPage = async () => {
    const page = await consolePage()
    await page.get('/api/warm')
    await until(page.pinned, 'the pin', 4000)
    return page
  }

  it('shows re-pair (a 401), stays pinned, and does not shake hands per request', async () => {
    const page = await pinnedPage()
    await rotate()
    const before = hellos
    const since = seen.length
    const first = await page.get('/api/after-rotation')
    expect(first.status).toBe(401)
    expect(await first.json()).toMatchObject({ error: expect.stringContaining('Scan its code again') })
    for (let n = 0; n < 5; n += 1) expect((await page.get(`/api/after-rotation-${n}`)).status).toBe(401)
    expect(hellos - before).toBe(1)
    // Pinned per machine: nothing went in the clear, before or after.
    expect(page.pinned()).toBe(true)
    expect(seen.slice(since).some((request) => request.plain)).toBe(false)
  })

  it('the new code the Mac vouches for, waiting beside the old one, is taken, and the page carries on sealed', async () => {
    const page = await pinnedPage()
    const next = await rotate()
    page.storage.setItem(`${page.codeKey}.next`, encoded(next))
    const answer = await page.get('/api/with-the-new-code')
    expect(answer.status).toBe(200)
    expect(page.storage.getItem(page.codeKey)).toBe(encoded(next))
    expect(page.pinned()).toBe(true)
  })

  it('a waiting code the Mac did not vouch for (a link anybody could make) is never taken', async () => {
    const page = await pinnedPage()
    const held = page.storage.getItem(page.codeKey)
    await rotate()
    const planted = encoded(newConnectCode())
    page.storage.setItem(`${page.codeKey}.next`, planted)
    expect((await page.get('/api/planted')).status).toBe(401)
    expect(page.storage.getItem(page.codeKey)).toBe(held)
    expect(page.storage.getItem(`${page.codeKey}.next`)).toBe(planted)
  })

  it('a forged "no such code" with a code waiting: re-pair, the held code kept, and nothing in the clear', async () => {
    const page = await pinnedPage()
    const held = page.storage.getItem(page.codeKey)
    // A fresh page load on the same storage: no session open yet, so the next request shakes hands.
    const fresh = await consolePage(false)
    page.storage.setItem(`${page.codeKey}.next`, encoded(newConnectCode()))
    carrier = 'forge-code'
    const since = seen.length
    expect((await fresh.get('/api/forged')).status).toBe(401)
    carrier = 'pass'
    // Past the refusal kept in memory (refusedMs), the same held code opens sealed again.
    await new Promise((resolve) => setTimeout(resolve, 450))
    for (let n = 0; n < 3; n += 1) await fresh.get(`/api/after-forged-${n}`).catch(() => null)
    expect(fresh.storage.getItem(fresh.codeKey)).toBe(held)
    expect(fresh.pinned()).toBe(true)
    // Whatever came after went sealed or not at all: never in the clear on the relay line.
    expect(seen.slice(since).some((request) => request.plain)).toBe(false)
    expect(seen.slice(since).some((request) => request.path?.startsWith('/api/after-forged') && !request.plain)).toBe(true)
  })
})
