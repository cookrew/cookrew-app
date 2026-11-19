// LAN STEP 2: THE DIRECT LINK'S OFFER REQUIRES AN AUTHENTICATED V2 SESSION.
//
// Offer and answer carry ICE candidates. Against a real registry and terminus,
// canary addresses in both SDPs must not be readable by the relay. Without a
// code, with an old Mac, or while a handshake is undecided, no offer is sent.
import { createServer, type Server } from 'node:http'
import { deviceIdFor, mintDeviceKey, signWithDevice, type AccountFile } from '../src/main/account-v2'
import { makeRtcBind } from '../src/shared/rtc-bind'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SealTerminus } from '../src/main/canvas-seal-terminus'
import { cameOverRelayLine, sealProofHeaders } from '../src/main/seal-proof'
import { connectCodeId, newConnectCode } from '../src/shared/canvas-seal'
import { RELAY_SESSION_HEADER } from '../src/shared/machine-relay'
import { bareWindow } from './support/memory-storage'
import { inConsole } from './support/console-scope'
import { isSealPath, loopbackDialer, routeSeal, startRelayWorld, until, type RelayWorld } from './support/seal2-relay-world'

/** The phone's address in its offer, and the Mac's in its answer: neither may be readable on a sealed relay. */
const PHONE_ADDRESS = '198.51.100.77'
const MAC_ADDRESS = '192.168.77.77'
const fingerprint = (byte: string): string => `a=fingerprint:sha-256 ${Array.from({ length: 32 }, () => byte).join(':')}`
const OFFER = `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n${fingerprint('0A')}\r\na=candidate:1 1 udp 2122260223 ${PHONE_ADDRESS} 50000 typ host\r\n`
const ANSWER = `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n${fingerprint('0B')}\r\na=candidate:1 1 udp 2122260223 ${MAC_ADDRESS} 50001 typ host\r\n`

/** A device key that is not the Mac's: what a relay could sign a binding with. */
const stranger = (() => {
  const keys = mintDeviceKey()
  const account = { ...keys, deviceId: deviceIdFor(keys.publicKeyJwk) } as unknown as AccountFile
  return { jwk: account.publicKeyJwk, sign: (message: string) => signWithDevice(account, message) }
})()
/** What the Mac's answer carries beside the SDP: nothing, or a binding signed by a key that is not the Mac's. */
let answerBind: 'none' | 'forged' = 'none'

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
    const deps = {
      pairingToken: 'test-pairing-token',
      turns: { list: () => [] },
      rtc: {
        answer: async (offerSdp: string) => {
          offers.push({ plain: cameOverRelayLine(request), sdp: offerSdp })
          return ANSWER
        },
        bind: (offerSdp: string) => answerBind === 'forged'
          ? makeRtcBind({ device: world.macDevice.id, offerSdp, answerSdp: ANSWER, signer: stranger })
          : null
      }
    } as unknown as MobileApiDeps
    void handleMobileApi(request, response, url, deps).then((handled) => {
      if (!handled) response.writeHead(404).end()
    })
  })

const current = { code: newConnectCode(), id: '' }
let world: RelayWorld
/**
 * What the carrier does to a handshake, as a relay may: pass it, hold it, fail it (502), take v2's offer
 * off it, take the offer off and then mute the sealed v1 session (every ~seal/up held), or hold it a while.
 */
let carrier: 'pass' | 'hang' | 'fail' | 'strip' | 'strip-mute' | 'slow' = 'pass'
const realFetch = globalThis.fetch
const routeOf = (input: RequestInfo | URL, init?: RequestInit): string => new Headers(init?.headers).get('x-cookrew-route') ?? String(input)

