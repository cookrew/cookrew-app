// Interactive remote browser — CDP transport (main process).
//
// A phone opens a WebSocket to /api/browser/:id/stream; we attach the Chrome
// DevTools Protocol debugger to that browser's active <webview>, stream
// Page.startScreencast JPEG frames down the socket, and drive the page from a
// SMALL, whitelisted input vocabulary coming back up (see cast-input.ts —
// mouse/key only, never a generic CDP passthrough on this unauth LAN server).
//
// Backpressure is the latency knob: CDP won't send the next frame until we ack,
// and we hold the ack until the socket drains (screencast-pace.ts) so frames
// can't pile up. The debugger is attached only for the life of the socket and
// detached on close/quit — it is mutually exclusive with DevTools.
//
// The whole transport is behind a flag (deps.enabled); off = sockets refused.

import type { WebContents } from 'electron'
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { acceptKey, decodeFrame, encodeControlFrame, encodeTextFrame, MAX_CLIENT_FRAME_BYTES, OVERSIZED_FRAME, OPCODE } from './ws-frame'
import { sanitizeInput, type MapContext } from '../shared/cast-input'
import { DEFAULT_DRAIN_THRESHOLD, decideAck } from './screencast-pace'
import { jpegSize } from './jpeg-size'

export interface BrowserCastDeps {
  /** Active-tab webContents for a browser id, or null if unknown/detached. */
  resolveWebContents: (browserId: string) => WebContents | null
  /** Feature flag — the transport is inert unless this returns true. */
  enabled: () => boolean
}

const STREAM_RE = /^\/api\/browser\/([^/]+)\/stream$/
const SCREENCAST_MIN = 320
const SCREENCAST_MAX = 2048

function clampInt(raw: string | null, lo: number, hi: number, fallback: number): number {
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), lo), hi) : fallback
}

/**
 * The Origin (if any) must share the request's Host — the served phone bundle
 * connects same-origin; native/CLI clients send no Origin. A cross-origin web
 * page (CSWSH / DNS-rebinding) is refused. Exported for tests.
 */
export function originAllowed(req: {
  headers: { origin?: string | string[]; host?: string }
}): boolean {
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin
  if (!origin) return true // no Origin = not a browser page (native app / curl)
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

export interface BrowserCast {
  /** HTTP 'upgrade' handler; ignores non-stream paths. */
  upgrade: (req: IncomingMessage, socket: Duplex) => void
  /** Detach every live session (app quit). */
  shutdown: () => void
  activeCount: () => number
}

export function createBrowserCast(deps: BrowserCastDeps): BrowserCast {
  const sessions = new Set<CastSession>()

  function upgrade(req: IncomingMessage, socket: Duplex): void {
    const url = new URL(req.url ?? '/', 'http://localhost')
    // Match the PATHNAME, not req.url — the raw url carries the ?w=&h= query,
    // and STREAM_RE is `$`-anchored after /stream, so matching req.url missed
    // for every real client (they all send w/h). Sole upgrade handler here —
    // an upgrade to any other path is refused, not left dangling.
    const match = url.pathname.match(STREAM_RE)
    if (!match) return void socket.destroy()
    const browserId = decodeURIComponent(match[1])
    const key = req.headers['sec-websocket-key']
    if (!deps.enabled() || typeof key !== 'string') return void socket.destroy()
    // Defense-in-depth vs CSWSH / DNS-rebinding: a cross-origin web page could
    // otherwise open this WS (WebSockets ignore same-origin policy) and both
    // watch and drive the logged-in browser. Allow only same-host origins (the
    // served phone bundle) or no Origin (native/CLI clients have none).
    if (!originAllowed(req)) return void socket.destroy()
    const wc = deps.resolveWebContents(browserId)
    if (!wc) return void socket.destroy()

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    )
    const session = new CastSession(wc, socket, {
      maxWidth: clampInt(url.searchParams.get('w'), SCREENCAST_MIN, SCREENCAST_MAX, 800),
      maxHeight: clampInt(url.searchParams.get('h'), SCREENCAST_MIN, SCREENCAST_MAX, 1400)
    })
    session.onClosed = () => sessions.delete(session)
    sessions.add(session)
    session.start()
  }

  return {
    upgrade,
    shutdown: () => {
      for (const s of [...sessions]) s.teardown()
    },
    activeCount: () => sessions.size
  }
}

interface CastOptions {
  maxWidth: number
  maxHeight: number
}

/** One phone<->browser bridge: CDP screencast down, whitelisted input up. */
class CastSession {
  private inbound: Buffer = Buffer.alloc(0)
  private seq = 0
  private closed = false
  /** Coord-mapping context, refreshed from each frame's metadata + JPEG width. */
  private ctx: MapContext
  onClosed: () => void = () => undefined

