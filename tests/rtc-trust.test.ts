// THE CONSOLE'S CHECK ON THE MAC'S ANSWER (path/rtc-trust.ts): the body of
// POST /api/rtc/offer read, and the verdict for the machine the check was made
// for. One proof only: the machine's account device key. No connect code.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deviceIdFor, mintDeviceKey, signWithDevice, type AccountFile } from '../src/main/account-v2'
import { RTC_NO_BINDING, RTC_NO_ED25519, RTC_NO_MACHINE, makeRtcBind } from '../src/shared/rtc-bind'
import {
  RTC_ANSWER_MAX,
  RTC_EVERY_MS,
  RTC_REFUSED_EVERY_MS,
  boundKnock,
  heldAfter,
  knockGapAfter,
  readRtcAnswer,
  trustRtcAnswer
} from '../src/renderer/src/path/rtc-trust'

const fp = (byte: string): string => `sha-256 ${Array.from({ length: 32 }, () => byte).join(':')}`
const sdp = (fingerprint: string): string => `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:${fingerprint}\r\n`
const OFFER = sdp(fp('0A'))
const ANSWER = sdp(fp('0B'))

const machine = () => {
  const keys = mintDeviceKey()
  const deviceId = deviceIdFor(keys.publicKeyJwk)
  const account = { ...keys, deviceId } as unknown as AccountFile
  return { deviceId, signer: { jwk: account.publicKeyJwk, sign: (message: string) => signWithDevice(account, message) } }
}

describe('readRtcAnswer', () => {
  it('reads the answer and the binding beside it', () => {
    expect(readRtcAnswer({ sdp: 'v=0', bind: { v: 1 } })).toEqual({ sdp: 'v=0', bind: { v: 1 } })
  })

  it('reads an older Mac\'s answer, which has no binding', () => {
    expect(readRtcAnswer({ sdp: 'v=0' })).toEqual({ sdp: 'v=0', bind: undefined })
  })

  it('reads nothing from an error, junk, an empty SDP or one past any real size', () => {
    for (const body of [{ error: 'no direct link offered' }, null, 'v=0', [], { sdp: 7 }, { sdp: '' }, { sdp: 'v'.repeat(RTC_ANSWER_MAX + 1) }]) {
      expect(readRtcAnswer(body), JSON.stringify(body).slice(0, 60)).toBeNull()
    }
  })
})

describe('trustRtcAnswer', () => {
  it('takes the machine\'s own signature over this offer', async () => {
    const mac = machine()
    const bind = makeRtcBind({ device: mac.deviceId, offerSdp: OFFER, answerSdp: ANSWER, signer: mac.signer })
    expect(await trustRtcAnswer({ machineId: mac.deviceId })(OFFER, { sdp: ANSWER, bind })).toEqual({ ok: true, by: 'device' })
  })

  it('holds to the machine it was made for, not whichever binding arrives', async () => {
    const a = machine()
    const b = machine()
    const trustA = trustRtcAnswer({ machineId: a.deviceId })
    const bindB = makeRtcBind({ device: b.deviceId, offerSdp: OFFER, answerSdp: ANSWER, signer: b.signer })
    expect(await trustA(OFFER, { sdp: ANSWER, bind: bindB })).toEqual({ ok: false, why: 'binding for another machine' })
  })

  it('no machine in scope: nothing to hold the Mac to, no link', async () => {
    const mac = machine()
    const bind = makeRtcBind({ device: mac.deviceId, offerSdp: OFFER, answerSdp: ANSWER, signer: mac.signer })
    expect(await trustRtcAnswer({ machineId: null })(OFFER, { sdp: ANSWER, bind })).toEqual({ ok: false, why: 'no machine in scope' })
  })

  it('an older Mac: no binding, no link', async () => {
    expect(await trustRtcAnswer({ machineId: machine().deviceId })(OFFER, { sdp: ANSWER })).toEqual({ ok: false, why: 'no binding' })
  })

  it('a relay that swapped the answer, or signed with its own key: no link', async () => {
    const mac = machine()
    const relay = machine()
    const trust = trustRtcAnswer({ machineId: mac.deviceId })
    const bind = makeRtcBind({ device: mac.deviceId, offerSdp: OFFER, answerSdp: ANSWER, signer: mac.signer })
    expect((await trust(OFFER, { sdp: sdp(fp('EE')), bind })).ok).toBe(false)
    const forged = makeRtcBind({ device: mac.deviceId, offerSdp: OFFER, answerSdp: sdp(fp('EE')), signer: relay.signer })
    expect((await trust(OFFER, { sdp: sdp(fp('EE')), bind: forged })).ok).toBe(false)
  })
})

