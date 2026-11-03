// One viewer of a node-owned browser, whatever carries it.
//
// The WebSocket (a phone, over the LAN or the relay) and the desktop's own
// MessagePort (browser-cast-ipc.ts) see and drive the SAME instance through
// this one class: viewport arbitration, per-frame input mapping, the closed
// input vocabulary (sanitizeInput), copies and device status. The transport
// is a ViewerSink and only decides how bytes leave and when the next frame
// may go.

import { randomUUID } from 'node:crypto'
import { sanitizeInput, type CdpInputCommand, type MapContext } from '../shared/cast-input'
import { sanitizeViewportMessage } from '../shared/cast-viewport'
import type { UseStatus } from '../shared/use-signal'
import { jpegSize } from './jpeg-size'
import { copyArmed } from './page-copy'
import type { BrowserViewportState } from './browser-viewport'
import type { FrameMeta } from './headless-chrome'
import type { BrowserInstance } from './browser-instance'

/** What a frame carries besides its JPEG. */
export interface OutboundFrameMeta {
  deviceWidth?: number
  deviceHeight?: number
  displayScale: number
  pageScaleFactor: number
  mobile: boolean
  revision: number
}

export interface OutboundFrame {
  seq: number
  /** The JPEG as Chrome sent it. */
  base64: string
  /** The same JPEG decoded once and shared by every viewer of this frame. */
  bytes: Buffer
  meta: OutboundFrameMeta
}

/** How one viewer's messages leave, and when it can take the next frame. */
export interface ViewerSink {
  /** Small JSON (ready, viewport state, status, copy, error): always sent, in order. */
  sendControl: (message: Record<string, unknown>) => void
  /** May a frame go now? False keeps only the latest and waits for onceReady. */
  frameReady: () => boolean
  sendFrame: (frame: OutboundFrame) => void
  /** Call back once when the next frame may go (a socket's drain, a returned credit). */
  onceReady: (callback: () => void) => void
  /** Tear the transport down; the viewer has already detached. */
  close: () => void
}

/**
 * Chrome's base64 → bytes, once per frame. Every viewer of an instance gets
 * the same string object in turn, so one remembered pair saves a decode per
 * extra viewer (and per jpegSize read).
 */
let lastBase64: string | null = null
let lastBytes: Buffer = Buffer.alloc(0)
function frameBytes(base64: string): Buffer {
  if (base64 !== lastBase64) {
    lastBase64 = base64
    lastBytes = Buffer.from(base64, 'base64')
  }
  return lastBytes
}

const PINCH = 'Input.synthesizePinchGesture'
const MAX_PINCH_STEP = 4
const MIN_PINCH_STEP = 0.25
/** A step takes ~70 ms; one that never answers (a tab switched mid-gesture) must not wedge every later pinch. */
export const PINCH_STEP_TIMEOUT_MS = 500

export class CastViewer {
  readonly id = randomUUID()
  private seq = 0
  private closed = false
  private latest: OutboundFrame | null = null
  private latestContext: MapContext | null = null
  private deliveredRevision: number | null = null
  private waitingForReady = false
  private instance: BrowserInstance | null = null
  private unsubscribeViewport: (() => void) | null = null
  private ctx: MapContext = { displayScale: 1, viewportWidth: 800, viewportHeight: 600 }
  private readonly frameContexts = new Map<number, { ctx: MapContext; revision: number }>()
  private observedPageScaleFactor = 1
  private hasObservedPageScaleFactor = false
  /** A pinch step is animated in Chrome (~70 ms): one at a time, the rest folded into the next. */
  private pinchBusy = false
  private pinchPending: CdpInputCommand | null = null
  private readonly frameListener = (data: string, meta: FrameMeta): void => this.pushFrame(data, meta)
  private readonly viewportListener = (state: BrowserViewportState): void => this.pushViewportState(state)
  /** A use's device state: a viewer shows "offline — <why>" over the last frame instead of a frozen screen. */
  private readonly statusListener = (status: UseStatus): void =>
    this.sink.sendControl({ t: 'status', ...status })
  /** When this viewer's own input last reached the page: a copy right after it is theirs (page-copy.ts). */
  private lastInputAt: number | null = null
  /**
   * The page copied: this viewer's clipboard gets it only if this viewer just
   * acted on the page. A page copying on its own, or after another viewer's
   * click, writes nobody's clipboard here.
   */
  private readonly copyListener = (text: string): void => {
    if (copyArmed(this.lastInputAt, Date.now())) this.sink.sendControl({ t: 'copy', text })
  }

  constructor(
    private readonly sink: ViewerSink,
    private readonly onClosed: () => void,
    readonly browserId: string
  ) {}

  get isClosed(): boolean {
    return this.closed
  }

  attach(instance: BrowserInstance): void {
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
    instance.statusListeners?.add(this.statusListener)
    instance.copyListeners?.add(this.copyListener)
    this.sink.sendControl({
      t: 'ready',
      w: viewport.width,
      h: viewport.height,
      mobile: viewport.mobile,
      revision: viewport.revision
    })
    this.pushViewportState(viewport)
    if (instance.status) this.statusListener(instance.status)
  }

