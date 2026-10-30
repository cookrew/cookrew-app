import type { CdpInputCommand } from '../shared/cast-input'
import type { ViewportMetrics } from '../shared/cast-viewport'
import type { BrowserTab } from '../shared/model'
import type { UseStatus } from '../shared/use-signal'
import type { UseTarget } from '../shared/use-url'
import { BrowserViewportCoordinator, type BrowserViewportState } from './browser-viewport'
import type { FrameMeta, HeadlessPageState, HeadlessStopResult } from './headless-chrome'
import { VphoneGestureMapper, type Gesture, type ScreenPoints } from './vphone-input'

/**
 * A SCREEN THE AGENT USES, AS A BROWSER INSTANCE (computer, phone, hardware).
 *
 * The vphone card proved the shape: an instance that produces JPEG frames
 * and takes the cast's closed input vocabulary is all the cast, the WebRTC
 * link and both renderers need. This is that instance with the device left
 * out — a PixelDevice says how to open the screen, take one frame and
 * perform one gesture, and this does the rest the same way for every kind:
 *
 *   CADENCE. Polled, fast for a few seconds after any input (the screen is
 *   about to change), slow when nothing happens, with a heartbeat so a viewer
 *   never calls a still screen stale.
 *
 *   STABILITY. A device that fails is NOT an exit. An unplugged phone, a
 *   camera another app holds, a window that closed, a permission not yet
 *   granted: the instance reports `offline` with the sentence that says why,
 *   backs off, and keeps trying — and when the device answers again the same
 *   card is live again, with the same viewers still attached. Exiting would
 *   drop every viewer and leave the owner to reopen a card for a cable that
 *   was wiggled. Only stop() ends it.
 *
 *   HONESTY. There is no page: evaluate refuses in words, tabs and resize are
 *   no-ops, the screen is the device's size.
 */

export const PIXEL_FAST_POLL_MS = 150
export const PIXEL_IDLE_POLL_MS = 800
export const PIXEL_FAST_WINDOW_MS = 3000
export const PIXEL_HEARTBEAT_MS = 700
/**
 * Nobody watching: one frame every few seconds, enough for the card's
 * thumbnail and for `screenshot`, instead of a screencapture or an adb
 * round trip every 800 ms for a card no one has open. A viewer arriving
 * wakes it at once (registerViewportViewer).
 */
export const PIXEL_UNWATCHED_POLL_MS = 5000
/** The longest gap between two tries at an offline device. */
export const PIXEL_MAX_BACKOFF_MS = 5000
/**
 * How long one open or one frame may take before the device counts as not
 * answering. A hung adb, a camera another app holds, a screencapture stuck
 * behind a dialog: each is an offline line with a reason, never a card that
 * says "connecting" forever.
 */
export const PIXEL_OPEN_TIMEOUT_MS = 15_000
export const PIXEL_CAPTURE_TIMEOUT_MS = 10_000

