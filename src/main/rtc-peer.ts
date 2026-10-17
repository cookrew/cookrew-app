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
 * with this Mac's device id. Since round P1 the link carries the data plane
 * too: requests and streams on `cookrew-bridge`, and each WebSocket (the
 * browser card's live view) on a channel of its own.
 */

import { RTCPeerConnection, type RTCDataChannel } from 'werift'
import { createCanvasBridge, loopbackDialer, RELAY_MARKER, type BridgeDialer } from './canvas-bridge'
import { dialLoopbackSocket, type LoopbackSocket, type LoopbackSocketDeps } from './ws-client'
import { createJoiner, socketPathOf, splitMessage } from '../shared/rtc-socket-chunks'
import { RELAY_BASE_HEADER } from './relay-base'
import { RELAY_DEVICE_HEADER, RELAY_DEVICE_NAME_HEADER } from './relay-device'
import { decodeFrame, encodeFrame } from '../shared/relay-frame'

export const RTC_PROBE_LABEL = 'cookrew-probe'
/**
 * THE DATA PLANE (round P1): the relay's own frame protocol (canvas-bridge.ts,
 * shared/relay-frame.ts) carried on a data channel instead of the relay's
 * line. Every request the phone makes becomes a loopback request to this
 * Mac's companion server, exactly as a relayed one does.
 */
export const RTC_BRIDGE_LABEL = 'cookrew-bridge'
/** Raw bytes per chunk frame: 16 KB is the message size every browser takes. */
export const RTC_CHUNK = 16 * 1024
/**
 * A socket's channel past this many bytes queued stops reading the companion
 * until it drains below the low mark — the browser cast then holds the
 * latest frame instead of piling every one up in this process.
 */
export const RTC_SOCKET_HIGH = 4 * 1024 * 1024
export const RTC_SOCKET_LOW = 1024 * 1024
/**
 * WebRTC's `disconnected` is a blip as often as an end — a phone's Wi-Fi
 * power saving drops a few consent checks and the pair comes back on its own.
 * The peer is closed only if it has not come back within this.
 */
export const RTC_DISCONNECT_GRACE_MS = 15_000
/**
 * A link that has said nothing for this long is gone: the phone pings every
 * 10 s (path/rtc-link.ts), so silence this long is a page that went away
 * without a goodbye, or a phone asleep with the app in the background.
 */
export const RTC_SILENT_MS = 60_000
/** A peer nobody finished with is closed after this long. */
export const RTC_PEER_TTL_MS = 30_000
/** Peers open at once; past it the one heard from longest ago is closed to make room. */
export const RTC_MAX_PEERS = 6
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
  /** Where bridged requests go; the companion server on loopback by default. */
  readonly dial?: BridgeDialer
  /** Where a carried WebSocket is dialled; the companion server on loopback by default. */
  readonly socket?: (deps: LoopbackSocketDeps) => LoopbackSocket
  /** One line per link opened and closed, with why. */
  readonly log?: (message: string) => void
  readonly graceMs?: number
  readonly silentMs?: number
}

/** What a channel tells the peer it rides on. */
interface PeerLife {
  /** The bridge opened: the peer is a link now, kept past the TTL. */
  readonly opened: (via: string | null) => void
  /** The phone said something; it is still there. */
  readonly seen: () => void
}

interface PeerState {
  lastSeen: number
  readonly end: (reason: string) => void
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
  const peers = new Map<RTCPeerConnection, PeerState>()
  const ttl = deps.ttlMs ?? RTC_PEER_TTL_MS
  const max = deps.maxPeers ?? RTC_MAX_PEERS
  const graceMs = deps.graceMs ?? RTC_DISCONNECT_GRACE_MS
  const silentMs = deps.silentMs ?? RTC_SILENT_MS
  const log = deps.log ?? ((): void => undefined)

  /** The address this Mac answered on, from the pair ICE settled on. */
  const viaOf = (pc: RTCPeerConnection): string | null => {
    const nominated = (pc.iceTransports[0] as unknown as { connection?: { nominated?: { localCandidate?: { host?: string } } } })
      ?.connection?.nominated?.localCandidate?.host
    return typeof nominated === 'string' ? nominated : null
  }

