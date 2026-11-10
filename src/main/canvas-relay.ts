import { createCanvasBridge, type BridgeDialer, type CanvasBridge } from './canvas-bridge'
import { createCanvasLink, type CanvasCredential, type CanvasLink } from './canvas-link'
import { createRelayUplink, RELAY_CHUNK, type RelayUplink } from './relay-uplink'

/**
 * THE MAC'S CANVAS ON THE RELAY, ASSEMBLED — the line (canvas-link.ts), what
 * goes up it next (relay-uplink.ts) and what rides it (canvas-bridge.ts), wired
 * once here so index.ts and the tests that drive a real registry run the same
 * thing.
 */
export interface CanvasRelay {
  readonly link: CanvasLink
  readonly bridge: CanvasBridge
  readonly uplink: RelayUplink
  readonly start: () => void
  readonly stop: () => void
}

export interface CanvasRelayDeps {
  readonly origin: () => string
  readonly credential: () => CanvasCredential | null
  readonly dial: BridgeDialer
  readonly log?: (message: string) => void
}

export const createCanvasRelay = (deps: CanvasRelayDeps): CanvasRelay => {
  const link = createCanvasLink({ origin: deps.origin, credential: deps.credential, log: deps.log })
  const uplink = createRelayUplink(link)
  const bridge = createCanvasBridge({
    send: uplink.send,
    dial: deps.dial,
    // Small frames, so lanes take turns at a fine grain rather than 384 KB at a time.
    chunk: RELAY_CHUNK,
    room: uplink.room,
    log: deps.log
  })
  link.onFrame((line) => {
    uplink.heard(line)
    bridge.frame(line)
  })
  // A line that ended takes every exchange riding it with it; a local request
  // left running would be an event stream nobody will ever read again.
  link.onDrop(() => {
    uplink.reset()
    bridge.reset()
  })
  return { link, bridge, uplink, start: link.start, stop: link.stop }
}