  constructor(
    private readonly wc: WebContents,
    private readonly socket: Duplex,
    private readonly opts: CastOptions
  ) {
    this.ctx = { displayScale: 1, viewportWidth: opts.maxWidth, viewportHeight: opts.maxHeight }
  }

  start(): void {
    try {
      this.wc.debugger.attach('1.3')
    } catch (error) {
      // Already attached (another viewer / DevTools open) — refuse cleanly.
      this.wsSend({ t: 'error', msg: `attach failed: ${(error as Error).message}` })
      return this.teardown()
    }
    this.wc.debugger.on('message', this.onCdp)
    this.wc.debugger.on('detach', this.teardown)
    this.socket.on('data', this.onData)
    this.socket.on('close', this.teardown)
    this.socket.on('error', this.teardown)
    void this.cdp('Page.enable')
    void this.cdp('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: this.opts.maxWidth,
      maxHeight: this.opts.maxHeight,
      everyNthFrame: 1
    })
    this.wsSend({ t: 'ready', w: this.opts.maxWidth, h: this.opts.maxHeight })
  }

  private cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.wc.debugger.sendCommand(method, params).catch(() => undefined)
  }

  private onCdp = (_event: unknown, method: string, params: Record<string, unknown>): void => {
    if (this.closed || method !== 'Page.screencastFrame') return
    const data = params.data as string
    const sessionId = params.sessionId as number
    const meta = (params.metadata ?? {}) as Record<string, number>
    const deviceWidth = meta.deviceWidth || this.opts.maxWidth
    const deviceHeight = meta.deviceHeight || this.opts.maxHeight
    const size = jpegSize(Buffer.from(data, 'base64'))
    if (size && deviceWidth > 0) {
      // displayScale = frame px / page CSS px; sanitizeInput maps tap/displayScale.
      this.ctx = { displayScale: size.width / deviceWidth, viewportWidth: deviceWidth, viewportHeight: deviceHeight }
    }
    this.seq += 1
    this.wsSend({
      t: 'frame',
      seq: this.seq,
      data,
      meta: { deviceWidth, deviceHeight, displayScale: this.ctx.displayScale }
    })
    // Ack pacing = backpressure. Ack now if the socket has drained, else defer
    // to 'drain' so CDP can't outrun the LAN and bloat the buffer.
    const { ackNow } = decideAck({
      bufferedAmount: this.socket.writableLength,
      drainThreshold: DEFAULT_DRAIN_THRESHOLD
    })
    const ack = (): void => {
      if (!this.closed) void this.cdp('Page.screencastFrameAck', { sessionId })
    }
    if (ackNow) ack()
    else this.socket.once('drain', ack)
  }

  private onData = (chunk: Buffer): void => {
    this.inbound = Buffer.concat([this.inbound, chunk])
    // Independent backstop: even before a frame header is complete, never let
    // the inbound buffer grow past a sane bound (a hostile client dribbling a
    // huge declared frame). Client input frames are always small.
    if (this.inbound.length > MAX_CLIENT_FRAME_BYTES + 16) return this.teardown()
    for (;;) {
      const frame = decodeFrame(this.inbound)
      if (frame === OVERSIZED_FRAME) return this.teardown()
      if (!frame) break
      this.inbound = frame.rest
      if (frame.opcode === OPCODE.close) return this.teardown()
      if (frame.opcode === OPCODE.ping) {
        this.socket.write(encodeControlFrame(OPCODE.pong, frame.payload))
        continue
      }
      if (frame.opcode === OPCODE.text) this.handleInput(frame.payload.toString('utf8'))
    }
  }

  private handleInput(text: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch {
      return // malformed JSON — drop
    }
    const commands = sanitizeInput(msg, this.ctx) // whitelist + clamp (SECURITY)
    if (!commands) return
    for (const command of commands) void this.cdp(command.method, command.params)
  }

  private wsSend(obj: unknown): void {
    if (this.closed) return
    try {
      this.socket.write(encodeTextFrame(JSON.stringify(obj)))
    } catch {
      this.teardown()
    }
  }

  teardown = (): void => {
    if (this.closed) return
    this.closed = true
    try {
      this.wc.debugger.removeListener('message', this.onCdp)
      void this.wc.debugger.sendCommand('Page.stopScreencast').catch(() => undefined)
      this.wc.debugger.detach()
    } catch {
      // already detached / webContents gone
    }
    try {
      this.socket.destroy()
    } catch {
      // already closed
    }
    this.onClosed()
  }
}