  /**
   * What the registry would have vouched for on the relay, it cannot here: the
   * base and the caller's name are its headers, so a phone's copy is dropped.
   * The pairing token is still the one credential, checked as on any request.
   */
  const dial: BridgeDialer = (() => {
    const inner = deps.dial ?? loopbackDialer(8639)
    const vouched = new Set([RELAY_BASE_HEADER, RELAY_DEVICE_HEADER, RELAY_DEVICE_NAME_HEADER])
    return (input, ...rest) =>
      inner(
        {
          ...input,
          headers: Object.fromEntries(Object.entries(input.headers).filter(([key]) => !vouched.has(key.toLowerCase())))
        },
        ...rest
      )
  })()

  /** A bridge on a data channel: frames in, loopback requests out, frames back. */
  const bridge = (pc: RTCPeerConnection, channel: RTCDataChannel, life: PeerLife): void => {
    const link = createCanvasBridge({
      send: (line) => {
        try {
          channel.send(line)
        } catch {
          // The channel went away mid-answer; the reset below cleans up.
        }
      },
      dial,
      chunk: RTC_CHUNK
    })
    const greet = (): void => {
      life.opened(viaOf(pc))
      // The first frame names the address this link runs on, so the phone's
      // badge says LAN or TAILNET by fact (Safari's own stats do not say).
      channel.send(encodeFrame({ t: 'ready', name: viaOf(pc) ?? 'unknown' }))
    }
    if (channel.readyState === 'open') greet()
    else channel.stateChanged.subscribe((state) => state === 'open' && greet())
    channel.onMessage.subscribe((data) => {
      const text = typeof data === 'string' ? data : data.toString('utf8')
      life.seen()
      // The phone's heartbeat (path/rtc-link.ts): answered here, never a request.
      if (text.startsWith('{"t":"ping"')) {
        const ping = decodeFrame(text)
        if (ping?.t === 'ping') {
          try {
            channel.send(encodeFrame({ t: 'pong', at: ping.at }))
          } catch {
            // Going down; the state handler below closes the peer.
          }
          return
        }
      }
      link.frame(text)
    })
    channel.stateChanged.subscribe((state) => {
      if (state === 'closed') link.reset()
    })
  }

  /**
   * ONE WEBSOCKET ON ONE CHANNEL (shared/rtc-socket-chunks.ts): the channel's
   * label names the path, the companion is dialled on loopback with the
   * relay's marker, and messages cross in pieces both ways. What the phone
   * sends before the upgrade lands is held, not dropped — its first message
   * goes the moment its own channel opens.
   */
  const carrySocket = (channel: RTCDataChannel, path: string, life: PeerLife): void => {
    const held: string[] = []
    let open = false
    let paused = false
    let upstream: LoopbackSocket | null = null
    const toPhone = (text: string): void => {
      try {
        for (const piece of splitMessage(text)) channel.send(piece)
      } catch {
        upstream?.close()
        return
      }
      if (!paused && channel.bufferedAmount > RTC_SOCKET_HIGH) {
        paused = true
        upstream?.pause()
      }
    }
    const join = createJoiner((text) => (open ? upstream?.send(text) : held.push(text)))
    channel.bufferedAmountLowThreshold = RTC_SOCKET_LOW
    channel.bufferedAmountLow.subscribe(() => {
      if (!paused) return
      paused = false
      upstream?.resume()
    })
    channel.onMessage.subscribe((data) => {
      life.seen()
      if (join(typeof data === 'string' ? data : data.toString('utf8'))) return
      upstream?.close()
    })
    channel.stateChanged.subscribe((state) => {
      if (state === 'closed') upstream?.close()
    })
    upstream = (deps.socket ?? dialLoopbackSocket)({
      port: 8639,
      path,
      headers: { [RELAY_MARKER]: '1' },
      onOpen: () => {
        open = true
        for (const text of held.splice(0)) upstream?.send(text)
      },
      onMessage: toPhone,
      onClose: () => {
        try {
          channel.close()
        } catch {
          // Already closed from the phone's side.
        }
      }
    })
  }