beforeAll(async () => {
  current.id = await connectCodeId(current.code)
  world = await startRelayWorld(companion, (port) => ({
    codeFor: (asked) => (asked === current.id ? current.code : null),
    replacedKeyFor: () => null,
    currentCodeId: async () => current.id,
    dial: loopbackDialer(port, undefined, sealProofHeaders())
  }))
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const route = routeOf(input, init)
    if (carrier === 'strip-mute' && route.includes('~seal/up')) return new Promise<Response>(() => undefined)
    if (route.endsWith('~seal/hello')) {
      if (carrier === 'hang') return new Promise<Response>(() => undefined)
      if (carrier === 'fail') return Promise.resolve(new Response('{}', { status: 502 }))
      if (carrier === 'slow') return new Promise<Response>((resolve) => setTimeout(() => resolve(realFetch(input, init)), 300))
      if ((carrier === 'strip' || carrier === 'strip-mute') && typeof init?.body === 'string') {
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
  answerBind = 'none'
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
  const scope = await inConsole(world.macDevice.id, { origin: world.site.origin, session: () => session })
  const plane = await import('../src/renderer/src/path/seal-plane')
  plane.configureSealPlane({ retryMs: 40, maxRetryMs: 160, refusedMs: 400, oldMacMs: 2_000 })
  const storage = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage
  if (withCode) storage.setItem(`cr_code:${world.macDevice.id}`, Buffer.from(current.code).toString('base64url'))
  const { authStore } = await import('../src/renderer/src/auth-gate')
  authStore().save('test-pairing-token')
  const { postRtcOffer } = await import('../src/renderer/src/path/rtc-offer')
  return { postRtcOffer, scope, plane, base: scope.machineBaseOf(world.macDevice.id) as string }
}

const relayRead = (lines: number, exchanges: number): string => world.relayCouldRead(lines, exchanges)

describe('the actual offer endpoint through the real registry', () => {
  it('refuses plain requests even with the owner token and forged v2 headers', async () => {
    const page = await consolePage(false)
    const { relayFetch } = await import('../src/renderer/src/machine-scope')
    const send = relayFetch()
    const attempts: Record<string, string>[] = [
      { authorization: 'Bearer test-pairing-token' },
      { authorization: 'Bearer test-pairing-token', 'x-cookrew-seal-v2': '1', 'x-cookrew-seal-peer': world.macDevice.id }
    ]
    for (const headers of attempts) {
      const response = await send(`${page.base}/api/rtc/offer`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ sdp: OFFER })
      })
      expect(response.status).toBe(403)
      expect(await response.text()).not.toContain(MAC_ADDRESS)
    }
    expect(offers).toEqual([])
  })

  it('refuses a v2 request without the owner bearer', async () => {
    const page = await consolePage(true)
    const { authStore } = await import('../src/renderer/src/auth-gate')
    authStore().save('incorrect-token')
    expect(await page.postRtcOffer(OFFER)).toBeNull()
    expect(offers).toEqual([])
  })
})

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

  it('a Mac that said it has no v2 stays on the relay without a plain offer', async () => {
    carrier = 'strip'
    oldMac = true
    const page = await consolePage(true)
    expect(await page.postRtcOffer(OFFER, { decideMs: 3_000 })).toBeNull()
    expect(page.plane.sealOutcome(`${page.base}/api/rtc/offer`)).toBe('old-mac')
    expect(offers).toEqual([])
  })

  it('a relay that takes v2 off the hello and then mutes the sealed version question gets no offer: an unanswered question is not "no v2"', async () => {
    carrier = 'strip-mute'
    const page = await consolePage(true)
    const at = { lines: world.lines.length, exchanges: world.exchanges.length }
    expect(await page.postRtcOffer(OFFER, { decideMs: 7_000 })).toBeNull()
    expect(offers).toEqual([])
    expect(relayRead(at.lines, at.exchanges)).not.toContain(PHONE_ADDRESS)
  }, 15_000)

  it('an offer whose machine left scope while the seal was being decided is dropped, though the seal was decided', async () => {
    carrier = 'slow'
    const page = await consolePage(true)
    const sent = page.postRtcOffer(OFFER, { decideMs: 3_000 })
    // The handshake is under way; the page enters another machine (none) before it answers.
    await new Promise((resolve) => setTimeout(resolve, 100))
    page.scope.enterMachine(null)
    expect(await sent).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(offers).toEqual([])
  })

  it('a Mac once found old and since updated gets a sealed offer after a fresh v2 try', async () => {
    carrier = 'strip'
    oldMac = true
    const page = await consolePage(true)
    expect(await page.postRtcOffer(OFFER, { decideMs: 3_000 })).toBeNull()
    expect(offers).toEqual([])
    // Updated: after the old-Mac window, a fresh v2 try restores the sealed link.
    oldMac = false
    carrier = 'pass'
    await new Promise((resolve) => setTimeout(resolve, 2_100))
    expect((await page.postRtcOffer(OFFER, { decideMs: 3_000 }))?.sdp).toBe(ANSWER)
    expect(offers).toEqual([{ plain: false, sdp: OFFER }])
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

describe('the knock without a sealed session', () => {
  it('a page holding no code stays on the relay and sends no offer', async () => {
    const page = await consolePage(false)
    const at = { lines: world.lines.length, exchanges: world.exchanges.length }
    expect(await page.postRtcOffer(OFFER)).toBeNull()
    expect(offers).toEqual([])
    expect(relayRead(at.lines, at.exchanges)).not.toContain(PHONE_ADDRESS)
  })
})

/** A browser peer whose offer is OFFER (with its address) and whose link never opens: the answer is all that is judged. */
class SilentPeer extends EventTarget {
  iceGatheringState = 'complete'
  connectionState = 'new'
  localDescription = { type: 'offer', sdp: OFFER }
  readonly remote: string[] = []
  createDataChannel(): EventTarget & { readyState: string; close: () => void } {
    return Object.assign(new EventTarget(), { readyState: 'connecting', close: () => undefined })
  }
  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: 'offer', sdp: OFFER }
  }
  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(description: { sdp: string }): Promise<void> {
    this.remote.push(description.sdp)
  }
  close(): void {}
}

describe('a whole sealed knock (rtc-trust.ts · boundKnock over postRtcOffer)', () => {
  it('an answer that came sealed but carries a binding the Mac did not make is never set', async () => {
    answerBind = 'forged'
    const page = await consolePage(true)
    const { boundKnock } = await import('../src/renderer/src/path/rtc-trust')
    const peer = new SilentPeer()
    const knock = boundKnock({
      machineId: world.macDevice.id,
      post: (sdp) => page.postRtcOffer(sdp),
      link: { peer: () => peer as unknown as RTCPeerConnection, gatherMs: 10, openMs: 200 }
    })
    expect(await knock.connect()).toEqual({ unbound: 'key is not the machine in scope' })
    expect(peer.remote).toEqual([])
    expect(knock.verdict()).toEqual({ verified: false, refused: 'key is not the machine in scope' })
    // The offer did go, sealed: sealing hides the addresses, the binding still decides the link.
    expect(offers).toEqual([{ plain: false, sdp: OFFER }])
  })
})
