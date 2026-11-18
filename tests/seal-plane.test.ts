// THE CONSOLE'S SEALED PLANE (renderer path/seal-plane.ts) against the real
// registry and a real terminus: the page's own planeFetch, relayFetch and the
// relay's event stream, with the page's own scope, storage and fetch.
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SealTerminus } from '../src/main/canvas-seal-terminus'
import { createSealMarks, SEALED_ONLY_ERROR } from '../src/main/seal-marks'
import { cameOverRelayLine } from '../src/main/seal-proof'
import { takeRelayDevice } from '../src/main/relay-device'
import { connectCodeId, newConnectCode } from '../src/shared/canvas-seal'
import { RELAY_SESSION_HEADER } from '../src/shared/machine-relay'
import { bareWindow } from './support/memory-storage'
import { inConsole } from './support/console-scope'
import { isSealPath, loopbackDialer, routeSeal, startRelayWorld, until, type RelayWorld } from './support/seal2-relay-world'

const BEARER = 'Bearer canary-pairing-token-5e11'
const marksDir = mkdtempSync(path.join(tmpdir(), 'seal-plane-'))
const marks = createSealMarks(path.join(marksDir, 'marks.json'))
let events: ((chunk: string) => void) | null = null
const seen: Array<{ path?: string; auth?: string }> = []

const companion = (terminus: () => SealTerminus | undefined): Server =>
  createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://mac')
    if (isSealPath(url.pathname)) return void routeSeal(request, response, terminus())
    const device = takeRelayDevice(request)
    if (cameOverRelayLine(request) && marks.refuses(device?.deviceId ?? null)) {
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: SEALED_ONLY_ERROR }))
      return
    }
    seen.push({ path: request.url, auth: request.headers.authorization })
    if (url.pathname === '/api/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(': open\n\n')
      events = (chunk) => response.write(chunk)
      return
    }
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ path: request.url }))
    })
  })

const code = newConnectCode()
const encoded = Buffer.from(code).toString('base64url')
let world: RelayWorld
/** What the page sent the registry, by URL and route header. */
const sent: string[] = []

beforeAll(async () => {
  const id = await connectCodeId(code)
  world = await startRelayWorld(companion, (port) => ({
    codeFor: (asked) => (asked === id ? code : null),
    dial: loopbackDialer(port),
    onSealed: ({ peer, outer }) => {
      if (peer.mode === 'code' && outer.device !== undefined) marks.mark(outer.device)
    }
  }))
  vi.stubGlobal('window', bareWindow('https://console.cookrew.dev/'))
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(`${String(input)} ${new Headers(init?.headers).get('x-cookrew-route') ?? ''}`)
    return realFetch(input, init)
  })
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await world?.close()
  rmSync(marksDir, { recursive: true, force: true })
})

async function console_() {
  vi.resetModules()
  const session = world.phoneSession[RELAY_SESSION_HEADER]
  const scope = await inConsole(world.macDevice.id, { origin: world.site.origin, session: () => session })
  const plane = await import('../src/renderer/src/path/seal-plane')
  const { planeFetch } = await import('../src/renderer/src/plane-fetch')
  const { openEventSource } = await import('../src/renderer/src/rtc-plane')
  const base = scope.machineBaseOf(world.macDevice.id) as string
  return { scope, plane, planeFetch, openEventSource, base, storage: (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage }
}

describe('the console on a machine that speaks v2', () => {
  it('with no code, asks in the clear as it always did', async () => {
    const page = await console_()
    const answer = await page.planeFetch(`${page.base}/api/no-code`, { headers: { authorization: BEARER } })
    expect(answer.status).toBe(200)
    expect(sent.at(-1)).toContain('api/no-code')
  })

  it('with a code, one quiet try finds v2 and pins it; from then on everything goes sealed', async () => {
    const page = await console_()
    page.storage.setItem(`cr_code:${world.macDevice.id}`, encoded)
    // The first request still goes the old way, and starts the try.
    expect((await page.planeFetch(`${page.base}/api/first`, { headers: { authorization: BEARER } })).status).toBe(200)
    await until(() => page.storage.getItem(`cr_code:${world.macDevice.id}:seal2`) !== null, 'the pin', 4000)
    const before = sent.length
    const answer = await page.planeFetch(`${page.base}/api/after-pin`, { method: 'POST', headers: { authorization: BEARER, 'content-type': 'application/json' }, body: '{"a":1}' })
    expect(await answer.json()).toEqual({ path: '/api/after-pin' })
    expect(seen.at(-1)).toEqual({ path: '/api/after-pin', auth: BEARER })
    // Nothing the page sent named the route: only the session's own.
    const since = sent.slice(before).join('\n')
    expect(since).not.toContain('after-pin')
    expect(since).toContain('~seal/up')
  })

  it('the Mac now refuses this device in the clear, and a refused request goes again sealed', async () => {
    const page = await console_()
    const raw = await fetch(`${page.base}/api/raw`, { headers: { [RELAY_SESSION_HEADER]: world.phoneSession[RELAY_SESSION_HEADER], authorization: BEARER } })
    expect(raw.status).toBe(403)
    const viaRelayFetch = await page.scope.relayFetch()(`${page.base}/api/through-relay-fetch`, { headers: { authorization: BEARER } })
    expect(await viaRelayFetch.json()).toEqual({ path: '/api/through-relay-fetch' })
  })

  it('carries the relay event stream sealed, as it happens', async () => {
    const page = await console_()
    const got: string[] = []
    const source = page.openEventSource(`${page.base}/api/events`)
    source.onmessage = (event: MessageEvent) => got.push(String(event.data))
    await until(() => events !== null, 'the stream', 4000)
    events?.('data: sealed-event\n\n')
    await until(() => got.includes('sealed-event'), 'the event', 4000)
    source.close()
  })

  it('pinned, and the session cannot open: the request fails and nothing goes in the clear', async () => {
    const page = await console_()
    // A carrier that strips the v2 offer, so only v1 could answer: the pinned page refuses it.
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const route = new Headers(init?.headers).get('x-cookrew-route') ?? String(input)
      if (route.endsWith('~seal/hello') && typeof init?.body === 'string') {
        const { vs: _offer, ...v1 } = JSON.parse(init.body) as Record<string, unknown>
        return realFetch(input, { ...init, body: JSON.stringify(v1) })
      }
      sent.push(`${String(input)} ${new Headers(init?.headers).get('x-cookrew-route') ?? ''}`)
      return realFetch(input, init)
    })
    try {
      const before = seen.length
      await expect(page.planeFetch(`${page.base}/api/must-not-leak`, { headers: { authorization: BEARER } })).rejects.toThrow()
      expect(seen.slice(before).some((request) => request.path === '/api/must-not-leak')).toBe(false)
    } finally {
      vi.stubGlobal('fetch', realFetch)
    }
  })
})