  const serve = (pc: RTCPeerConnection, life: PeerLife) => (channel: RTCDataChannel): void => {
    if (channel.label === RTC_BRIDGE_LABEL) return bridge(pc, channel, life)
    const socketPath = socketPathOf(channel.label)
    if (socketPath !== null) return carrySocket(channel, socketPath, life)
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
    if (hosts.length === 0 || deps.deviceId() === null || max <= 0) return null
    // Full: the one heard from longest ago goes. A phone that slept or
    // reloaded never said goodbye, and its next offer must not be the one
    // refused — nor may it cost a page that is still talking its link.
    if (peers.size >= max) {
      let quietest: PeerState | null = null
      for (const state of peers.values()) if (!quietest || state.lastSeen < quietest.lastSeen) quietest = state
      quietest?.end('closed to make room for a new link')
    }
    const pc = new RTCPeerConnection({
      iceServers: [],
      // Tunnel interfaces (the tailnet's utun) are skipped by default; the
      // published addresses are named outright, and the SDP is filtered to
      // them below, so a VPN's or a VM's interface is never offered.
      iceAdditionalHostAddresses: [...hosts],
      // AND CHECKED ONLY FROM THEM. Advertising is not enough: ICE checks from
      // every interface it gathered, and a pair settled on a VPN's or a proxy's
      // address would be a link this Mac cannot name as LAN or tailnet.
      iceFilterCandidatePair: (pair) => hosts.includes(pair.localCandidate.host),
      iceUseIpv6: false
    })
    let expiry: ReturnType<typeof setTimeout> | undefined
    let grace: ReturnType<typeof setTimeout> | undefined
    let silence: ReturnType<typeof setTimeout> | undefined
    let openedAt: number | null = null
    let via: string | null = null
    const done = (reason: string): void => {
      clearTimeout(expiry)
      clearTimeout(grace)
      clearTimeout(silence)
      if (!peers.delete(pc)) return
      void pc.close().catch(() => undefined)
      if (openedAt !== null) {
        log(`rtc: link via ${via ?? 'unknown'} closed (${reason}) after ${Math.round((Date.now() - openedAt) / 1000)} s, ${peers.size} open`)
      }
    }
    const state: PeerState = { lastSeen: Date.now(), end: done }
    peers.set(pc, state)
    // A probe is closed after the TTL; a bridge that opened is kept until
    // the phone, the network or the phone's silence ends it.
    expiry = setTimeout(() => done('never opened'), ttl)
    expiry.unref?.()
    pc.onDataChannel.subscribe(
      serve(pc, {
        opened: (name) => {
          if (openedAt !== null) return
          clearTimeout(expiry)
          openedAt = Date.now()
          via = name
          state.lastSeen = openedAt
          silence = setTimeout(() => done('silent'), silentMs)
          silence.unref?.()
          log(`rtc: link via ${via ?? 'unknown'} open, ${peers.size} open`)
        },
        seen: () => {
          state.lastSeen = Date.now()
          silence?.refresh()
        }
      })
    )
    pc.connectionStateChange.subscribe((next) => {
      if (next === 'failed' || next === 'closed') return done(next)
      if (next === 'disconnected') {
        if (grace === undefined) {
          grace = setTimeout(() => done('disconnected'), graceMs)
          grace.unref?.()
        }
        return
      }
      if (next === 'connected' && grace !== undefined) {
        clearTimeout(grace)
        grace = undefined
      }
    })
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
      await pc.setLocalDescription(await pc.createAnswer())
      await waitGathered(pc, RTC_GATHER_MS)
      const sdp = pc.localDescription?.sdp
      if (!sdp) throw new Error('no local description')
      return candidatesOn(sdp, hosts)
    } catch (error) {
      done('bad offer')
      throw error
    }
  }

  return {
    answer,
    open: () => peers.size,
    close: () => {
      for (const state of [...peers.values()]) state.end('host closed')
    }
  }
}
