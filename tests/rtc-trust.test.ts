// THE CONSOLE'S CHECK ON THE MAC'S ANSWER (path/rtc-trust.ts): the body of
// POST /api/rtc/offer read, and the verdict for the machine the check was made
// for. One proof only: the machine's account device key. No connect code.
import { describe, expect, it } from 'vitest'
import { deviceIdFor, mintDeviceKey, signWithDevice, type AccountFile } from '../src/main/account-v2'
import { makeRtcBind } from '../src/shared/rtc-bind'
import { RTC_ANSWER_MAX, readRtcAnswer, trustRtcAnswer } from '../src/renderer/src/path/rtc-trust'

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
