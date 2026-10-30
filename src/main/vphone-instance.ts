import type { CdpInputCommand } from '../shared/cast-input'
import type { ViewportMetrics } from '../shared/cast-viewport'
import type { BrowserTab } from '../shared/model'
import { parseVphoneUrl, vphoneUrl } from '../shared/vphone-url'
import { BrowserViewportCoordinator, type BrowserViewportState } from './browser-viewport'
import type { FrameMeta, HeadlessPageState, HeadlessStopResult } from './headless-chrome'
import { VphoneGestureMapper, WHEEL_SWIPE_SECONDS, type Gesture } from './vphone-input'
import type { VphoneGuest } from './vphone-socket'

/**
 * A VIRTUAL iPHONE AS A BROWSER INSTANCE.
 *
 * The interactive browser card is three parts: an instance that produces
 * JPEG frames and takes a closed vocabulary of input, a WebSocket fan-out
 * (browser-cast.ts), and a renderer that draws frames and sends gestures.
 * Only the first part knows it is talking to Chrome. This is the same part
 * for a vphone-cli guest: frames come from vphoned's `screen.screenshot`,
 * polled fast after input and slowly when nothing is happening, and input
 * goes through vphoned's touch injection (vphone-input.ts). The cast and
 * the renderer are untouched — a phone card streams to the desktop and to
 * the owner's phone exactly like a web card.
 *
 * WHAT IT IS NOT: a page. There is no DOM to evaluate, no tabs to sync, no
 * viewport to reshape — the screen is the phone's. Those calls answer
 * honestly (a thrown sentence, a no-op, the phone's own size) rather than
 * pretending.
 *
 * LIFECYCLE: the VM is the user's. `start()` refuses when the machine is not
 * running and says how to launch it; `stop()` only stops polling and never
 * stops the VM.
 */

export const VPHONE_FAST_POLL_MS = 150
/**
 * The idle cadence, with the heartbeat below it. A viewer calls a frame
 * stale after 1200 ms (renderer FRAME_STALE_MS), and the gap between two
 * emits is one idle poll PLUS the screenshot round trip, so the poll is
 * kept at 800 ms to leave 400 ms for a 1290×2796 JPEG to cross the socket.
 */
export const VPHONE_IDLE_POLL_MS = 800
/** How long after an input the fast cadence lasts. */
export const VPHONE_FAST_WINDOW_MS = 3000
/** An unchanged frame is re-sent once this much time has passed since the last emit. */
export const VPHONE_HEARTBEAT_MS = 700
/** Consecutive screenshot failures before the instance reports itself gone. */
export const VPHONE_EXIT_AFTER_FAILURES = 5
/** The size vphone guests have reported so far (iPhone 17,3 at 3x), used when the guest will not say. */
const FALLBACK_POINTS = { width: 430, height: 932 }

export interface VphoneInstanceOptions {
  readonly machine: string
  readonly guest: VphoneGuest
  readonly now?: () => number
}

interface Points {
  readonly width: number
  readonly height: number
}

export class VphoneInstance {
  readonly frameListeners = new Set<(jpegBase64: string, meta: FrameMeta) => void>()
  onExit: () => void = () => undefined
  onPageState: (tabId: string, state: HeadlessPageState) => void = () => undefined
  onTabOpened: (tab: BrowserTab) => void = () => undefined
  onTabClosed: (tabId: string) => void = () => undefined

  private readonly now: () => number
  private readonly viewportCoordinator: BrowserViewportCoordinator
  private mapper: VphoneGestureMapper
  private points: Points = FALLBACK_POINTS
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private started = false
  private polling = false
  private latest: string | null = null
  private lastEmitAt = 0
  private lastInputAt = Number.NEGATIVE_INFINITY
  private failures = 0
  /** An input arrived while a poll was in flight: look again as soon as it lands. */
  private pollAgainSoon = false
  private inputQueue: Promise<void> = Promise.resolve()

  constructor(private readonly opts: VphoneInstanceOptions) {
    this.now = opts.now ?? Date.now
    this.mapper = new VphoneGestureMapper(this.now, this.points)
    this.viewportCoordinator = new BrowserViewportCoordinator(
      { ...FALLBACK_POINTS, mobile: true },
      async () => undefined
    )
  }

