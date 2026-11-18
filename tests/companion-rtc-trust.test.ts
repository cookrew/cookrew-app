// THE COMPANION'S TRUST WIRING FOR THE DIRECT LINK (path/companion.ts ·
// rtcKnock). tests/rtc-trust.test.ts checks trustRtcAnswer's verdicts; this
// checks what the companion actually hands connectRtcLink — a check held to the
// machine in scope AS THE KNOCK STARTS — and then runs whole knocks over the
// real connectRtcLink and a stand-in peer whose answer opens the link at once,
// so the companion's check is the only thing between a forged answer and an
// adopted plane. Nothing the relay can make is set; the plane stays on the
// relay and the report says why.
import { createHmac, hkdfSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deviceIdFor, mintDeviceKey, signWithDevice, type AccountFile } from '../src/main/account-v2'
import { RTC_BIND_LABEL, bindMessage, makeRtcBind } from '../src/shared/rtc-bind'
import type { RtcLinkDeps } from '../src/renderer/src/path/rtc-link'
import { inConsole, relayBaseFor, unfoldRelay } from './support/console-scope'

const fp = (byte: string): string => `sha-256 ${Array.from({ length: 32 }, () => byte).join(':')}`
const sdp = (fingerprint: string): string => `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:${fingerprint}\r\n`
/** This page's offer: the stand-in peer's own certificate. */
const OFFER = sdp(fp('0A'))
/** An offer from an earlier knock, whose binding a relay may have kept. */
const OLD_OFFER = sdp(fp('0C'))
/** The Mac's answer. */
const ANSWER = sdp(fp('0B'))
/** The relay's answer: its own certificate in the middle. */
const RELAY_ANSWER = sdp(fp('EE'))
const MAC_ADDRESS = '192.168.2.40'

/** A machine with an account device key, signing as the Mac does (account-v2.ts). */
const machine = () => {
  const keys = mintDeviceKey()
  const deviceId = deviceIdFor(keys.publicKeyJwk)
  const account = { ...keys, deviceId } as unknown as AccountFile
  return { deviceId, signer: { jwk: account.publicKeyJwk, sign: (message: string) => signWithDevice(account, message) } }
}
type Machine = ReturnType<typeof machine>

/** The binding a real Mac sends beside ITS answer, over the offer it received. */
const bound = (mac: Machine, offerSdp: string, answerSdp: string = ANSWER) =>
  makeRtcBind({ device: mac.deviceId, offerSdp, answerSdp, signer: mac.signer })

interface Answer {
  readonly sdp: string
  readonly bind?: unknown
}

/** A console page on the relay whose relay answers POST /api/rtc/offer with `answer`, keeping every path report. */
const stubConsole = (answer: (offerSdp: string) => Promise<Answer>) => {
  const offers: { url: string; sdp: string }[] = []
  const reports: { probes?: { kind: string; name: string; outcome: string }[] }[] = []
  class FakeEventSource {
    readyState = 1
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {
      this.readyState = 2
    }
  }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    COOKREW_MOBILE: 1,
    location: { origin: 'https://cookrew.dev', search: '', hash: '', replace: () => undefined, assign: () => undefined },
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    history: { replaceState: () => undefined },
    crypto: { getRandomValues: (bytes: Uint8Array) => bytes },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined
  }
  Object.assign(globalThis, { EventSource: FakeEventSource })
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const path = unfoldRelay(String(url), init)
    if (path.includes('/api/events')) {
      return new Response(new ReadableStream(), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (path.includes('/api/rtc/offer')) {
      const offerSdp = (JSON.parse(String(init.body)) as { sdp: string }).sdp
      offers.push({ url: path, sdp: offerSdp })
      return Response.json(await answer(offerSdp))
    }
    if (path.includes('/api/path/report')) {
      reports.push(JSON.parse(String(init.body)))
      return new Response(null, { status: 204 })
    }
    throw new Error(`unreachable: ${path}`)
  }
  return { offers: () => offers, reports: () => reports }
}

