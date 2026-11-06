import type { CdpInputCommand } from '../shared/cast-input'
import type { ViewportMetrics } from '../shared/cast-viewport'
import type { BrowserTab } from '../shared/model'
import { remoteView, type CardControl, type RemoteState, type ViewerWho } from '../shared/remote-access'
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
 *   REST. A computer's screen holds whatever the owner has open, so with no viewer
 *   it is not read at all: an agent's look takes one frame, and a card left alone for
 *   PIXEL_SESSION_IDLE_MS ends its session and holds no picture. The next use
 *   reconnects, and the first hand after that needs a look first, because the screen
 *   may have moved on: a message typed from an old picture goes to the wrong chat.
 *   Phones and cameras keep slow frames: their thumbnail is read from them.
 *
 *   HONESTY. There is no page: evaluate refuses in words, tabs and resize are
 *   no-ops, the screen is the device's size.
 */

export const PIXEL_FAST_POLL_MS = 150
export const PIXEL_IDLE_POLL_MS = 800
export const PIXEL_FAST_WINDOW_MS = 3000
export const PIXEL_HEARTBEAT_MS = 700
/**
 * A phone or camera nobody watches: one frame every few seconds, enough for the
 * card's thumbnail, instead of an adb round trip every 800 ms. A viewer arriving
 * wakes it at once (registerViewportViewer). A computer's screen takes none.
 */
export const PIXEL_UNWATCHED_POLL_MS = 5000
/**
 * How long a computer card outlives its last use. An agent between two steps is
 * usually thinking, and reconnecting is cheap, so this only has to outlast a pause.
 */
export const PIXEL_SESSION_IDLE_MS = 60_000
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
/**
 * A device gone for good is looked at about once a minute, not at the offline
 * backoff: each look is a helper process, and a closed window's card can sit
 * in a workspace for days. A viewer arriving looks at once.
 */
export const PIXEL_GONE_POLL_MS = 60_000

/** What a card was bound to no longer exists, as opposed to not answering right now. */
export class DeviceGoneError extends Error {
  constructor(
    readonly gone: NonNullable<UseStatus['gone']>,
    message: string
  ) {
    super(message)
    this.name = 'DeviceGoneError'
  }
}

/** The screen cannot be read right now, for a reason the card should say in full. */
export class DeviceBlockedError extends Error {
  constructor(readonly state: RemoteState) {
    const view = remoteView(state, 'here')
    // What `cookrew browser status` prints, so it stands alone: the title carries the state.
    super(`${view.title}. ${view.sentence}`)
    this.name = 'DeviceBlockedError'
  }
}

/** The remote desk as one card sees it (remote-desk.ts · remoteGate). */
export interface RemoteGate {
  /** What stands in the way of reading the screen; null when nothing does. */
  blocked(options?: { afterFailure?: boolean }): Promise<RemoteState | null>
  /** Why nothing may drive this machine. */
  inputRefusal(): string | null
  /** Why an agent's hand may not, which Stop also holds. */
  agentRefusal(): string | null
  /** This viewer holds control of this card, right now. */
  mayDrive(who: ViewerWho): boolean
  cardControl(who: ViewerWho): CardControl
  /** Why this viewer may not watch; null when it may. */
  admit(who: ViewerWho): { readonly message: string; readonly state: RemoteState } | null
  /** A viewer arrived; the answer is its leaving. */
  enter(viewerId: string, who: ViewerWho): () => void
}

export function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
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
  /** A computer's screen: every viewer and every input goes through this. Absent on phones and cameras. */
  readonly remote?: RemoteGate
  /** What the machine's clipboard holds, read after a viewer's own copy chord. */
  readClipboard?: () => string
  /** The session ended: forget where things were. */
  rest?: () => void
}

export interface PixelInstanceOptions {
  readonly url: string
  readonly device: PixelDevice
  readonly now?: () => number
  readonly schedule?: (fn: () => void, ms: number) => () => void
  /** How long a copy chord gets to land in the clipboard. */
  readonly copyDelayMs?: number
  /** The card went blind: nothing it showed before may stand in for now. */
  readonly onBlocked?: () => void
  /** The session ended: what it held open can go. */
  readonly onRest?: () => void
}