  get machine(): string {
    return this.opts.machine
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('vphone instance is closed')
    if (this.started) return
    if (!(await this.opts.guest.ping())) {
      throw new Error(
        `vphone machine '${this.opts.machine}' is not running — start it with: vphone-cli vm launch ${this.opts.machine}`
      )
    }
    this.points = await this.readPoints()
    this.mapper = new VphoneGestureMapper(this.now, this.points)
    this.viewportCoordinator.setDefault({ ...this.points, mobile: true })
    this.started = true
    this.schedule(VPHONE_IDLE_POLL_MS)
  }

  /**
   * The screen in points, which is what vphoned's gestures take. `device.screen`
   * may answer in points with a scale, or in pixels; either way the answer is
   * normalised, and a guest that will not say gets the size every vphone has
   * had so far.
   */
  private async readPoints(): Promise<Points> {
    let answer: Record<string, unknown> = {}
    try {
      const raw = await this.opts.guest.rpc('device.screen', {})
      if (typeof raw === 'object' && raw !== null) answer = raw as Record<string, unknown>
    } catch {
      return FALLBACK_POINTS
    }
    const width = numberOf(answer.width)
    const height = numberOf(answer.height)
    if (width === null || height === null || width <= 0 || height <= 0) return FALLBACK_POINTS
    const scale = numberOf(answer.scale)
    // Pixels are the only way a phone screen is wider than 700; a scale with
    // a point-sized width is already points.
    const pixels = width > 700
    const divisor = pixels ? (scale && scale > 1 ? scale : 3) : 1
    return { width: Math.round(width / divisor), height: Math.round(height / divisor) }
  }

  // MARK: frames

  private schedule(ms: number): void {
    if (this.closed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.poll(), ms)
  }

  private cadence(): number {
    return this.now() - this.lastInputAt < VPHONE_FAST_WINDOW_MS ? VPHONE_FAST_POLL_MS : VPHONE_IDLE_POLL_MS
  }

  private async poll(): Promise<void> {
    if (this.closed) return
    if (this.polling) {
      this.pollAgainSoon = true
      return
    }
    this.polling = true
    try {
      const shot = await this.opts.guest.rpc('screen.screenshot', {})
      const jpeg = jpegOf(shot)
      if (jpeg === null) throw new Error('screenshot carried no image')
      this.failures = 0
      const changed = jpeg !== this.latest
      const due = this.now() - this.lastEmitAt >= VPHONE_HEARTBEAT_MS
      this.latest = jpeg
      if (changed || due) this.emit(jpeg)
    } catch {
      this.failures += 1
      if (this.failures >= VPHONE_EXIT_AFTER_FAILURES && !this.closed) {
        this.closed = true
        this.onExit()
        return
      }
    } finally {
      this.polling = false
    }
    const soon = this.pollAgainSoon
    this.pollAgainSoon = false
    this.schedule(soon ? VPHONE_FAST_POLL_MS : this.cadence())
  }

  private emit(jpeg: string): void {
    this.lastEmitAt = this.now()
    const meta: FrameMeta = {
      deviceWidth: this.points.width,
      deviceHeight: this.points.height,
      pageScaleFactor: 1,
      mobile: true,
      revision: this.viewportCoordinator.state.revision
    }
    for (const listener of this.frameListeners) listener(jpeg, meta)
  }

  // MARK: the HeadlessInstance contract

  async syncTabs(_tabs: BrowserTab[], _activeTabId: string): Promise<void> {
    // The phone has one screen; tabs are the card's, not the guest's.
  }

  async resize(_width: number, _height: number): Promise<void> {
    // The screen is the phone's; the card scales the frame to fit.
  }

  async snapshot(): Promise<string | null> {
    return this.latest
  }

  async evaluate(_expression: string): Promise<unknown> {
    throw new Error(`'${this.opts.machine}' is a phone, not a web page — script cannot run there`)
  }