/** A data channel that opens, and says `ready` from the Mac, when told to. */
class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting'
  bufferedAmount = 0
  send(): void {}
  open(name: string): void {
    this.readyState = 'open'
    this.dispatchEvent(new Event('open'))
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'ready', name }) }))
  }
  close(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.dispatchEvent(new Event('close'))
  }
}

/** The browser's RTCPeerConnection, stood in for: its offer carries OFFER, and any answer set opens the link. */
const stubPeer = (opens = true): { readonly remote: () => readonly string[] } => {
  const remote: string[] = []
  class FakePeer extends EventTarget {
    iceGatheringState = 'complete'
    connectionState = 'new'
    localDescription = { type: 'offer', sdp: OFFER }
    private readonly channels: FakeChannel[] = []
    createDataChannel(): FakeChannel {
      const channel = new FakeChannel()
      this.channels.push(channel)
      return channel
    }
    async createOffer(): Promise<{ type: string; sdp: string }> {
      return { type: 'offer', sdp: OFFER }
    }
    async setLocalDescription(): Promise<void> {}
    async setRemoteDescription(description: { sdp: string }): Promise<void> {
      remote.push(description.sdp)
      if (opens) queueMicrotask(() => this.channels[0]?.open(MAC_ADDRESS))
    }
    close(): void {
      for (const channel of this.channels) channel.close()
    }
  }
  vi.stubGlobal('RTCPeerConnection', FakePeer)
  return { remote: () => remote }
}

/** connectRtcLink as the companion calls it: its deps kept, no link opened. */
const captureConnect = (): { readonly calls: () => readonly RtcLinkDeps[] } => {
  const calls: RtcLinkDeps[] = []
  vi.doMock('../src/renderer/src/path/rtc-link', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/renderer/src/path/rtc-link')>()),
    connectRtcLink: async (deps: RtcLinkDeps) => {
      calls.push(deps)
      return null
    }
  }))
  vi.stubGlobal('RTCPeerConnection', function RTCPeerConnection() {})
  return { calls: () => calls }
}

