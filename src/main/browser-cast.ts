// WebSocket viewer/input transport for node-owned headless browsers.
//
// Browser lifecycle belongs to HeadlessBrowserManager. This module only
// attaches viewers to an existing node instance, fans out JPEG frames with
// per-client latest-frame pacing, and translates the closed WS input vocabulary
// through sanitizeInput. There is no raw CDP passthrough from the network.

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { sanitizeInput, type MapContext } from '../shared/cast-input'
import { jpegSize } from './jpeg-size'
import { DEFAULT_DRAIN_THRESHOLD } from './screencast-pace'
import type { FrameMeta, HeadlessInstance } from './headless-chrome'
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
  getInstance: (browserId: string) => Promise<HeadlessInstance | null>
  enabled: () => boolean
  /** Per-process secret used only by the cross-origin Electron renderer. */
  desktopToken: () => string
}

const STREAM_RE = /^\/api\/browser\/([^/]+)\/stream$/

export function originAllowed(req: {
  headers: { origin?: string | string[]; host?: string }
}): boolean {
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin
  if (!origin) return true
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
    if (
      !deps.enabled() ||
      typeof key !== 'string' ||
      (!originAllowed(req) && !desktopAuthorized)
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
    const client = new ClientConn(socket, () => clients.delete(client))
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
    activeCount: () => clients.size
  }
}

class ClientConn {
  private inbound: Buffer = Buffer.alloc(0)
  private seq = 0
  private closed = false
  private latest: string | null = null
  private drainArmed = false
  private instance: HeadlessInstance | null = null
  private ctx: MapContext = { displayScale: 1, viewportWidth: 800, viewportHeight: 600 }
  private readonly frameListener = (data: string, meta: FrameMeta): void =>
    this.pushFrame(data, meta)

  constructor(
    private readonly socket: Duplex,
    private readonly onClosed: () => void
  ) {
    socket.on('data', this.onData)
    socket.on('close', this.close)
    socket.on('error', this.close)
  }

  attach(instance: HeadlessInstance): void {
    if (this.closed) return
    this.instance = instance
    const viewport = instance.viewport
    this.ctx = {
      displayScale: 1,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height
    }
    instance.frameListeners.add(this.frameListener)
    this.wsSend(JSON.stringify({ t: 'ready', w: viewport.width, h: viewport.height }))
  }

  fail(message: string): void {
    if (this.closed) return
    this.wsSend(JSON.stringify({ t: 'error', msg: message }))
    this.close()
  }

  private pushFrame(base64: string, _meta: FrameMeta): void {
    if (this.closed) return
    const viewport = this.instance?.viewport
    const size = jpegSize(Buffer.from(base64, 'base64'))
    if (viewport && size && viewport.width > 0) {
      this.ctx = {
        displayScale: size.width / viewport.width,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height
      }
    }
    const msg = JSON.stringify({
      t: 'frame',
      seq: (this.seq += 1),
      data: base64,
      meta: {
        deviceWidth: this.ctx.viewportWidth,
        deviceHeight: this.ctx.viewportHeight,
        displayScale: this.ctx.displayScale
      }
    })
    if (this.socket.writableLength <= DEFAULT_DRAIN_THRESHOLD) {
      this.wsSend(msg)
    } else {
      this.latest = msg
      this.armDrain()
    }
  }

  private armDrain(): void {
    if (this.drainArmed) return
    this.drainArmed = true
    this.socket.once('drain', () => {
      this.drainArmed = false
      const pending = this.latest
      this.latest = null
      if (pending && !this.closed) this.wsSend(pending)
    })
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
    const instance = this.instance
    if (!instance) return
    const commands = sanitizeInput(raw, this.ctx)
    if (!commands) return
    for (const command of commands) instance.dispatchInput(command.method, command.params)
  }

  private wsSend(message: string): void {
    if (this.closed) return
    try {
      this.socket.write(encodeTextFrame(message))
    } catch {
      this.close()
    }
  }

  close = (): void => {
    if (this.closed) return
    this.closed = true
    this.latest = null
    this.instance?.frameListeners.delete(this.frameListener)
    this.instance = null
    try {
      this.socket.destroy()
    } catch {
      // Socket already closed.
    }
    this.onClosed()
  }
}