  /**
   * A web address opens in Safari; `vphone://<this machine>/<bundle id>`
   * brings that app to the front. Anything else is refused in words.
   */
  async navigate(url: string): Promise<void> {
    const target = parseVphoneUrl(url)
    if (target) {
      if (target.machine !== this.opts.machine) {
        throw new Error(`This card is '${this.opts.machine}', not '${target.machine}'; create another card for that machine`)
      }
      if (target.app) await this.opts.guest.rpc('apps.launch', { bundle_id: target.app })
      return
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('Only http(s) addresses and vphone://<machine>/<bundle id> can be opened on a phone')
    }
    await this.opts.guest.rpc('apps.open_url', { url })
  }

  async pageInfo(): Promise<HeadlessPageState & { viewport: string }> {
    let bundle = ''
    let name = ''
    try {
      const front = await this.opts.guest.rpc('apps.foreground', {})
      if (typeof front === 'object' && front !== null) {
        const record = front as Record<string, unknown>
        bundle = typeof record.bundle_id === 'string' ? record.bundle_id : ''
        name = typeof record.name === 'string' ? record.name : ''
      }
    } catch {
      // The front app is a nicety; the card still has a page.
    }
    return {
      url: vphoneUrl(this.opts.machine, bundle || null),
      title: name || bundle || this.opts.machine,
      viewport: `${this.points.width}x${this.points.height}`
    }
  }

  registerViewportViewer(id: string): void {
    this.viewportCoordinator.registerViewer(id)
  }

  offerViewport(id: string, metrics: ViewportMetrics): void {
    this.viewportCoordinator.offer(id, metrics)
  }

  claimViewport(_id: string, _metrics: ViewportMetrics): boolean {
    // Nobody reshapes a phone. The claim is declined so the viewer keeps
    // fitting the frame instead of waiting for a reflow that never comes.
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

  dispatchInput(method: CdpInputCommand['method'], params: CdpInputCommand['params']): void {
    if (this.closed || !this.started) return
    const calls = this.mapper.map({ method, params })
    if (calls.length === 0) return
    this.lastInputAt = this.now()
    // Serialised: vphoned keeps the order of what it receives in order, and a
    // tap must not overtake the swipe before it. A refused call is dropped;
    // the next frame shows what happened.
    for (const call of calls) {
      this.inputQueue = this.inputQueue
        .then(() => this.opts.guest.rpc(call.method, call.params))
        .then(() => undefined, () => undefined)
    }
    // Look again soon: the screen is about to change.
    this.schedule(VPHONE_FAST_POLL_MS)
  }

  /**
   * The agent's hand (use-commands.ts): the gestures go to vphoned in order
   * and the promise says whether it took them. A phone has no wheel, so a
   * scroll is the swipe of its delta.
   */
  async act(gestures: readonly Gesture[]): Promise<void> {
    if (this.closed || !this.started) throw new Error(`vphone machine '${this.opts.machine}' is not connected`)
    this.lastInputAt = this.now()
    for (const gesture of gestures) {
      if (gesture.method === 'input.scroll') {
        const x = Number(gesture.params.x)
        const y = Number(gesture.params.y)
        const toY = Math.min(Math.max(y - Number(gesture.params.dy), 0), this.points.height)
        await this.opts.guest.rpc('input.swipe', { x1: x, y1: y, x2: x, y2: toY, seconds: WHEEL_SWIPE_SECONDS })
      } else {
        await this.opts.guest.rpc(gesture.method, gesture.params)
      }
    }
    this.schedule(VPHONE_FAST_POLL_MS)
  }

  get viewport(): { width: number; height: number } {
    return { ...this.points }
  }

  get viewportState(): BrowserViewportState {
    return this.viewportCoordinator.state
  }

  get devToolsPort(): number {
    return 0
  }

  get processId(): number | null {
    return null
  }

  async stop(): Promise<HeadlessStopResult> {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.viewportCoordinator.dispose()
    return { pid: null, forced: false }
  }
}

const numberOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** The base64 JPEG out of a screenshot reply, under whichever key the guest used. */
const jpegOf = (shot: unknown): string | null => {
  if (typeof shot === 'string' && shot.length > 0) return shot
  if (typeof shot !== 'object' || shot === null) return null
  const record = shot as Record<string, unknown>
  for (const key of ['data', 'image', 'jpeg', 'base64']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}
