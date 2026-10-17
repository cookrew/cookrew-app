/**
 * THE PHONE'S END OF THE WEBRTC PROBE (main/rtc-peer.ts, round P0).
 *
 * On the owner's iPhone the trusted name never connects at home and the bare
 * address has no trusted certificate. WebRTC needs neither: the offer goes
 * over the plane the page already has (the relay), the Mac answers with its
 * LAN and tailnet candidates, and ICE connects to whichever answers first by
 * priority — LAN over tailnet. This probe only proves the link: it pings,
 * reads the pong, and reports which address the browser actually used. The
 * data plane does not move in this round.
 *
 * Pure over its deps, so the rule is testable without a browser.
 */

import type { ReachProbe } from './reach-probes'

export const RTC_PROBE_LABEL = 'cookrew-probe'
/** Gathering on the phone, then the whole link; a probe past this is a timeout. */
export const RTC_GATHER_MS = 1_500
export const RTC_LINK_MS = 6_000

export interface RtcProbeDeps {
  /** POST the offer over the current plane; the Mac's answer SDP, or null. */
  readonly offer: (sdp: string) => Promise<string | null>
  readonly peer?: () => RTCPeerConnection
  readonly now?: () => number
  readonly nonce?: () => string
  /** Which network an address is on; 'other' when neither. */
  readonly classify: (address: string) => 'lan' | 'tailnet' | 'other'
}

export interface RtcProbe extends ReachProbe {
  readonly network: 'lan' | 'tailnet' | 'other' | null
}

const gathered = (pc: RTCPeerConnection, ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    const timer = setTimeout(resolve, ms)
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer)
        resolve()
      }
    })
  })

/** The remote address of the pair the browser settled on, from getStats. */
export const selectedRemote = (stats: RTCStatsReport): string | null => {
  let remote: string | null = null
  stats.forEach((entry: Record<string, unknown>) => {
    if (remote !== null || entry.type !== 'candidate-pair') return
    if (entry.state !== 'succeeded' || entry.nominated !== true) return
    const candidate = stats.get(String(entry.remoteCandidateId)) as Record<string, unknown> | undefined
    const address = candidate?.address ?? candidate?.ip
    if (typeof address === 'string') remote = address
  })
  return remote
}

export const probeRtc = async (deps: RtcProbeDeps): Promise<RtcProbe> => {
  const now = deps.now ?? ((): number => performance.now())
  const started = now()
  const row = (outcome: RtcProbe['outcome'], address: string | null): RtcProbe => ({
    kind: 'rtc',
    name: address ?? 'webrtc',
    outcome,
    ms: Math.round(now() - started),
    network: address === null ? null : deps.classify(address)
  })
  const make = deps.peer ?? ((): RTCPeerConnection => new RTCPeerConnection({ iceServers: [] }))
  let pc: RTCPeerConnection
  try {
    pc = make()
  } catch {
    return row('network', null)
  }
  try {
    const channel = pc.createDataChannel(RTC_PROBE_LABEL)
    await pc.setLocalDescription(await pc.createOffer())
    await gathered(pc, RTC_GATHER_MS)
    const answer = await deps.offer(pc.localDescription?.sdp ?? '')
    if (answer === null) return row('network', null)
    const nonce = deps.nonce?.() ?? Math.random().toString(36).slice(2, 12)
    // Listen BEFORE the answer goes in: a LAN link can open within the same
    // turn, and an open nobody heard is a probe that times out on a live link.
    const pong = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), RTC_LINK_MS)
      channel.addEventListener('open', () => channel.send(`ping ${nonce}`))
      channel.addEventListener('message', (event) => {
        try {
          const reply = JSON.parse(String((event as MessageEvent).data)) as { pong?: unknown }
          if (reply.pong !== nonce) return
        } catch {
          return
        }
        clearTimeout(timer)
        resolve(true)
      })
    })
    await pc.setRemoteDescription({ type: 'answer', sdp: answer })
    const ponged = await pong
    if (!ponged) return row('timeout', null)
    return row('answered', selectedRemote(await pc.getStats()))
  } catch {
    return row('network', null)
  } finally {
    try {
      pc.close()
    } catch {
      // Already closed.
    }
  }
}