/** A browser peer whose offer carries OFFER and whose link never opens (ICE that never connects). */
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

describe('boundKnock: one knock held to one machine, and what its check decided', () => {
  afterEach(() => vi.restoreAllMocks())

  const knockWith = (answer: (offerSdp: string) => unknown, machineId: string | null) => {
    const peer = new SilentPeer()
    const posted: string[] = []
    const knock = boundKnock({
      machineId,
      post: async (offerSdp) => {
        posted.push(offerSdp)
        return readRtcAnswer(answer(offerSdp))
      },
      link: { peer: () => peer as unknown as RTCPeerConnection, gatherMs: 10, openMs: 30 }
    })
    return { knock, peer, posted }
  }

  it('a verified answer whose link never opens is still verified: the Mac proved itself', async () => {
    const a = machine()
    const { knock, peer } = knockWith((offerSdp) => ({ sdp: ANSWER, bind: makeRtcBind({ device: a.deviceId, offerSdp, answerSdp: ANSWER, signer: a.signer }) }), a.deviceId)
    expect(await knock.connect()).toBeNull()
    expect(peer.remote).toEqual([ANSWER])
    expect(knock.verdict()).toEqual({ verified: true, refused: null })
  })

  it('a refused answer is never set, and says why', async () => {
    const a = machine()
    const { knock, peer } = knockWith(() => ({ sdp: ANSWER }), a.deviceId)
    expect(await knock.connect()).toEqual({ unbound: RTC_NO_BINDING })
    expect(peer.remote).toEqual([])
    expect(knock.verdict()).toEqual({ verified: false, refused: RTC_NO_BINDING })
  })

  it('a Mac that never answers decides nothing', async () => {
    const a = machine()
    const { knock } = knockWith(() => ({ error: 'no direct link offered' }), a.deviceId)
    expect(await knock.connect()).toBeNull()
    expect(knock.verdict()).toEqual({ verified: false, refused: null })
  })

  it('a browser that cannot check Ed25519 posts no offer', async () => {
    const a = machine()
    const real = crypto.subtle.importKey.bind(crypto.subtle) as (...args: unknown[]) => Promise<CryptoKey>
    vi.spyOn(crypto.subtle, 'importKey').mockImplementation((async (...args: unknown[]) => {
      const algorithm = args[2] as string | { name: string }
      if ((typeof algorithm === 'string' ? algorithm : algorithm.name).toLowerCase() === 'ed25519') throw new DOMException('no', 'NotSupportedError')
      return real(...args)
    }) as typeof crypto.subtle.importKey)
    const { knock, posted } = knockWith(() => ({ sdp: ANSWER }), a.deviceId)
    expect(await knock.connect()).toEqual({ unbound: RTC_NO_ED25519 })
    expect(posted).toEqual([])
    expect(knock.verdict()).toEqual({ verified: false, refused: RTC_NO_ED25519 })
  })
})

describe('what the badge and the next knock make of a verdict', () => {
  it('a verified answer puts any reason down; a refusal names one; no answer leaves it alone', () => {
    expect(heldAfter({ verified: true, refused: null })).toBeNull()
    expect(heldAfter({ verified: false, refused: RTC_NO_BINDING })).toBe('old-mac')
    expect(heldAfter({ verified: false, refused: RTC_NO_ED25519 })).toBe('browser')
    expect(heldAfter({ verified: false, refused: 'binding did not verify' })).toBe('unproved')
    expect(heldAfter({ verified: false, refused: 'binding check failed' })).toBe('unproved')
    expect(heldAfter({ verified: false, refused: RTC_NO_MACHINE })).toBeNull()
    expect(heldAfter({ verified: false, refused: null })).toBeUndefined()
  })

  it('after a refusal the next knock waits longer: each one hands the relay the Mac\'s addresses for nothing', () => {
    expect(RTC_EVERY_MS).toBe(2 * 60 * 1000)
    expect(RTC_REFUSED_EVERY_MS).toBeGreaterThan(RTC_EVERY_MS)
    expect(knockGapAfter({ verified: false, refused: RTC_NO_BINDING })).toBe(RTC_REFUSED_EVERY_MS)
    expect(knockGapAfter({ verified: false, refused: 'binding did not verify' })).toBe(RTC_REFUSED_EVERY_MS)
    expect(knockGapAfter({ verified: true, refused: null })).toBe(RTC_EVERY_MS)
    expect(knockGapAfter({ verified: false, refused: null })).toBe(RTC_EVERY_MS)
  })
})
