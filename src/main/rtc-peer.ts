/**
 * THE MAC'S END OF A WEBRTC LINK — a direct path no resolver, no proxy rule
 * and no certificate authority stands in.
 *
 * The companion on cookrew.dev cannot reach this Mac on the home Wi-Fi: the
 * trusted name is redirected by the phone's proxy or resolver, and the bare
 * address has no certificate the phone trusts (2026-10-17, the owner's
 * iPhone). WebRTC needs neither. The phone sends an offer over the relay it
 * is already on; this Mac answers with candidates on exactly the addresses
 * it publishes (its LAN address first, then its tailnet address), ICE finds
 * the direct pair, and DTLS is authenticated by the fingerprint carried in
 * that answer — which arrived over the relay's TLS, from this Mac.
 *
 * Probe round (P0): one data channel, `cookrew-probe`, that answers a ping
 * with this Mac's device id. The data plane does not move yet; the result
 * rides the phone's path report so the owner's phone is the test bench.
 */

import { RTCPeerConnection, type RTCDataChannel } from 'werift'

export const RTC_PROBE_LABEL = 'cookrew-probe'
/** A peer nobody finished with is closed after this long. */
export const RTC_PEER_TTL_MS = 30_000
/** Answers in flight at once; beyond it the offer is refused. */
export const RTC_MAX_PEERS = 4
/** How long gathering may take before the answer goes out with what it has. */
export const RTC_GATHER_MS = 2_000

/**
 * Keep only candidates on the given hosts, best first: the first host gets
 * the highest priority. Pure, so the rule that decides LAN over tailnet is a
 * function a test can call.
 */
export const candidatesOn = (sdp: string, hosts: readonly string[]): string => {
  const rank = new Map(hosts.map((host, index) => [host, index]))
  return sdp
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!line.startsWith('a=candidate:')) return [line]
      const parts = line.slice('a=candidate:'.length).split(' ')
      const address = parts[4]
      const index = rank.get(address)
      if (index === undefined) return []
      // type preference 126 (host), local preference by rank, component 1.
      parts[3] = String(126 * 2 ** 24 + (65535 - index * 1000) * 2 ** 8 + 255)
      return [`a=candidate:${parts.join(' ')}`]
    })
    .join('\r\n')
}

export interface RtcHostDeps {
  /** The addresses this Mac publishes, best first (LAN, then tailnet). */
  readonly hosts: () => readonly string[]
  readonly deviceId: () => string | null
  readonly ttlMs?: number
  readonly maxPeers?: number
}

export interface RtcHost {
  /** Answer an offer; null when refused (busy, no hosts, no account). */
  readonly answer: (offerSdp: string) => Promise<string | null>
  readonly open: () => number
  readonly close: () => void
}

const waitGathered = (pc: RTCPeerConnection, ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    const timer = setTimeout(resolve, ms)
    pc.iceGatheringStateChange.subscribe((state) => {
      if (state === 'complete') {
        clearTimeout(timer)
        resolve()
      }
    })
  })

export const createRtcHost = (deps: RtcHostDeps): RtcHost => {
  const peers = new Set<RTCPeerConnection>()
  const ttl = deps.ttlMs ?? RTC_PEER_TTL_MS
  const max = deps.maxPeers ?? RTC_MAX_PEERS

  const serve = (channel: RTCDataChannel): void => {
    if (channel.label !== RTC_PROBE_LABEL) return
    channel.onMessage.subscribe((data) => {
      const text = typeof data === 'string' ? data : data.toString('utf8')
      const match = /^ping ([A-Za-z0-9_-]{1,64})$/.exec(text)
      if (!match) return
      channel.send(JSON.stringify({ pong: match[1], deviceId: deps.deviceId() }))
    })
  }

  const answer = async (offerSdp: string): Promise<string | null> => {
    const hosts = deps.hosts()
    if (hosts.length === 0 || deps.deviceId() === null || peers.size >= max) return null
    const pc = new RTCPeerConnection({
      iceServers: [],
      // Tunnel interfaces (the tailnet's utun) are skipped by default; the
      // published addresses are named outright, and the SDP is filtered to
      // them below, so a VPN's or a VM's interface is never offered.
      iceAdditionalHostAddresses: [...hosts],
      iceUseIpv6: false
    })
    peers.add(pc)
    const done = (): void => {
      if (!peers.delete(pc)) return
      void pc.close().catch(() => undefined)
    }
    setTimeout(done, ttl).unref?.()
    pc.onDataChannel.subscribe(serve)
    pc.connectionStateChange.subscribe((state) => {
      if (state === 'failed' || state === 'closed') done()
    })
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
      await pc.setLocalDescription(await pc.createAnswer())
      await waitGathered(pc, RTC_GATHER_MS)
      const sdp = pc.localDescription?.sdp
      if (!sdp) throw new Error('no local description')
      return candidatesOn(sdp, hosts)
    } catch (error) {
      done()
      throw error
    }
  }

  return {
    answer,
    open: () => peers.size,
    close: () => {
      for (const pc of [...peers]) {
        peers.delete(pc)
        void pc.close().catch(() => undefined)
      }
    }
  }
}
