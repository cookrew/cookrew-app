// LAN STEP 2: THE DIRECT LINK'S OFFER RIDES THE SEALED SESSION WHEN THERE IS ONE
// (path/rtc-offer.ts, ruling of Relay 2026-11-19).
//
// The offer and the answer carry the phone's and the Mac's addresses (ICE
// candidates). With a sealed session (cookrew-seal/2 on the code this page
// holds) they must cross the relay only inside it: here against the real
// registry and the real terminus, with canary addresses in both SDPs and
// every byte the relay could read searched for them. A page that holds no
// code has no session, and keeps the plain knock (the stated residual risk:
// the relay sees the addresses and can deny the direct link). A page whose
// Mac has not said yet whether it speaks sealed waits for the answer, and
// skips the knock rather than send the offer plain when that takes too long.
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SealTerminus } from '../src/main/canvas-seal-terminus'
import { cameOverRelayLine } from '../src/main/seal-proof'
import { connectCodeId, newConnectCode } from '../src/shared/canvas-seal'
import { RELAY_SESSION_HEADER } from '../src/shared/machine-relay'
import { bareWindow } from './support/memory-storage'
import { inConsole } from './support/console-scope'
import { isSealPath, loopbackDialer, routeSeal, startRelayWorld, until, type RelayWorld } from './support/seal2-relay-world'

/** The phone's address in its offer, and the Mac's in its answer: neither may be readable on a sealed relay. */
const PHONE_ADDRESS = '198.51.100.77'
const MAC_ADDRESS = '192.168.77.77'
const OFFER = `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=candidate:1 1 udp 2122260223 ${PHONE_ADDRESS} 50000 typ host\r\n`
const ANSWER = `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=candidate:1 1 udp 2122260223 ${MAC_ADDRESS} 50001 typ host\r\n`

const offers: Array<{ plain: boolean; sdp: string }> = []
/** A Mac from before cookrew-seal/2: asked inside the sealed v1 session, it knows no version route. */
let oldMac = false
const companion = (terminus: () => SealTerminus | undefined): Server =>
  createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://mac')
    if (oldMac && url.pathname === '/~seal/version') {
      response.writeHead(404, { 'content-type': 'application/json' })
      return void response.end('{}')
    }
    if (isSealPath(url.pathname)) return void routeSeal(request, response, terminus())
    const plain = cameOverRelayLine(request)
    let body = ''
    request.on('data', (chunk: Buffer) => void (body += chunk.toString()))
    request.on('end', () => {
      if (url.pathname === '/api/rtc/offer') offers.push({ plain, sdp: (JSON.parse(body) as { sdp: string }).sdp })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(url.pathname === '/api/rtc/offer' ? { sdp: ANSWER } : { path: url.pathname }))
    })
  })

const current = { code: newConnectCode(), id: '' }
let world: RelayWorld
/** What the carrier does to a handshake: pass it, hold it, fail it (502), or take v2's offer off it, as a relay may. */
let carrier: 'pass' | 'hang' | 'fail' | 'strip' = 'pass'
const realFetch = globalThis.fetch
const routeOf = (input: RequestInfo | URL, init?: RequestInit): string => new Headers(init?.headers).get('x-cookrew-route') ?? String(input)

