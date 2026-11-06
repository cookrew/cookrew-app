// WebSocket viewer/input transport for node-owned headless browsers — the
// phone's. The desktop draws the same instance over its own MessagePort
// (browser-cast-ipc.ts); both are a CastViewer (cast-viewer.ts).
//
// Browser lifecycle belongs to HeadlessBrowserManager. This module only
// attaches viewers to an existing node instance, fans out JPEG frames with
// per-client latest-frame pacing, and translates the closed WS input vocabulary
// through sanitizeInput. There is no raw CDP passthrough from the network.

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { DEFAULT_DRAIN_THRESHOLD } from './screencast-pace'
import type { BrowserInstance } from './browser-instance'
import { MAC_VIEWER, type ViewerWho } from '../shared/remote-access'
import { CastViewer, type OutboundFrame, type ViewerSink } from './cast-viewer'
import {
  acceptKey,
  decodeFrame,
  encodeControlFrame,
  encodeTextFrame,
  MAX_CLIENT_FRAME_BYTES,
  OPCODE,
  OVERSIZED_FRAME
} from './ws-frame'

export interface BrowserCastDeps {
  getInstance: (browserId: string) => Promise<BrowserInstance | null>
  /** Main draws this card (browser-owner.ts); a page in a webview has no stream. */
  enabled: (browserId: string) => boolean
  /** Per-process secret used only by the cross-origin Electron renderer. */
  desktopToken: () => string
  /**
   * Origins this server answers for besides its own host — the registry and
   * this Mac's trusted names (reach v2.1). Absent = same-host only, which is
   * what this was before names existed.
   */
  allowedOrigins?: () => readonly string[]
  /**
   * DOES THIS CREDENTIAL OPEN THE COMPANION? Required, never optional.
   *
   * The pairing token is what AUTHENTICATES this socket; Origin only filters.
   * A dep the caller may omit would be an authentication check any wiring
   * could switch off by forgetting a field — which is the exact shape of the
   * hole mobile-server.ts found in its own C1 gate ("the escape now requires
   * deliberately constructing deps without one").
   */
  paired: (credential: string | null) => boolean
  /**
   * Who a credential is, for the host's banner and for a card's grant. Absent,
   * every viewer goes unnamed: they can still be let in to watch, but an
   * unnamed viewer can never hold control, so forgetting this closes, not opens.
   */
  who?: (credential: string | null) => ViewerWho
}

const STREAM_RE = /^\/api\/browser\/([^/]+)\/stream$/

/**
 * WHO MAY OPEN THIS SOCKET, AND WHY THE LIST GREW BY ONE SHAPE.
 *
 * The guard is against cross-site WebSocket hijacking: a page anywhere can
 * open a `wss://` to a LAN address, and the browser will attach no CORS check
 * of its own — the Origin header is the only thing that says who is dialling.
 * Same host was the whole rule, which was right while the only page that ever
 * dialled this Mac was served BY this Mac.
 *
 * REACH v2.1 makes one more page legitimate: the companion at cookrew.dev,
 * which keeps its address while its data plane moves onto this Mac's LAN
 * name. Its Origin is the registry's, so same-host refuses it and the browser
 * card never streams over the fast path.
 *
 * So the rule is now: same host, OR an EXACT match against the origins this
 * server answers for (companion-cors.ts — the registry origin from config and
 * this Mac's own origins, trusted names included). Not a suffix match, not a
 * wildcard, and nothing loosened for anybody else.
 *
 * NO ORIGIN AT ALL is still allowed: that is a non-browser client (the app's
 * own renderer, a test), which is not what this guard defends against — a
 * browser always sends one.
 *
 * AND ORIGIN IS A FILTER, NEVER THE AUTHENTICATION. Any process that is not a
 * browser can set the header to whatever it likes, and a browser can be made
 * to send an allowed one by a page that has been rebound onto this Mac. So a
 * socket that passes this still has to present the pairing token
 * (`deps.paired`), which is the part that actually decides. Logitech Options'
 * local socket had neither and was driven by any page on the internet; the MCP
 * inspector (CVE-2025-49596) needed authentication PLUS Origin and Host
 * validation, not one of the three.
 */