  fail(message: string): void {
    if (this.closed) return
    this.sink.sendControl({ t: 'error', msg: message })
    this.close()
  }

  private pushFrame(base64: string, meta: FrameMeta): void {
    if (this.closed) return
    const viewport = this.instance?.viewportState
    const bytes = frameBytes(base64)
    const size = jpegSize(bytes)
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
    const frame: OutboundFrame = {
      seq: (this.seq += 1),
      base64,
      bytes,
      meta: {
        deviceWidth,
        deviceHeight,
        displayScale: frameContext.displayScale,
        pageScaleFactor: this.observedPageScaleFactor,
        mobile: meta.mobile ?? viewport?.mobile ?? false,
        revision
      }
    }
    if (this.sink.frameReady()) {
      this.latest = null
      this.latestContext = null
      this.deliver(frame, frameContext)
    } else {
      // Keep the latest only: a viewer that is behind skips to now.
      this.latest = frame
      this.latestContext = frameContext
      this.armReady()
    }
  }

  private deliver(frame: OutboundFrame, context: MapContext): void {
    this.sink.sendFrame(frame)
    if (this.closed) return
    this.ctx = context
    this.deliveredRevision = frame.meta.revision
    this.rememberFrameContext(frame.seq, frame.meta.revision, context)
  }

  private armReady(): void {
    if (this.waitingForReady) return
    this.waitingForReady = true
    this.sink.onceReady(() => {
      this.waitingForReady = false
      const pending = this.latest
      const context = this.latestContext
      if (!pending || !context || this.closed) return
      this.latest = null
      this.latestContext = null
      this.deliver(pending, context)
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

  /** One message from the viewer, already parsed: a viewport intent or input. */
  handleMessage(raw: unknown): void {
    const instance = this.instance
    if (!instance || this.closed) return
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
    const needsFrameContext = !POINTLESS.has(input.t as string)
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
    for (const command of commands) this.dispatch(instance, command)
    this.lastInputAt = Date.now()
  }

  private dispatch(instance: BrowserInstance, command: CdpInputCommand): void {
    if (command.method !== PINCH) {
      void instance.dispatchInput(command.method, command.params)
      return
    }
    if (this.pinchBusy) {
      this.pinchPending = foldPinch(this.pinchPending, command)
      return
    }
    this.pinchBusy = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const step = Promise.resolve(instance.dispatchInput(command.method, command.params)).catch(() => undefined)
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, PINCH_STEP_TIMEOUT_MS)
    })
    void Promise.race([step, deadline]).then(() => {
      if (timer) clearTimeout(timer)
      this.pinchBusy = false
      const next = this.pinchPending
      this.pinchPending = null
      if (!next || this.closed || this.instance !== instance) return
      // The folded step was accepted against an older state: the same gate again before it goes.
      const viewport = instance.viewportState
      if (viewport.transitioning || viewport.agentHeld || viewport.revision !== this.deliveredRevision) return
      this.dispatch(instance, next)
    })
  }

  private pushViewportState(state: BrowserViewportState): void {
    this.sink.sendControl({
      t: 'viewport-state',
      width: state.width,
      height: state.height,
      mobile: state.mobile,
      revision: state.revision,
      owner: state.ownerId === this.id ? 'self' : state.ownerId ? 'other' : 'none',
      viewerCount: state.viewerCount,
      agentHeld: state.agentHeld,
      transitioning: state.transitioning
    })
  }

  close = (): void => {
    if (this.closed) return
    this.closed = true
    this.latest = null
    this.latestContext = null
    this.deliveredRevision = null
    this.pinchPending = null
    this.frameContexts.clear()
    this.instance?.frameListeners.delete(this.frameListener)
    this.instance?.statusListeners?.delete(this.statusListener)
    this.instance?.copyListeners?.delete(this.copyListener)
    this.unsubscribeViewport?.()
    this.unsubscribeViewport = null
    this.instance?.unregisterViewportViewer(this.id)
    this.instance = null
    try {
      this.sink.close()
    } catch {
      // Transport already closed.
    }
    this.onClosed()
  }
}

/** Input with no point on the page: it needs no painted frame to map against. */
const POINTLESS = new Set(['key', 'touchend', 'text', 'compose'])

/** Two pinch steps as one: scales multiply, the newest anchor wins. */
export function foldPinch(pending: CdpInputCommand | null, next: CdpInputCommand): CdpInputCommand {
  if (!pending) return next
  const a = typeof pending.params.scaleFactor === 'number' ? pending.params.scaleFactor : 1
  const b = typeof next.params.scaleFactor === 'number' ? next.params.scaleFactor : 1
  return {
    method: next.method,
    params: {
      ...next.params,
      scaleFactor: Math.min(Math.max(a * b, MIN_PINCH_STEP), MAX_PINCH_STEP)
    }
  }
}