function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer in ${Math.round(ms / 1000)} s`)), ms)
  })
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export interface PixelFrame {
  /** Base64 JPEG. */
  readonly jpeg: string
  /** The screen in points, when the device knows it changed (a resized window, a rotated phone). */
  readonly points?: ScreenPoints
}

export interface PixelDevice {
  readonly target: UseTarget
  /** Opens the device and answers its screen in points; throws the sentence a viewer should read. */
  open(): Promise<ScreenPoints>
  capture(): Promise<PixelFrame>
  /** One gesture in points. Absent: the screen is watched, never driven. */
  perform?: (gesture: Gesture) => Promise<void>
  /** Why input is refused, when it is (computer input is off unless the owner turned it on). */
  inputRefusal?: () => string | null
  navigate?: (url: string) => Promise<void>
  title?: () => string
  close?: () => Promise<void>
}

export interface PixelInstanceOptions {
  readonly url: string
  readonly device: PixelDevice
  readonly now?: () => number
  readonly schedule?: (fn: () => void, ms: number) => () => void
}

const FALLBACK_POINTS: ScreenPoints = { width: 800, height: 600 }

export class PixelInstance {
  readonly frameListeners = new Set<(jpegBase64: string, meta: FrameMeta) => void>()
  readonly statusListeners = new Set<(status: UseStatus) => void>()
  onExit: () => void = () => undefined
  onPageState: (tabId: string, state: HeadlessPageState) => void = () => undefined
  onTabOpened: (tab: BrowserTab) => void = () => undefined
  onTabClosed: (tabId: string) => void = () => undefined

  private readonly now: () => number
  private readonly scheduleFn: (fn: () => void, ms: number) => () => void
  private readonly viewportCoordinator: BrowserViewportCoordinator
  private mapper: VphoneGestureMapper
  private points: ScreenPoints = FALLBACK_POINTS
  private cancel: (() => void) | null = null
  private closed = false
  private opened = false
  private polling = false
  private latest: string | null = null
  private lastEmitAt = 0
  private lastInputAt = Number.NEGATIVE_INFINITY
  private failures = 0
  private pollAgainSoon = false
  private inputQueue: Promise<void> = Promise.resolve()
  private statusNow: UseStatus

  constructor(private readonly opts: PixelInstanceOptions) {
    this.now = opts.now ?? Date.now
    this.scheduleFn =
      opts.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms)
        return () => clearTimeout(timer)
      })
    this.mapper = this.mapperFor(this.points)
    this.viewportCoordinator = new BrowserViewportCoordinator(
      { ...FALLBACK_POINTS, mobile: this.mobile },
      async () => undefined
    )
    this.statusNow = { state: 'connecting', message: null, use: opts.device.target.use, input: this.inputAllowed() }
  }

  get status(): UseStatus {
    return this.statusNow
  }

  private get mobile(): boolean {
    return this.opts.device.target.use === 'phone'
  }

  private mapperFor(points: ScreenPoints): VphoneGestureMapper {
    return new VphoneGestureMapper(this.now, points, { wheelAsScroll: this.opts.device.target.use === 'computer' })
  }

  private inputAllowed(): boolean {
    return this.opts.device.perform !== undefined && (this.opts.device.inputRefusal?.() ?? null) === null
  }

  /** Never throws for an unavailable device: the card opens offline and recovers by itself. */
  async start(): Promise<void> {
    if (this.closed) throw new Error('this card is closed')
    if (this.polling || this.cancel !== null || this.opened) return
    await this.tick()
  }

  // MARK: frames

  private schedule(ms: number): void {
    if (this.closed) return
    this.cancel?.()
    this.cancel = this.scheduleFn(() => {
      this.cancel = null
      void this.tick()
    }, ms)
  }

  private cadence(): number {
    if (this.failures > 0) {
      return Math.min(PIXEL_MAX_BACKOFF_MS, PIXEL_IDLE_POLL_MS * 2 ** Math.min(this.failures - 1, 6))
    }
    if (this.now() - this.lastInputAt < PIXEL_FAST_WINDOW_MS) return PIXEL_FAST_POLL_MS
    return this.frameListeners.size === 0 ? PIXEL_UNWATCHED_POLL_MS : PIXEL_IDLE_POLL_MS
  }

  private async tick(): Promise<void> {
    if (this.closed) return
    if (this.polling) {
      this.pollAgainSoon = true
      return
    }
    this.polling = true
    try {
      if (!this.opened) {
        this.adoptPoints(await withDeadline(this.opts.device.open(), PIXEL_OPEN_TIMEOUT_MS, 'the device'))
        this.opened = true
      }
      const frame = await withDeadline(this.opts.device.capture(), PIXEL_CAPTURE_TIMEOUT_MS, 'the device')
      if (frame.points) this.adoptPoints(frame.points)
      this.failures = 0
      this.setStatus('live', null)
      const changed = frame.jpeg !== this.latest
      const due = this.now() - this.lastEmitAt >= PIXEL_HEARTBEAT_MS
      this.latest = frame.jpeg
      if (changed || due) this.emit(frame.jpeg)
    } catch (error) {
      this.failures += 1
      // A device that failed after opening may come back a different size
      // (another phone on the cable, the window reopened): open it again.
      this.opened = false
      this.setStatus('offline', error instanceof Error ? error.message : String(error))
    } finally {
      this.polling = false
    }
    const soon = this.pollAgainSoon && this.failures === 0
    this.pollAgainSoon = false
    this.schedule(soon ? PIXEL_FAST_POLL_MS : this.cadence())
  }

  private adoptPoints(points: ScreenPoints): void {
    if (!(points.width > 0 && points.height > 0)) return
    if (points.width === this.points.width && points.height === this.points.height) return
    this.points = { width: Math.round(points.width), height: Math.round(points.height) }
    this.mapper = this.mapperFor(this.points)
    this.viewportCoordinator.setDefault({ ...this.points, mobile: this.mobile })
  }

  private setStatus(state: UseStatus['state'], message: string | null): void {
    const input = this.inputAllowed()
    const prev = this.statusNow
    if (prev.state === state && prev.message === message && prev.input === input) return
    this.statusNow = { state, message, use: this.opts.device.target.use, input }
    for (const listener of this.statusListeners) {
      try {
        listener(this.statusNow)
      } catch {
        // A viewer's listener never stops the device.
      }
    }
  }

  private emit(jpeg: string): void {
    this.lastEmitAt = this.now()
    const meta: FrameMeta = {
      deviceWidth: this.points.width,
      deviceHeight: this.points.height,
      pageScaleFactor: 1,
      mobile: this.mobile,
      revision: this.viewportCoordinator.state.revision
    }
    for (const listener of this.frameListeners) listener(jpeg, meta)
  }

  // MARK: input

  dispatchInput(method: CdpInputCommand['method'], params: CdpInputCommand['params']): void {
    if (this.closed || !this.inputAllowed()) return
    const gestures = this.mapper.map({ method, params } as CdpInputCommand)
    if (gestures.length === 0) return
    this.perform(gestures)
  }

  /**
   * The agent's path: gestures already in points (headless-browser-command).
   * Resolves once the device has taken them, so `cookrew browser tap` can say
   * it happened; a refused gesture is a thrown sentence.
   */
  async act(gestures: readonly Gesture[]): Promise<void> {
    if (this.closed) throw new Error('this card is closed')
    const refusal = this.opts.device.inputRefusal?.() ?? null
    if (refusal) throw new Error(refusal)
    if (!this.opts.device.perform) throw new Error(`a ${this.opts.device.target.use} camera is watched, not driven`)
    if (!this.opened) throw new Error(this.statusNow.message ?? 'the device is not connected yet')
    await this.perform(gestures, true)
  }

  private perform(gestures: readonly Gesture[], surface = false): Promise<void> {
    const device = this.opts.device
    if (!device.perform) return Promise.resolve()
    this.lastInputAt = this.now()
    let failure: unknown = null
    // Serialised: a tap must never overtake the swipe before it. Called ON
    // the device: a class's perform reads its own fields (adb's serial).
    for (const gesture of gestures) {
      this.inputQueue = this.inputQueue.then(() => device.perform?.(gesture)).then(
        () => undefined,
        (error: unknown) => {
          failure = failure ?? error
        }
      )
    }
    this.schedule(PIXEL_FAST_POLL_MS)
    return this.inputQueue.then(() => {
      if (surface && failure !== null) throw failure instanceof Error ? failure : new Error(String(failure))
    })
  }

  // MARK: the BrowserInstance contract

  async syncTabs(_tabs: BrowserTab[], _activeTabId: string): Promise<void> {
    // One screen; tabs are the card's, not the device's.
  }

  async resize(_width: number, _height: number): Promise<void> {
    // The screen is the device's; the card scales the frame to fit.
  }

  async snapshot(): Promise<string | null> {
    return this.latest
  }

  async evaluate(_expression: string): Promise<unknown> {
    throw new Error(`'${this.opts.url}' is a screen, not a web page — script cannot run there; use tap, type, key, scroll and screenshot`)
  }

  async navigate(url: string): Promise<void> {
    if (!this.opts.device.navigate) {
      throw new Error(`'${this.opts.url}' cannot open addresses; create another card for '${url}'`)
    }
    await this.opts.device.navigate(url)
    this.schedule(PIXEL_FAST_POLL_MS)
  }

  async pageInfo(): Promise<HeadlessPageState & { viewport: string }> {
    return {
      url: this.opts.url,
      title: this.opts.device.title?.() ?? this.opts.url,
      viewport: `${this.points.width}x${this.points.height}`
    }
  }

  registerViewportViewer(id: string): void {
    this.viewportCoordinator.registerViewer(id)
    // A viewer arrived at a card that was idling unwatched: a frame now.
    if (!this.closed && !this.polling) this.schedule(PIXEL_FAST_POLL_MS)
  }

  offerViewport(id: string, metrics: ViewportMetrics): void {
    this.viewportCoordinator.offer(id, metrics)
  }

  claimViewport(_id: string, _metrics: ViewportMetrics): boolean {
    // Nobody reshapes a device's screen: the viewer fits the frame.
    return false
  }

  releaseViewport(id: string): void {
    this.viewportCoordinator.release(id)
  }

  unregisterViewportViewer(id: string): void {
    this.viewportCoordinator.unregisterViewer(id)
  }

  onViewportState(listener: (state: BrowserViewportState) => void): () => void {
    return this.viewportCoordinator.onState(listener)
  }

  beginAgentViewportActivity(): Promise<() => void> {
    return this.viewportCoordinator.beginAgentActivity()
  }

  get viewport(): { width: number; height: number } {
    return { ...this.points }
  }

  get viewportState(): BrowserViewportState {
    return this.viewportCoordinator.state
  }

  get processId(): number | null {
    return null
  }

  async stop(): Promise<HeadlessStopResult> {
    if (this.closed) return { pid: null, forced: false }
    this.closed = true
    this.cancel?.()
    this.cancel = null
    this.viewportCoordinator.dispose()
    this.statusListeners.clear()
    try {
      await this.opts.device.close?.()
    } catch {
      // Closing a device that already went away is not a failure.
    }
    return { pid: null, forced: false }
  }
}
