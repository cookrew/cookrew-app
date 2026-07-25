// WebSocket viewer/input transport for node-owned headless browsers.
//
// Browser lifecycle belongs to HeadlessBrowserManager. This module only
// attaches viewers to an existing node instance, fans out JPEG frames with
// per-client latest-frame pacing, and translates the closed WS input vocabulary
// through sanitizeInput. There is no raw CDP passthrough from the network.

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { sanitizeInput, type MapContext } from '../shared/cast-input'
import { sanitizeViewportMessage } from '../shared/cast-viewport'
import { jpegSize } from './jpeg-size'
import { DEFAULT_DRAIN_THRESHOLD } from './screencast-pace'
import type { BrowserViewportState } from './browser-viewport'
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
  private readonly id = randomUUID()
  private inbound: Buffer = Buffer.alloc(0)
  private seq = 0
  private closed = false
  private latest: string | null = null
  private latestRevision: number | null = null
  private deliveredRevision: number | null = null
  private drainArmed = false
  private instance: HeadlessInstance | null = null
  private unsubscribeViewport: (() => void) | null = null
  private ctx: MapContext = { displayScale: 1, viewportWidth: 800, viewportHeight: 600 }
  private readonly frameListener = (data: string, meta: FrameMeta): void =>
    this.pushFrame(data, meta)
  private readonly viewportListener = (state: BrowserViewportState): void =>
    this.pushViewportState(state)

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
    instance.registerViewportViewer(this.id)
    this.unsubscribeViewport = instance.onViewportState(this.viewportListener)
    const viewport = instance.viewportState
    this.ctx = {
      displayScale: 1,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height
    }
    instance.frameListeners.add(this.frameListener)
    this.wsSend(JSON.stringify({
      t: 'ready',
      w: viewport.width,
      h: viewport.height,
      mobile: viewport.mobile,
      revision: viewport.revision
    }))
    this.pushViewportState(viewport)
  }

  fail(message: string): void {
    if (this.closed) return
    this.wsSend(JSON.stringify({ t: 'error', msg: message }))
    this.close()
  }

  private pushFrame(base64: string, meta: FrameMeta): void {
    if (this.closed) return
    const viewport = this.instance?.viewportState
    const size = jpegSize(Buffer.from(base64, 'base64'))
    const deviceWidth = meta.deviceWidth ?? viewport?.width
    const deviceHeight = meta.deviceHeight ?? viewport?.height
    if (deviceWidth && deviceHeight && size && deviceWidth > 0) {
      this.ctx = {
        displayScale: size.width / deviceWidth,
        viewportWidth: deviceWidth,
        viewportHeight: deviceHeight
      }
    }
    const revision = meta.revision ?? viewport?.revision ?? 1
    const msg = JSON.stringify({
      t: 'frame',
      seq: (this.seq += 1),
      data: base64,
      meta: {
        deviceWidth: this.ctx.viewportWidth,
        deviceHeight: this.ctx.viewportHeight,
        displayScale: this.ctx.displayScale,
        mobile: meta.mobile ?? viewport?.mobile ?? false,
        revision
      }
    })
    if (this.socket.writableLength <= DEFAULT_DRAIN_THRESHOLD) {
      this.latest = null
      this.latestRevision = null
      this.wsSend(msg)
      if (!this.closed) this.deliveredRevision = revision
    } else {
      this.latest = msg
      this.latestRevision = revision
      this.armDrain()
    }
  }

  private armDrain(): void {
    if (this.drainArmed) return
    this.drainArmed = true
    this.socket.once('drain', () => {
      this.drainArmed = false
      const pending = this.latest
      const revision = this.latestRevision
      this.latest = null
      this.latestRevision = null
      if (pending && !this.closed) {
        this.wsSend(pending)
        if (!this.closed) this.deliveredRevision = revision
      }
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
    const viewportMessage = sanitizeViewportMessage(raw)
    if (viewportMessage) {
      if (viewportMessage.type === 'offer') instance.offerViewport(this.id, viewportMessage.metrics)
      else if (viewportMessage.type === 'claim') instance.claimViewport(this.id, viewportMessage.metrics)
      else instance.releaseViewport(this.id)
      this.pushViewportState(instance.viewportState)
      return
    }
    if (typeof raw !== 'object' || raw === null) return
    const input = raw as Record<string, unknown>
    const revision = input.revision
    const releasesActivePointer = input.t === 'up' || input.t === 'touchend'
    const viewport = instance.viewportState
    if (
      ((viewport.transitioning || viewport.agentHeld) && !releasesActivePointer) ||
      !Number.isInteger(revision) ||
      revision !== viewport.revision ||
      revision !== this.deliveredRevision
    ) return
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

  private pushViewportState(state: BrowserViewportState): void {
    this.wsSend(JSON.stringify({
      t: 'viewport-state',
      width: state.width,
      height: state.height,
      mobile: state.mobile,
      revision: state.revision,
      owner: state.ownerId === this.id ? 'self' : state.ownerId ? 'other' : 'none',
      viewerCount: state.viewerCount,
      agentHeld: state.agentHeld,
      transitioning: state.transitioning
    }))
  }

  close = (): void => {
    if (this.closed) return
    this.closed = true
    this.latest = null
    this.latestRevision = null
    this.deliveredRevision = null
    this.instance?.frameListeners.delete(this.frameListener)
    this.unsubscribeViewport?.()
    this.unsubscribeViewport = null
    this.instance?.unregisterViewportViewer(this.id)
    this.instance = null
    try {
      this.socket.destroy()
    } catch {
      // Socket already closed.
    }
    this.onClosed()
  }
}
