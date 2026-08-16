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
  private latestSeq: number | null = null
  private latestRevision: number | null = null
  private latestContext: MapContext | null = null
  private deliveredRevision: number | null = null
  private drainArmed = false
  private instance: HeadlessInstance | null = null
  private unsubscribeViewport: (() => void) | null = null
  private ctx: MapContext = { displayScale: 1, viewportWidth: 800, viewportHeight: 600 }
  private readonly frameContexts = new Map<number, { ctx: MapContext; revision: number }>()
  private observedPageScaleFactor = 1
  private hasObservedPageScaleFactor = false
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
    if (
      typeof meta.pageScaleFactor === 'number' &&
      Number.isFinite(meta.pageScaleFactor) &&
      meta.pageScaleFactor > 0
    ) {
      this.observedPageScaleFactor = meta.pageScaleFactor
      this.hasObservedPageScaleFactor = true
    } else if (this.hasObservedPageScaleFactor) {
      // Never pair a new frame with a scale inherited from an older frame.
      return
    }
    let frameContext = this.ctx
    if (deviceWidth && deviceHeight && size && deviceWidth > 0) {
      frameContext = {
        // Frame pixels cover the visual viewport. At pinch zoom, Chromium's
        // deviceWidth remains fixed while each page CSS px occupies
        // pageScaleFactor frame pixels.
        displayScale: (size.width / deviceWidth) * this.observedPageScaleFactor,
        viewportWidth: deviceWidth / this.observedPageScaleFactor,
        viewportHeight: deviceHeight / this.observedPageScaleFactor
      }
    }
    const revision = meta.revision ?? viewport?.revision ?? 1
    const seq = (this.seq += 1)
    const msg = JSON.stringify({
      t: 'frame',
      seq,
      data: base64,
      meta: {
        deviceWidth,
        deviceHeight,
        displayScale: frameContext.displayScale,
        pageScaleFactor: this.observedPageScaleFactor,
        mobile: meta.mobile ?? viewport?.mobile ?? false,
        revision
      }
    })
    if (this.socket.writableLength <= DEFAULT_DRAIN_THRESHOLD) {
      this.latest = null
      this.latestSeq = null
      this.latestRevision = null
      this.latestContext = null
      this.wsSend(msg)
      if (!this.closed) {
        this.ctx = frameContext
        this.deliveredRevision = revision
        this.rememberFrameContext(seq, revision, frameContext)
      }
    } else {
      this.latest = msg
      this.latestSeq = seq
      this.latestRevision = revision
      this.latestContext = frameContext
      this.armDrain()
    }
  }

  private armDrain(): void {
    if (this.drainArmed) return
    this.drainArmed = true
    this.socket.once('drain', () => {
      this.drainArmed = false
      const pending = this.latest
      const seq = this.latestSeq
      const revision = this.latestRevision
      const context = this.latestContext
      this.latest = null
      this.latestSeq = null
      this.latestRevision = null
      this.latestContext = null
      if (pending && !this.closed) {
        this.wsSend(pending)
        if (!this.closed) {
          if (context) this.ctx = context
          this.deliveredRevision = revision
          if (seq !== null && revision !== null && context) {
            this.rememberFrameContext(seq, revision, context)
          }
        }
      }
    })
  }

  private rememberFrameContext(seq: number, revision: number, ctx: MapContext): void {
    this.frameContexts.set(seq, { ctx, revision })
    while (this.frameContexts.size > 32) {
      const oldest = this.frameContexts.keys().next().value
      if (typeof oldest !== 'number') break
      this.frameContexts.delete(oldest)
    }
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
    const frameSeq = input.frameSeq
    const needsFrameContext = input.t !== 'key' && input.t !== 'touchend'
    const frameContext = Number.isInteger(frameSeq)
      ? this.frameContexts.get(frameSeq as number)
      : undefined
    const releasesActivePointer = input.t === 'up' || input.t === 'touchend'
    const viewport = instance.viewportState
    if (
      ((viewport.transitioning || viewport.agentHeld) && !releasesActivePointer) ||
      !Number.isInteger(revision) ||
      revision !== viewport.revision ||
      revision !== this.deliveredRevision ||
      (needsFrameContext && (!frameContext || frameContext.revision !== revision))
    ) return
    const commands = sanitizeInput(raw, frameContext?.ctx ?? this.ctx)
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
    this.latestSeq = null
    this.latestRevision = null
    this.latestContext = null
    this.deliveredRevision = null
    this.frameContexts.clear()
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