/** Who is asking when an agent reads a screen: never at the Mac, so Stop and a served workspace reach it. */
const AGENT_VIEWER: ViewerWho = { key: 'agent', name: 'An agent', here: false }
const COPY_DELAY_MS = 200
const RESTING = 'Nothing is being captured; the next use reconnects'
const LOOK_FIRST = 'This card has no session: take a screenshot first, the screen may have changed'
/** The most a copy carries to a viewer: a clipboard can hold a whole file. */
const MAX_COPY_CHARS = 64 * 1024

const FALLBACK_POINTS: ScreenPoints = { width: 800, height: 600 }

const sameRemote = (a: RemoteState | undefined, b: RemoteState | undefined): boolean =>
  a?.id === b?.id && a?.then === b?.then && a?.detail === b?.detail && a?.waiting === b?.waiting && a?.until === b?.until

const isCopyChord = (gesture: Gesture): boolean =>
  gesture.method === 'input.key' && gesture.params.mods === 'cmd' && (gesture.params.name === 'c' || gesture.params.name === 'x')

export class PixelInstance {
  readonly frameListeners = new Set<(jpegBase64: string, meta: FrameMeta) => void>()
  readonly statusListeners = new Set<(status: UseStatus) => void>()
  readonly copyListeners = new Set<(text: string) => void>()
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
  private ticking: Promise<void> | null = null
  private readonly viewers = new Set<string>()
  private restCancel: (() => void) | null = null
  /** Gestures on their way: a session never ends under a hand. */
  private acting = 0
  private latest: string | null = null
  private lastEmitAt = 0
  private lastFrameAt: number | null = null
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
    const computer = this.opts.device.target.use === 'computer'
    return new VphoneGestureMapper(this.now, points, { wheelAsScroll: computer, chords: computer })
  }

  private inputAllowed(): boolean {
    return this.opts.device.perform !== undefined && (this.opts.device.inputRefusal?.() ?? null) === null
  }

  /** A computer's screen: read only for a viewer or a look. */
  get rests(): boolean {
    return this.opts.device.remote !== undefined
  }

  get resting(): boolean {
    return this.statusNow.state === 'resting'
  }

  private get watched(): boolean {
    return this.viewers.size > 0 || this.frameListeners.size > 0
  }

  private get keepsLooking(): boolean {
    return !this.rests || this.watched
  }

  /** Never throws for an unavailable device: the card opens offline and recovers by itself. */
  async start(): Promise<void> {
    if (this.closed) throw new Error('this card is closed')
    if (this.polling || this.cancel !== null || this.opened) return
    if (!this.keepsLooking) return this.setStatus('resting', RESTING)
    await this.tick()
  }

  // MARK: frames

  private schedule(ms: number): void {
    if (this.closed || !this.keepsLooking) return
    this.cancel?.()
    this.cancel = this.scheduleFn(() => {
      this.cancel = null
      void this.tick()
    }, ms)
  }

  private cadence(): number {
    if (this.statusNow.gone) return PIXEL_GONE_POLL_MS
    if (this.failures > 0) {
      return Math.min(PIXEL_MAX_BACKOFF_MS, PIXEL_IDLE_POLL_MS * 2 ** Math.min(this.failures - 1, 6))
    }
    if (this.now() - this.lastInputAt < PIXEL_FAST_WINDOW_MS) return PIXEL_FAST_POLL_MS
    return this.frameListeners.size === 0 ? PIXEL_UNWATCHED_POLL_MS : PIXEL_IDLE_POLL_MS
  }

  private tick(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.ticking) {
      this.pollAgainSoon = true
      return this.ticking
    }
    this.ticking = this.poll().finally(() => {
      this.ticking = null
    })
    return this.ticking
  }

  private async poll(): Promise<void> {
    this.polling = true
    try {
      if (!this.opened) {
        this.adoptPoints(await withDeadline(this.opts.device.open(), PIXEL_OPEN_TIMEOUT_MS, 'the device'))
        this.opened = true
      }
      const frame = await withDeadline(this.opts.device.capture(), PIXEL_CAPTURE_TIMEOUT_MS, 'the device')
      if (frame.points) this.adoptPoints(frame.points)
      this.failures = 0
      this.lastFrameAt = this.now()
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
      const remote = error instanceof DeviceBlockedError ? { ...error.state, lastSeenAt: this.lastFrameAt } : undefined
      // Never a stale picture standing in for a screen that cannot be read.
      if (remote) this.blind()
      this.setStatus('offline', error instanceof Error ? error.message : String(error), error instanceof DeviceGoneError ? error.gone : undefined, remote)
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

  private blind(): void {
    this.latest = null
    this.opts.onBlocked?.()
  }

  private setStatus(state: UseStatus['state'], message: string | null, gone?: UseStatus['gone'], remote?: RemoteState): void {
    const input = this.inputAllowed()
    const prev = this.statusNow
    if (prev.state === state && prev.message === message && prev.input === input && prev.gone === gone && sameRemote(prev.remote, remote)) return
    this.statusNow = { state, message, use: this.opts.device.target.use, input, ...(gone ? { gone } : {}), ...(remote ? { remote } : {}) }
    this.tellStatus()
  }

  private tellStatus(): void {
    for (const listener of this.statusListeners) {
      try {
        listener(this.statusNow)
      } catch {
        // A viewer's listener never stops the device.
      }
    }
  }

  /** Something the viewers read changed outside the device: a grant, the machine switch. */
  refreshStatus(): void {
    if (this.closed) return
    this.statusNow = { ...this.statusNow, input: this.inputAllowed() }
    this.tellStatus()
  }

  /** Counts as a use: the session lasts this long past it. */
  private armRest(): void {
    if (this.closed || !this.rests || this.watched) return
    this.restCancel?.()
    this.restCancel = this.scheduleFn(() => {
      this.restCancel = null
      this.rest()
    }, PIXEL_SESSION_IDLE_MS)
  }

  private rest(): void {
    if (this.closed || this.watched || this.resting) return
    if (this.ticking || this.acting > 0) return this.armRest()
    this.opened = false
    this.failures = 0
    this.blind()
    this.opts.device.rest?.()
    this.setStatus('resting', RESTING)
    this.opts.onRest?.()
  }

  /** True when it was resting. */
  private wakeFromRest(): boolean {
    this.restCancel?.()
    this.restCancel = null
    if (!this.resting) return false
    this.setStatus('connecting', null)
    return true
  }

  /** The lock lifted, or something else this card was waiting for: look now, not at the next backoff. */
  wake(): void {
    if (!this.closed && !this.polling) this.schedule(PIXEL_FAST_POLL_MS)
  }

  /** This viewer's own reading of a status: who may drive is not the same for everyone. */
  statusFor(status: UseStatus, who: ViewerWho): UseStatus {
    const remote = this.opts.device.remote
    if (!remote) return status
    return { ...status, input: status.input && remote.mayDrive(who), control: remote.cardControl(who) }
  }

  mayDrive(who: ViewerWho): boolean {
    return this.opts.device.remote?.mayDrive(who) ?? true
  }

  /** The status a viewer who may not watch is left with; null when it may. */
  refusalFor(who: ViewerWho): UseStatus | null {
    const refusal = this.opts.device.remote?.admit(who) ?? null
    if (!refusal) return null
    return { state: 'offline', message: refusal.message, use: this.opts.device.target.use, input: false, remote: refusal.state }
  }

  enterViewer(viewerId: string, who: ViewerWho): (() => void) | null {
    return this.opts.device.remote?.enter(viewerId, who) ?? null
  }

  /** Input here needs a viewer with a name: a route with none is refused, not ignored. */
  get needsViewer(): boolean {
    return this.opts.device.remote !== undefined
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

  dispatchInput(method: CdpInputCommand['method'], params: CdpInputCommand['params'], who?: ViewerWho): void {
    if (this.closed || !this.inputAllowed()) return
    const remote = this.opts.device.remote
    // The last gate, so every route is behind it: a viewer holding control, on
    // a screen that is live. A caller with no name for its viewer gets nothing.
    if (remote && (who === undefined || !remote.mayDrive(who) || this.statusNow.state !== 'live')) return
    const gestures = this.mapper.map({ method, params } as CdpInputCommand)
    if (gestures.length === 0) return
    // Asked again per gesture: a queue can outlast the grant that filled it.
    this.perform(gestures, false, remote && who ? () => remote.mayDrive(who) : undefined)
    if (gestures.some(isCopyChord)) this.readCopyLater()
  }

  /** The chord went to the machine; what it copied is in the machine's clipboard a moment later. */
  private readCopyLater(): void {
    const read = this.opts.device.readClipboard
    if (!read) return
    const heard = (): void => {
      const text = this.closed ? '' : read().slice(0, MAX_COPY_CHARS)
      if (text.length === 0) return
      for (const listener of this.copyListeners) listener(text)
    }
    const after = this.opts.copyDelayMs ?? COPY_DELAY_MS
    void this.inputQueue.then(() => setTimeout(heard, after))
  }

  /**
   * The agent's path: gestures already in points (headless-browser-command).
   * Resolves once the device has taken them, so `cookrew browser tap` can say
   * it happened; a refused gesture is a thrown sentence.
   */
  async act(gestures: readonly Gesture[]): Promise<void> {
    if (this.closed) throw new Error('this card is closed')
    const refusal = this.opts.device.inputRefusal?.() ?? this.opts.device.remote?.agentRefusal() ?? null
    if (refusal) throw new Error(refusal)
    if (!this.opts.device.perform) throw new Error(`a ${this.opts.device.target.use} camera is watched, not driven`)
    if (this.resting) throw new Error(LOOK_FIRST)
    if (!this.opened) throw new Error(this.statusNow.message ?? 'the device is not connected yet')
    this.acting += 1
    this.armRest()
    try {
      // Stop can land while these wait their turn behind each other.
      await this.perform(gestures, true, () => (this.opts.device.remote?.agentRefusal() ?? null) === null)
    } finally {
      this.acting -= 1
      this.armRest()
    }
  }

  private perform(gestures: readonly Gesture[], surface = false, stillAllowed?: () => boolean): Promise<void> {
    const device = this.opts.device
    if (!device.perform) return Promise.resolve()
    this.lastInputAt = this.now()
    let failure: unknown = null
    // Serialised: a tap must never overtake the swipe before it. Called ON
    // the device: a class's perform reads its own fields (adb's serial).
    for (const gesture of gestures) {
      this.inputQueue = this.inputQueue.then(() => (stillAllowed && !stillAllowed() ? undefined : device.perform?.(gesture))).then(
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

  /** What is held, and never a capture: thumbnails poll this. */
  async snapshot(): Promise<string | null> {
    return this.opts.device.remote?.admit(AGENT_VIEWER) ? null : this.latest
  }

  /** The screen as it is now, for an agent. Null with the status saying why. */
  async look(): Promise<string | null> {
    if (this.closed || this.opts.device.remote?.admit(AGENT_VIEWER)) return null
    if (this.keepsLooking) return this.latest
    this.wakeFromRest()
    try {
      if (this.ticking) await this.ticking
      await this.tick()
    } finally {
      this.armRest()
    }
    // An old picture never answers for a screen that could not be read.
    return this.statusNow.state === 'live' ? this.latest : null
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
    this.viewers.add(id)
    const rested = this.wakeFromRest()
    this.viewportCoordinator.registerViewer(id)
    // A viewer arrived at a card that was idling unwatched: a frame now.
    if (rested) void this.tick()
    else if (!this.closed && !this.polling) this.schedule(PIXEL_FAST_POLL_MS)
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
    this.viewers.delete(id)
    this.viewportCoordinator.unregisterViewer(id)
    if (this.keepsLooking) return
    this.cancel?.()
    this.cancel = null
    this.armRest()
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

  get stopped(): boolean {
    return this.closed
  }

  async stop(): Promise<HeadlessStopResult> {
    if (this.closed) return { pid: null, forced: false }
    this.closed = true
    this.cancel?.()
    this.cancel = null
    this.restCancel?.()
    this.restCancel = null
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
