// THE PHONE'S WEBRTC PROBE: offer over the current plane, ping, read the pair
// the browser chose, and say which network it is on.
import { describe, expect, it } from 'vitest'
import { probeRtc, selectedRemote } from '../src/renderer/src/path/rtc-probe'

type Listener = (event?: unknown) => void

/** A browser peer that connects the moment the answer is set, and pongs. */
const fakePeer = (opts: { remote?: string; pong?: boolean } = {}) => {
  const closed = { value: false }
  const make = (): RTCPeerConnection => {
    const channelListeners: Record<string, Listener[]> = {}
    const channel = {
      addEventListener: (type: string, fn: Listener) => void (channelListeners[type] ??= []).push(fn),
      send: (text: string) => {
        if (opts.pong === false) return
        const nonce = text.replace('ping ', '')
        queueMicrotask(() => channelListeners.message?.forEach((fn) => fn({ data: JSON.stringify({ pong: nonce }) })))
      }
    }
    const stats = new Map<string, Record<string, unknown>>([
      ['p', { type: 'candidate-pair', state: 'succeeded', nominated: true, remoteCandidateId: 'r' }],
      ['r', { type: 'remote-candidate', address: opts.remote ?? '192.168.2.40' }]
    ])
    return {
      iceGatheringState: 'complete',
      localDescription: { sdp: 'v=0 offer' },
      addEventListener: () => undefined,
      createDataChannel: () => channel,
      createOffer: async () => ({ type: 'offer', sdp: 'v=0 offer' }),
      setLocalDescription: async () => undefined,
      setRemoteDescription: async () => {
        queueMicrotask(() => channelListeners.open?.forEach((fn) => fn()))
      },
      getStats: async () => stats,
      close: () => void (closed.value = true)
    } as unknown as RTCPeerConnection
  }
  return { make, closed }
}

const classify = (a: string): 'lan' | 'tailnet' | 'other' =>
  a.startsWith('100.') ? 'tailnet' : a.startsWith('192.168.') ? 'lan' : 'other'

describe('probeRtc', () => {
  it('answers with the address the browser connected to, on the LAN', async () => {
    const peer = fakePeer()
    let offered = ''
    const row = await probeRtc({ peer: peer.make, classify, nonce: () => 'n1', offer: async (sdp) => ((offered = sdp), 'v=0 answer') })
    expect(offered).toBe('v=0 offer')
    expect(row).toMatchObject({ kind: 'rtc', name: '192.168.2.40', outcome: 'answered', network: 'lan' })
    expect(peer.closed.value).toBe(true)
  })

  it('names the tailnet when that is the pair it chose', async () => {
    const row = await probeRtc({ peer: fakePeer({ remote: '100.68.81.64' }).make, classify, offer: async () => 'v=0' })
    expect(row).toMatchObject({ outcome: 'answered', network: 'tailnet' })
  })

  it('is a network failure when the Mac offers no link, and closes the peer', async () => {
    const peer = fakePeer()
    const row = await probeRtc({ peer: peer.make, classify, offer: async () => null })
    expect(row).toMatchObject({ kind: 'rtc', name: 'webrtc', outcome: 'network', network: null })
    expect(peer.closed.value).toBe(true)
  })

  it('is a network failure when the browser has no RTCPeerConnection', async () => {
    const row = await probeRtc({ peer: () => { throw new Error('no webrtc') }, classify, offer: async () => 'x' })
    expect(row.outcome).toBe('network')
  })

  it('ignores a pong for another nonce', async () => {
    // A pong that does not echo this ping's nonce is not this Mac's answer.
    const peer = fakePeer()
    const make = (): RTCPeerConnection => {
      const pc = peer.make() as unknown as { createDataChannel: () => { send: (t: string) => void } }
      const original = pc.createDataChannel
      pc.createDataChannel = () => {
        const ch = original()
        const send = ch.send
        ch.send = () => send('ping someone-else')
        return ch
      }
      return pc as unknown as RTCPeerConnection
    }
    const race = probeRtc({ peer: make, classify, nonce: () => 'mine', offer: async () => 'v=0' })
    const winner = await Promise.race([race.then(() => 'settled'), new Promise((r) => setTimeout(() => r('waiting'), 200))])
    expect(winner).toBe('waiting')
  }, 10000)
})

describe('selectedRemote', () => {
  it('reads the nominated, succeeded pair and nothing else', () => {
    const stats = new Map<string, Record<string, unknown>>([
      ['a', { type: 'candidate-pair', state: 'failed', nominated: false, remoteCandidateId: 'x' }],
      ['x', { type: 'remote-candidate', address: '10.0.0.9' }],
      ['b', { type: 'candidate-pair', state: 'succeeded', nominated: true, remoteCandidateId: 'y' }],
      ['y', { type: 'remote-candidate', ip: '100.68.81.64' }]
    ]) as unknown as RTCStatsReport
    expect(selectedRemote(stats)).toBe('100.68.81.64')
  })
})
