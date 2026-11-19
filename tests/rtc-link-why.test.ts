// WHY A DIRECT LINK DID NOT OPEN, said in the path report row (lane LAN, 2026-11-19).
//
// The owner's Android Chrome knocks and times out on the home Wi-Fi again and
// again; the row said only `webrtc -> timeout`, which cannot tell a Mac that
// never answered from ICE that never connected or a channel that never said
// ready. The row now names the stage, the browser's own states, and how many
// candidates of each kind the page offered: counts only, never an address.
import { describe, expect, it } from 'vitest'
import { adoptRtcLink } from '../src/renderer/src/path/rtc-adopt'
import { connectRtcLink, offerCandidateKinds } from '../src/renderer/src/path/rtc-link'
import { RELAY_PLANE } from '../src/renderer/src/data-plane'

const OFFER = [
  'v=0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=candidate:1 1 udp 2122260223 1f2e3d4c-aaaa-bbbb-cccc-0123456789ab.local 50000 typ host generation 0',
  'a=candidate:2 1 udp 2122194687 192.168.2.77 50001 typ host generation 0',
  'a=candidate:3 1 udp 1686052607 203.0.113.9 50002 typ srflx raddr 0.0.0.0 rport 0',
  ''
].join('\r\n')

/** A browser peer stuck where a real one can stick: ICE checking, the channel never open. */
class StuckPeer extends EventTarget {
  iceGatheringState = 'complete'
  iceConnectionState = 'checking'
  connectionState = 'connecting'
  localDescription = { type: 'offer', sdp: OFFER }
  createDataChannel(): EventTarget & { readyState: string; close: () => void } {
    return Object.assign(new EventTarget(), { readyState: 'connecting', close: () => undefined })
  }
  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: 'offer', sdp: OFFER }
  }
  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(): Promise<void> {}
  close(): void {}
}

const trusted = async () => ({ ok: true as const, by: 'device' as const })

describe('offerCandidateKinds', () => {
  it('counts the offer\'s candidates by kind, and says no address', () => {
    expect(offerCandidateKinds(OFFER)).toBe('1 host, 1 mdns, 1 srflx')
    expect(offerCandidateKinds('v=0\r\n')).toBe('0 host, 0 mdns, 0 srflx')
    expect(offerCandidateKinds(OFFER)).not.toMatch(/192\.168|203\.0|\.local/)
  })
})

describe('connectRtcLink says why it gave up', () => {
  it('a Mac that did not answer: "no answer"', async () => {
    const why: string[] = []
    const link = await connectRtcLink({
      offer: async () => null,
      trust: trusted,
      failed: (reason) => void why.push(reason),
      peer: () => new StuckPeer() as unknown as RTCPeerConnection,
      gatherMs: 10
    })
    expect(link).toBeNull()
    expect(why).toEqual(['no answer'])
  })

  it('an answer that never opened a link: the stage, the browser\'s states and the offer\'s candidate kinds', async () => {
    const why: string[] = []
    const link = await connectRtcLink({
      offer: async () => ({ sdp: 'v=0\r\n' }),
      trust: trusted,
      failed: (reason) => void why.push(reason),
      peer: () => new StuckPeer() as unknown as RTCPeerConnection,
      gatherMs: 10,
      openMs: 30
    })
    expect(link).toBeNull()
    expect(why).toEqual(['never opened (ice checking, conn connecting, ch connecting; offer 1 host, 1 mdns, 1 srflx)'])
    expect(`webrtc: ${why[0]}`.length).toBeLessThanOrEqual(120)
  })
})

describe('the report row names it', () => {
  it('a knock that timed out with a reason reads `webrtc: <reason>`', async () => {
    const row = await adoptRtcLink({
      connect: async () => ({ timedOut: 'never opened (ice checking)' }),
      plane: () => RELAY_PLANE,
      adopt: () => undefined,
      fallBack: () => undefined,
      setLink: () => undefined,
      classify: () => 'lan'
    })
    expect(row).toMatchObject({ kind: 'rtc', outcome: 'timeout', name: 'webrtc: never opened (ice checking)' })
  })

  it('one with none still reads `webrtc`', async () => {
    const row = await adoptRtcLink({
      connect: async () => null,
      plane: () => RELAY_PLANE,
      adopt: () => undefined,
      fallBack: () => undefined,
      setLink: () => undefined,
      classify: () => 'lan'
    })
    expect(row).toMatchObject({ outcome: 'timeout', name: 'webrtc' })
  })
})