afterEach(() => {
  delete (globalThis as { fetch?: unknown }).fetch
  delete (globalThis as { EventSource?: unknown }).EventSource
  vi.doUnmock('../src/renderer/src/path/rtc-link')
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('the trust the companion hands connectRtcLink', () => {
  it('is held to the machine in scope as the knock starts, and a later knock to the machine then in scope', async () => {
    const a = machine()
    const b = machine()
    stubConsole(async () => ({ sdp: ANSWER }))
    vi.resetModules()
    const { calls } = captureConnect()
    const scope = await inConsole(a.deviceId)
    const companion = await import('../src/renderer/src/path/companion')
    const stopA = companion.startCompanionPathSwitch()
    await vi.waitFor(() => expect(calls()).toHaveLength(1))
    const trustA = calls()[0].trust

    expect(await trustA(OFFER, { sdp: ANSWER, bind: bound(a, OFFER) })).toEqual({ ok: true, by: 'device' })
    expect(await trustA(OFFER, { sdp: ANSWER, bind: bound(b, OFFER) })).toEqual({ ok: false, why: 'binding for another machine' })

    // Entering B while A's knock is out does not move A's check onto B.
    stopA()
    scope.enterMachine(b.deviceId)
    expect(await trustA(OFFER, { sdp: ANSWER, bind: bound(b, OFFER) })).toEqual({ ok: false, why: 'binding for another machine' })

    // B's own knock is held to B, and refuses A.
    const stopB = companion.startCompanionPathSwitch()
    await vi.waitFor(() => expect(calls()).toHaveLength(2))
    const trustB = calls()[1].trust
    expect(await trustB(OFFER, { sdp: ANSWER, bind: bound(b, OFFER) })).toEqual({ ok: true, by: 'device' })
    expect(await trustB(OFFER, { sdp: ANSWER, bind: bound(a, OFFER) })).toEqual({ ok: false, why: 'binding for another machine' })
    stopB()
  })

  it('reads the answer and its binding off the relay, posting the offer to the machine in scope', async () => {
    const a = machine()
    const relay = stubConsole(async (offerSdp) => ({ sdp: ANSWER, bind: bound(a, offerSdp) }))
    vi.resetModules()
    const { calls } = captureConnect()
    await inConsole(a.deviceId)
    const companion = await import('../src/renderer/src/path/companion')
    const stop = companion.startCompanionPathSwitch()
    await vi.waitFor(() => expect(calls()).toHaveLength(1))
    const { offer, trust } = calls()[0]

    const got = await offer(OFFER)
    expect(relay.offers()).toEqual([{ url: `${relayBaseFor(a.deviceId)}/api/rtc/offer`, sdp: OFFER }])
    expect(got).toMatchObject({ sdp: ANSWER, bind: { v: 1, device: a.deviceId } })
    expect(await trust(OFFER, got as Answer)).toEqual({ ok: true, by: 'device' })
    stop()
  })
})

/** Start the real companion on machine A with the real connectRtcLink, against this relay. */
const knockThrough = async (a: Machine, answer: (offerSdp: string) => Promise<Answer>, options: { opens?: boolean; heldBefore?: 'old-mac' } = {}) => {
  const relay = stubConsole(answer)
  vi.resetModules()
  const peer = stubPeer(options.opens ?? true)
  await inConsole(a.deviceId)
  const companion = await import('../src/renderer/src/path/companion')
  const planes = await import('../src/renderer/src/data-plane')
  const links = await import('../src/renderer/src/rtc-plane')
  const badge = await import('../src/renderer/src/path-link')
  if (options.heldBefore) badge.setDirectHeld(options.heldBefore)
  const stop = companion.startCompanionPathSwitch()
  return { relay, peer, plane: planes.dataPlane, link: links.rtcLink, held: () => badge.pathLinkState().held, stop }
}

const codeMac = (code: Uint8Array, message: string): string => {
  const key = hkdfSync('sha256', code, Buffer.alloc(0), Buffer.from(`${RTC_BIND_LABEL} key`), 32)
  return createHmac('sha256', Buffer.from(key)).update(message).digest('base64url')
}

describe('a whole knock, over the real connectRtcLink', () => {
  it('the Mac\'s own binding: the answer is set and the link adopted (the control)', async () => {
    const a = machine()
    const run = await knockThrough(a, async (offerSdp) => ({ sdp: ANSWER, bind: bound(a, offerSdp) }))
    await vi.waitFor(() => expect(run.plane()).toMatchObject({ kind: 'lan', transport: 'rtc' }))
    expect(run.relay.offers().map((seen) => seen.sdp)).toEqual([OFFER])
    expect(run.peer.remote()).toEqual([ANSWER])
    expect(run.link()?.via).toBe(MAC_ADDRESS)
    expect(run.held()).toBeNull()
    run.stop()
  })

  const forgeries: readonly [string, string, (a: Machine) => (offerSdp: string) => Promise<Answer>][] = [
    ['the answer\'s fingerprint swapped under the Mac\'s own binding', 'binding did not verify', (a) => async (offerSdp) => ({ sdp: RELAY_ANSWER, bind: bound(a, offerSdp) })],
    [
      'a binding the relay signed with its own key, naming the machine in scope',
      'key is not the machine in scope',
      (a) => async (offerSdp) => ({
        sdp: RELAY_ANSWER,
        bind: makeRtcBind({ device: a.deviceId, offerSdp, answerSdp: RELAY_ANSWER, signer: machine().signer })
      })
    ],
    [
      'a connect code planted by a crafted #code= link, proving the relay\'s own answer',
      'key is not the machine in scope',
      (a) => async (offerSdp) => ({
        sdp: RELAY_ANSWER,
        bind: { v: 1, device: a.deviceId, jwk: null, sig: null, mac: codeMac(new Uint8Array(32).fill(3), bindMessage(a.deviceId, offerSdp, RELAY_ANSWER)!) }
      })
    ],
    ['the Mac\'s genuine binding from an earlier offer, replayed', 'binding did not verify', (a) => async () => ({ sdp: ANSWER, bind: bound(a, OLD_OFFER) })],
    ['another Mac\'s genuine answer and binding, relayed onto this machine', 'binding for another machine', () => async (offerSdp) => ({ sdp: ANSWER, bind: bound(machine(), offerSdp) })],
    ['an answer with no binding at all (an older Mac, or the relay)', 'no binding', () => async () => ({ sdp: RELAY_ANSWER })]
  ]

  it.each(forgeries)('%s: never set, never adopted, reported as unbound', async (_, why, forge) => {
    const a = machine()
    const run = await knockThrough(a, forge(a))
    await vi.waitFor(() => expect(run.relay.reports().length).toBeGreaterThan(0))
    expect(run.relay.offers().map((seen) => seen.sdp)).toEqual([OFFER])
    expect(run.peer.remote()).toEqual([])
    expect(run.plane()).toMatchObject({ kind: 'relay' })
    expect(run.link()).toBeNull()
    expect(run.relay.reports().flatMap((report) => report.probes ?? [])).toEqual([
      expect.objectContaining({ kind: 'rtc', outcome: 'unbound', name: `webrtc: ${why}` })
    ])
    // The badge stays RELAY and says why: an older Mac is told to update, anything else was not proved.
    expect(run.held()).toBe(why === 'no binding' ? 'old-mac' : 'unproved')
    run.stop()
  })

  it('a verified answer whose link never opens puts down an earlier reason: the Mac has proved itself', async () => {
    const a = machine()
    const run = await knockThrough(a, async (offerSdp) => ({ sdp: ANSWER, bind: bound(a, offerSdp) }), { opens: false, heldBefore: 'old-mac' })
    expect(run.held()).toBe('old-mac')
    await vi.waitFor(() => expect(run.relay.reports().length).toBeGreaterThan(0), { timeout: 12_000 })
    expect(run.peer.remote()).toEqual([ANSWER])
    expect(run.plane()).toMatchObject({ kind: 'relay' })
    expect(run.held()).toBeNull()
    run.stop()
  }, 15_000)

  it('a browser that cannot check Ed25519 sends no offer at all: the relay never sees its addresses', async () => {
    const a = machine()
    const real = crypto.subtle.importKey.bind(crypto.subtle) as (...args: unknown[]) => Promise<CryptoKey>
    vi.spyOn(crypto.subtle, 'importKey').mockImplementation((async (...args: unknown[]) => {
      const algorithm = args[2] as string | { name: string }
      if ((typeof algorithm === 'string' ? algorithm : algorithm.name).toLowerCase() === 'ed25519') {
        throw new DOMException('Unrecognized name.', 'NotSupportedError')
      }
      return real(...args)
    }) as typeof crypto.subtle.importKey)
    const run = await knockThrough(a, async (offerSdp) => ({ sdp: ANSWER, bind: bound(a, offerSdp) }))
    await vi.waitFor(() => expect(run.relay.reports().length).toBeGreaterThan(0))
    expect(run.relay.offers()).toEqual([])
    expect(run.peer.remote()).toEqual([])
    expect(run.plane()).toMatchObject({ kind: 'relay' })
    expect(run.relay.reports().flatMap((report) => report.probes ?? [])).toEqual([
      expect.objectContaining({ kind: 'rtc', outcome: 'unbound', name: 'webrtc: browser has no Ed25519' })
    ])
    expect(run.held()).toBe('browser')
    vi.restoreAllMocks()
    run.stop()
  })
})
