// THE MAC'S WEBRTC END: candidates only on the published addresses, LAN
// first, and a real data channel answered over loopback by a werift offerer.
import { describe, expect, it } from 'vitest'
import { RTCPeerConnection } from 'werift'
import { candidatesOn, createRtcHost, RTC_PROBE_LABEL } from '../src/main/rtc-peer'

const SDP = [
  'v=0',
  'a=candidate:1 1 udp 2130706431 192.168.2.40 50000 typ host',
  'a=candidate:2 1 udp 2130706431 198.18.0.1 50001 typ host',
  'a=candidate:3 1 udp 2130706431 100.68.81.64 50002 typ host',
  'a=candidate:4 1 udp 2130706431 192.168.139.3 50003 typ host',
  'a=end-of-candidates'
].join('\r\n')

describe('candidatesOn', () => {
  it('keeps only the published addresses and ranks the first one highest', () => {
    const out = candidatesOn(SDP, ['192.168.2.40', '100.68.81.64'])
    const lines = out.split('\r\n').filter((l) => l.startsWith('a=candidate:'))
    expect(lines.map((l) => l.split(' ')[4])).toEqual(['192.168.2.40', '100.68.81.64'])
    const priority = (l: string): number => Number(l.split(' ')[3])
    expect(priority(lines[0])).toBeGreaterThan(priority(lines[1]))
    expect(out).toContain('a=end-of-candidates')
    expect(out).not.toContain('198.18.0.1')
  })
})

describe('createRtcHost', () => {
  it('answers an offer and pongs over a real data channel', async () => {
    const host = createRtcHost({ hosts: () => ['127.0.0.1'], deviceId: () => 'mac-1' })
    const phone = new RTCPeerConnection({ iceServers: [], iceAdditionalHostAddresses: ['127.0.0.1'], iceUseIpv6: false })
    const channel = phone.createDataChannel(RTC_PROBE_LABEL)
    await phone.setLocalDescription(await phone.createOffer())
    await new Promise((r) => setTimeout(r, 300))
    const answer = await host.answer(phone.localDescription!.sdp)
    expect(answer).toContain('127.0.0.1')
    await phone.setRemoteDescription({ type: 'answer', sdp: candidatesOn(answer!, ['127.0.0.1']) })
    const reply = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no pong')), 8000)
      channel.onMessage.subscribe((data) => {
        clearTimeout(timer)
        resolve(String(data))
      })
      channel.stateChanged.subscribe((state) => {
        if (state === 'open') channel.send('ping abc123')
      })
    })
    expect(JSON.parse(reply)).toEqual({ pong: 'abc123', deviceId: 'mac-1' })
    await phone.close()
    host.close()
  }, 15000)

  it('refuses with no hosts, no account, or too many peers in flight', async () => {
    expect(await createRtcHost({ hosts: () => [], deviceId: () => 'm' }).answer('v=0')).toBeNull()
    expect(await createRtcHost({ hosts: () => ['127.0.0.1'], deviceId: () => null }).answer('v=0')).toBeNull()
    expect(await createRtcHost({ hosts: () => ['127.0.0.1'], deviceId: () => 'm', maxPeers: 0 }).answer('v=0')).toBeNull()
  })
})
