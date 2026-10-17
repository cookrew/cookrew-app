// THE DATA PLANE ON A DATA CHANNEL (round P1), the Mac's end: a werift
// offerer opens `cookrew-bridge`, hears the address the link runs on, and
// gets the relay's own frames back for a request — chunked small enough for
// any browser, with the headers only the registry may set dropped on the way.
import { describe, expect, it } from 'vitest'
import { RTCPeerConnection, type RTCDataChannel } from 'werift'
import { candidatesOn, createRtcHost, RTC_BRIDGE_LABEL, RTC_CHUNK } from '../src/main/rtc-peer'
import type { BridgeDialer } from '../src/main/canvas-bridge'
import { decodeFrame, encodeFrame, type RelayFrame } from '../src/shared/relay-frame'

interface Dialed {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string>
  body: string
}

/** A companion that answers every request with `size` bytes of 'x'. */
const fakeDial = (dialed: Dialed[], size: number): BridgeDialer => (input, onResponse) => {
  const seen: Dialed = { ...input, body: '' }
  dialed.push(seen)
  return {
    write: (body) => void (seen.body += body.toString('utf8')),
    end: () =>
      onResponse({
        status: 200,
        headers: { 'content-type': 'text/plain' },
        onData: (listener) => void setTimeout(() => listener(Buffer.alloc(size, 'x')), 0),
        onEnd: (listener) => void setTimeout(listener, 5)
      }),
    destroy: () => undefined
  }
}

const connect = async (
  dial: BridgeDialer
): Promise<{ channel: RTCDataChannel; frames: RelayFrame[]; close: () => Promise<void> }> => {
  const host = createRtcHost({ hosts: () => ['127.0.0.1'], deviceId: () => 'mac-1', dial, ttlMs: 2_500 })
  const phone = new RTCPeerConnection({ iceServers: [], iceAdditionalHostAddresses: ['127.0.0.1'], iceUseIpv6: false })
  const channel = phone.createDataChannel(RTC_BRIDGE_LABEL)
  const frames: RelayFrame[] = []
  channel.onMessage.subscribe((data) => {
    const frame = decodeFrame(String(data))
    if (frame) frames.push(frame)
  })
  await phone.setLocalDescription(await phone.createOffer())
  await new Promise((r) => setTimeout(r, 300))
  const answer = await host.answer(phone.localDescription!.sdp)
  await phone.setRemoteDescription({ type: 'answer', sdp: candidatesOn(answer!, ['127.0.0.1']) })
  await until(() => frames.some((f) => f.t === 'ready'), 8000)
  return {
    channel,
    frames,
    close: async () => {
      await phone.close()
      host.close()
    }
  }
}

const until = async (ok: () => boolean, ms: number): Promise<void> => {
  const deadline = Date.now() + ms
  while (!ok()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('the bridge channel', () => {
  it('names the address it runs on, then carries a request both ways', async () => {
    const dialed: Dialed[] = []
    const link = await connect(fakeDial(dialed, 40 * 1024))
    expect(link.frames[0]).toEqual({ t: 'ready', name: '127.0.0.1' })

    link.channel.send(
      encodeFrame({
        t: 'open',
        id: 'r1',
        method: 'POST',
        path: '/api/ping',
        headers: {
          authorization: 'Bearer pairing',
          'x-cookrew-base': '/relay/@someone/desktop/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          'x-cookrew-device': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          'x-cookrew-device-name': 'Not this phone'
        }
      })
    )
    link.channel.send(encodeFrame({ t: 'body', id: 'r1', data: Buffer.from('hel').toString('base64') }))
    link.channel.send(encodeFrame({ t: 'body', id: 'r1', data: Buffer.from('lo').toString('base64'), done: true }))
    await until(() => link.frames.some((f) => f.t === 'end'), 5000)

    expect(dialed).toHaveLength(1)
    expect(dialed[0].path).toBe('/api/ping')
    expect(dialed[0].body).toBe('hello')
    // The token still travels; what the registry alone may vouch for does not.
    expect(dialed[0].headers.authorization).toBe('Bearer pairing')
    expect(Object.keys(dialed[0].headers).filter((k) => k.startsWith('x-cookrew-'))).toEqual([])

    const head = link.frames.find((f) => f.t === 'head')
    expect(head).toMatchObject({ t: 'head', id: 'r1', status: 200 })
    const chunks = link.frames.filter((f): f is Extract<RelayFrame, { t: 'chunk' }> => f.t === 'chunk')
    const sizes = chunks.map((c) => Buffer.from(c.data, 'base64').byteLength)
    expect(sizes).toEqual([RTC_CHUNK, RTC_CHUNK, 40 * 1024 - 2 * RTC_CHUNK])
    await link.close()
  }, 20000)

  it('is kept past the TTL a probe gets — the session lives on it', async () => {
    const dialed: Dialed[] = []
    const link = await connect(fakeDial(dialed, 3))
    // ttlMs is 2.5 s above: a probe would be closed by now.
    await new Promise((r) => setTimeout(r, 3_000))
    link.channel.send(encodeFrame({ t: 'open', id: 'r2', method: 'GET', path: '/api/still', headers: {} }))
    link.channel.send(encodeFrame({ t: 'body', id: 'r2', data: '', done: true }))
    await until(() => link.frames.some((f) => f.t === 'end'), 5000)
    expect(dialed.map((d) => d.path)).toEqual(['/api/still'])
    await link.close()
  }, 20000)
})

describe('the peer cap', () => {
  it('closes the oldest peer rather than refusing the newest offer', async () => {
    const host = createRtcHost({ hosts: () => ['127.0.0.1'], deviceId: () => 'mac-1', maxPeers: 1 })
    const offer = async (): Promise<string | null> => {
      const phone = new RTCPeerConnection({ iceServers: [], iceAdditionalHostAddresses: ['127.0.0.1'], iceUseIpv6: false })
      phone.createDataChannel(RTC_BRIDGE_LABEL)
      await phone.setLocalDescription(await phone.createOffer())
      await new Promise((r) => setTimeout(r, 200))
      const answer = await host.answer(phone.localDescription!.sdp)
      await phone.close()
      return answer
    }
    expect(await offer()).toContain('127.0.0.1')
    expect(await offer()).toContain('127.0.0.1')
    expect(host.open()).toBe(1)
    host.close()
  }, 20000)
})