export function originAllowed(
  req: { headers: { origin?: string | string[]; host?: string } },
  allowed: readonly string[] = []
): boolean {
  // Two Origin headers is not an origin — see companion-cors.ts.
  if (Array.isArray(req.headers.origin)) return false
  const origin = req.headers.origin
  if (!origin) return true
  const trimmed = origin.replace(/\/+$/, '')
  if (allowed.some((one) => one.length > 0 && one.replace(/\/+$/, '') === trimmed)) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

export interface BrowserCast {
  upgrade: (req: IncomingMessage, socket: Duplex) => void
  /** Close viewer sockets only; the node manager owns Chromium shutdown. */
  shutdown: () => void
  /**
   * Close one card's viewers: its instance was replaced (re-addressed to
   * another device) or removed. Left attached they would watch a stopped
   * instance forever; closed, each redials (useBrowserStream) and lands on
   * the new one.
   */
  drop: (browserId: string) => void
  activeCount: () => number
}

export function createBrowserCast(deps: BrowserCastDeps): BrowserCast {
  const clients = new Set<ClientConn>()

  function upgrade(req: IncomingMessage, socket: Duplex): void {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const match = url.pathname.match(STREAM_RE)
    if (!match) return void socket.destroy()
    let browserId: string
    try {
      browserId = decodeURIComponent(match[1])
    } catch {
      return void socket.destroy()
    }
    const key = req.headers['sec-websocket-key']
    const desktopAuthorized = url.searchParams.get('desktopToken') === deps.desktopToken()
    // `?token=`, not a header: `new WebSocket(...)` cannot set one, which is
    // the same constraint EventSource has and the same answer the HTTP gate
    // gives it (mobile-http.ts · pairingAuthorized).
    const authorized = desktopAuthorized || deps.paired(url.searchParams.get('token'))
    // Credentials before the card: `enabled` reads the store, and a stranger on
    // the LAN must not be able to make main walk it.
    if (
      typeof key !== 'string' ||
      !authorized ||
      (!originAllowed(req, deps.allowedOrigins?.() ?? []) && !desktopAuthorized) ||
      !deps.enabled(browserId)
    ) {
      return void socket.destroy()
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    )

    // Install close/error listeners BEFORE awaiting Chrome startup. Node streams
    // do not replay a close event to late listeners; this ordering closes C-1's
    // startup-disconnect leak.
    const who = desktopAuthorized ? MAC_VIEWER : deps.who?.(url.searchParams.get('token'))
    const client = new ClientConn(socket, () => clients.delete(client), browserId, who)
    clients.add(client)
    if (socket.destroyed) {
      client.close()
      return
    }

    void deps
      .getInstance(browserId)
      .then((instance) => {
        if (!instance) return client.fail('no headless instance')
        client.attach(instance)
      })
      .catch(() => client.fail('headless instance failed'))
  }

  return {
    upgrade,
    shutdown: () => {
      for (const client of [...clients]) client.close()
    },
    drop: (browserId) => {
      for (const client of [...clients]) if (client.browserId === browserId) client.close()
    },
    activeCount: () => clients.size
  }
}

/**
 * One WebSocket viewer: a CastViewer whose sink is this socket. Frames are
 * JSON text with the JPEG in base64 (the relay and the phone's data channel
 * carry text); pacing is the socket's own drain.
 */
class ClientConn {
  private inbound: Buffer = Buffer.alloc(0)
  private readonly viewer: CastViewer

  constructor(
    private readonly socket: Duplex,
    onClosed: () => void,
    readonly browserId: string,
    who?: ViewerWho
  ) {
    const sink: ViewerSink = {
      sendControl: (message) => this.wsSend(JSON.stringify(message)),
      frameReady: () => this.socket.writableLength <= DEFAULT_DRAIN_THRESHOLD,
      sendFrame: (frame) => this.wsSend(frameText(frame)),
      onceReady: (callback) => void this.socket.once('drain', callback),
      close: () => this.socket.destroy()
    }
    this.viewer = new CastViewer(sink, onClosed, browserId, who)
    socket.on('data', this.onData)
    socket.on('close', this.close)
    socket.on('error', this.close)
  }

  attach(instance: BrowserInstance): void {
    this.viewer.attach(instance)
  }

  fail(message: string): void {
    this.viewer.fail(message)
  }

  private onData = (chunk: Buffer): void => {
    this.inbound = Buffer.concat([this.inbound, chunk])
    if (this.inbound.length > MAX_CLIENT_FRAME_BYTES + 16) return this.close()
    for (;;) {
      const frame = decodeFrame(this.inbound)
      if (frame === OVERSIZED_FRAME) return this.close()
      if (!frame) break
      this.inbound = frame.rest
      if (frame.opcode === OPCODE.close) return this.close()
      if (frame.opcode === OPCODE.ping) {
        this.socket.write(encodeControlFrame(OPCODE.pong, frame.payload))
        continue
      }
      if (frame.opcode === OPCODE.text) this.handleInput(frame.payload.toString('utf8'))
    }
  }

  private handleInput(text: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return
    }
    this.viewer.handleMessage(raw)
  }

  private wsSend(message: string): void {
    if (this.viewer?.isClosed) return
    try {
      this.socket.write(encodeTextFrame(message))
    } catch {
      this.close()
    }
  }

  close = (): void => {
    this.viewer.close()
  }
}

/** The phone's frame: the JPEG as base64 inside the same JSON the client has always parsed. */
function frameText(frame: OutboundFrame): string {
  return JSON.stringify({ t: 'frame', seq: frame.seq, data: frame.base64, meta: frame.meta })
}