beforeAll(async () => {
  current.id = await connectCodeId(current.code)
  world = await startRelayWorld(companion, (port) => ({
    codeFor: (asked) => (asked === current.id ? current.code : null),
    replacedKeyFor: () => null,
    currentCodeId: async () => current.id,
    dial: loopbackDialer(port)
  }))
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (routeOf(input, init).endsWith('~seal/hello')) {
      if (carrier === 'hang') return new Promise<Response>(() => undefined)
      if (carrier === 'fail') return Promise.resolve(new Response('{}', { status: 502 }))
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
  oldMac = false
  offers.length = 0
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await world?.close()
})

/** A fresh console page with the Mac in scope, holding the Mac's code or not. */
async function consolePage(withCode: boolean) {
  vi.resetModules()
  const session = world.phoneSession[RELAY_SESSION_HEADER]
  await inConsole(world.macDevice.id, { origin: world.site.origin, session: () => session })
  const plane = await import('../src/renderer/src/path/seal-plane')
  plane.configureSealPlane({ retryMs: 40, maxRetryMs: 160, refusedMs: 400, oldMacMs: 2_000 })
  const storage = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage
  if (withCode) storage.setItem(`cr_code:${world.macDevice.id}`, Buffer.from(current.code).toString('base64url'))
  const { postRtcOffer } = await import('../src/renderer/src/path/rtc-offer')
  return { postRtcOffer }
}

const relayRead = (lines: number, exchanges: number): string => world.relayCouldRead(lines, exchanges)

describe('the knock\'s offer, with a sealed session', () => {
  it('goes sealed even as the very first thing the page asks the Mac: the relay reads neither address', async () => {
    const page = await consolePage(true)
    const at = { lines: world.lines.length, exchanges: world.exchanges.length }
    const answer = await page.postRtcOffer(OFFER)
    expect(answer?.sdp).toBe(ANSWER)
    expect(offers).toEqual([{ plain: false, sdp: OFFER }])
    const read = relayRead(at.lines, at.exchanges)
    expect(read).not.toContain(PHONE_ADDRESS)
    expect(read).not.toContain(MAC_ADDRESS)
    expect(read).not.toContain('a=candidate')
    // And every knock after it, on the session now pinned.
    expect((await page.postRtcOffer(OFFER))?.sdp).toBe(ANSWER)
    expect(offers.map((offer) => offer.plain)).toEqual([false, false])
    expect(relayRead(at.lines, at.exchanges)).not.toContain(MAC_ADDRESS)
  })

  it('is not sent at all while the Mac has not said whether it speaks sealed, rather than sent plain', async () => {
    carrier = 'hang'
    const page = await consolePage(true)
    const at = { lines: world.lines.length, exchanges: world.exchanges.length }
    const started = Date.now()
    expect(await page.postRtcOffer(OFFER, { decideMs: 300 })).toBeNull()
    expect(Date.now() - started).toBeLessThan(2_000)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(offers).toEqual([])
    expect(relayRead(at.lines, at.exchanges)).not.toContain(PHONE_ADDRESS)
  })
})

describe('a try that fails is not an answer', () => {
  it('a handshake the relay fails (502) leaves the question open: the offer is not sent, not even in the back-off after it', async () => {
    carrier = 'fail'
    const page = await consolePage(true)
    const at = { lines: world.lines.length, exchanges: world.exchanges.length }
    expect(await page.postRtcOffer(OFFER, { decideMs: 1_000 })).toBeNull()
    // The try has failed and is waiting to go again: a knock now is still undecided.
    expect(await page.postRtcOffer(OFFER, { decideMs: 200 })).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(offers).toEqual([])
    expect(relayRead(at.lines, at.exchanges)).not.toContain(PHONE_ADDRESS)
  })

  it('a Mac that said, sealed, it has no v2 (an older Mac) gets the plain knock: no session can exist with it', async () => {
    carrier = 'strip'
    oldMac = true
    const page = await consolePage(true)
    const answer = await page.postRtcOffer(OFFER, { decideMs: 3_000 })
    expect(answer?.sdp).toBe(ANSWER)
    expect(offers).toEqual([{ plain: true, sdp: OFFER }])
  })

  it('a Mac once found old and since updated is asked again: while that try fails, nothing goes plain', async () => {
    carrier = 'strip'
    oldMac = true
    const page = await consolePage(true)
    expect((await page.postRtcOffer(OFFER, { decideMs: 3_000 }))?.sdp).toBe(ANSWER)
    expect(offers).toEqual([{ plain: true, sdp: OFFER }])
    // Updated; the relay now fails every handshake. Past oldMacMs (2 s here) the old answer is no answer.
    oldMac = false
    carrier = 'fail'
    await new Promise((resolve) => setTimeout(resolve, 2_100))
    expect(await page.postRtcOffer(OFFER, { decideMs: 500 })).toBeNull()
    expect(offers).toHaveLength(1)
  }, 10_000)

  it('a Mac whose v2 offer the relay takes off the hello is still found to speak sealed: the offer never goes plain', async () => {
    carrier = 'strip'
    const page = await consolePage(true)
    // Pinned on the Mac's sealed word; a relay that goes on stripping then fails the knock, it never makes it plain.
    await page.postRtcOffer(OFFER, { decideMs: 3_000 }).catch(() => null)
    expect(offers.filter((offer) => offer.plain)).toEqual([])
    carrier = 'pass'
    // A refused session is answered from memory for refusedMs (400 here), then asked again.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect((await page.postRtcOffer(OFFER))?.sdp).toBe(ANSWER)
    expect(offers.map((offer) => offer.plain)).not.toContain(true)
    expect(offers.at(-1)).toEqual({ plain: false, sdp: OFFER })
  })
})

describe('the knock\'s offer, with no sealed session (the stated residual risk)', () => {
  it('a page holding no code keeps the plain knock: the relay can read the addresses, and the direct link is still bound', async () => {
    const page = await consolePage(false)
    const at = { lines: world.lines.length, exchanges: world.exchanges.length }
    const answer = await page.postRtcOffer(OFFER)
    expect(answer?.sdp).toBe(ANSWER)
    expect(offers).toEqual([{ plain: true, sdp: OFFER }])
    await until(() => relayRead(at.lines, at.exchanges).includes(MAC_ADDRESS), 'the plain answer on the line')
  })
})
