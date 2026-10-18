// The phone's link to the desktop, and how it comes back.
//
// Everything on a remote canvas arrives over ONE EventSource: the workspace
// state, the workspace list, activity. It was created once and never looked
// at again — "EventSource reconnects on its own" is true only for failures the
// browser considers retryable. A stream that dies with readyState CLOSED (an
// error status through the tailnet, the desktop app restarting, iOS reaping a
// backgrounded page's connections) stays dead, and nothing else in the client
// ever asks for state again.
//
// That is how a phone ends up looking at an empty canvas holding a workspace
// that is full on the desktop: the initial fetch missed and the one channel
// that would have corrected it was gone. Reloading fixed it because a reload
// rebuilds both.
//
// So the stream heals itself: it reconnects on a fatal error with a backoff,
// and it can be revived on demand — when the page comes back to the
// foreground, when the network returns, or when the user asks.

export interface EventStreamLike {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void
  removeEventListener(type: string, listener: (event: MessageEvent) => void): void
  close(): void
  readonly readyState: number
}

/** EventSource.readyState values, named (the constants live on the class). */
export const STREAM_CONNECTING = 0
export const STREAM_OPEN = 1
export const STREAM_CLOSED = 2

export interface ReconnectingStreamDeps {
  open: () => EventStreamLike
  /**
   * Told whenever the link's state changes, so something outside can SHOW it.
   * This stream used to keep its health entirely to itself — `alive` was read
   * nowhere — which is why the phone could sit on a dead channel with nothing
   * on screen saying so.
   */
  onState?: (state: 'live' | 'reconnecting' | 'failed') => void
  /** Timer injection, so the backoff is testable without waiting it out. */
  schedule?: (run: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
  /** Delay before each successive retry; the last value repeats. */
  backoffMs?: readonly number[]
  /**
   * A restart onto a new plane could not open its stream there, while the
   * old one is still carrying the session. Evidence about the NEW plane
   * (plane-health.ts counts it), never a reason to show the link as down.
   */
  onSwitchFailed?: () => void
}

// Capped at 8 s: a phone that changed networks pays at most that before its
// stream is back, and a successful request revives a waiting stream at once
// (plane-streams.ts · reviveStreams).
const DEFAULT_BACKOFF = [1000, 2000, 4000, 8000, 8000] as const

type Listener = (event: MessageEvent) => void

/**
 * One event stream that outlives its connections. Subscribers register with
 * `on()` once and keep receiving events across every reconnect — they never
 * see the socket underneath change.
 */
export class ReconnectingStream {
  private source: EventStreamLike | null = null
  /** The stream opening on a new plane while the old one still carries the session. */
  private pending: EventStreamLike | null = null
  private pendingRetry = 0
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly onError: Listener
  private readonly onOpen: Listener
  private retry = 0
  private timer: unknown = null
  private closed = false
  private readonly schedule: (run: () => void, ms: number) => unknown
  private readonly cancel: (handle: unknown) => void
  private readonly backoff: readonly number[]

  constructor(private readonly deps: ReconnectingStreamDeps) {
    this.schedule = deps.schedule ?? ((run, ms) => setTimeout(run, ms))
    this.cancel = deps.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.backoff = deps.backoffMs ?? DEFAULT_BACKOFF
    // A browser that is retrying by itself (CONNECTING) is left alone —
    // racing it would open a second stream for the same client.
    this.onError = () => {
      if (this.source && this.source.readyState === STREAM_CLOSED) {
        // Down and coming back is PROBING; down and out of patience is
        // OFFLINE. The line between them is the backoff running to its end.
        this.deps.onState?.(this.retry >= this.backoff.length ? 'failed' : 'reconnecting')
        this.reconnect()
      }
    }
    this.onOpen = () => {
      this.retry = 0
      this.deps.onState?.('live')
    }
  }

  /** Subscribe to a server event for as long as this stream lives. */
  on(type: string, callback: Listener): () => void {
    const set = this.listeners.get(type) ?? new Set<Listener>()
    set.add(callback)
    this.listeners.set(type, set)
    this.ensure()
    this.source?.addEventListener(type, callback)
    return () => {
      set.delete(callback)
      this.source?.removeEventListener(type, callback)
    }
  }

  /** Is a connection up, or at least on its way up? */
  get alive(): boolean {
    return this.source !== null && this.source.readyState !== STREAM_CLOSED
  }

  /**
   * Reconnect NOW if the link is down — the page returning to the foreground,
   * the network coming back, the user tapping refresh. A live stream is left
   * exactly as it is: dropping a healthy connection would lose nothing but
   * would cost the server a full state re-send for no reason.
   */
  revive(): void {
    if (this.closed || this.alive) return
    this.retry = 0
    this.connect()
  }

  /**
   * Reconnect WHETHER OR NOT the link is down — the data plane moved and this
   * connection is on the old one (plane-streams.ts).
   *
   * The opposite of `revive`, and deliberately its own method rather than a
   * flag: reviving is about a channel that failed, and restarting is about a
   * healthy channel that is now pointed at the wrong place. Collapsing the two
   * would mean either dropping live streams on every foreground return or
   * leaving the canvas fed through the relay after a switch onto the LAN.
   */
  restart(): void {
    if (this.closed) return
    this.retry = 0
    // MAKE BEFORE BREAK. A live stream keeps carrying the session until the
    // new one has opened; tearing it down first left a phone switching onto
    // a slow tailnet with no stream at all for as long as the handshake took
    // — and with none at all when the new path did not open.
    if (!this.alive || this.listeners.size === 0) return this.connect()
    this.openPending()
  }

  private dropPending(): void {
    const pending = this.pending
    if (!pending) return
    this.pending = null
    pending.removeEventListener('open', this.onPendingOpen)
    pending.removeEventListener('error', this.onPendingError)
    pending.close()
  }

  private openPending(): void {
    this.dropPending()
    if (this.timer !== null) {
      this.cancel(this.timer)
      this.timer = null
    }
    const pending = this.deps.open()
    this.pending = pending
    pending.addEventListener('open', this.onPendingOpen)
    pending.addEventListener('error', this.onPendingError)
  }

  /** The new stream opened: it takes over, and the old one is closed. */
  private readonly onPendingOpen = (): void => {
    const next = this.pending
    if (!next) return
    this.pending = null
    next.removeEventListener('open', this.onPendingOpen)
    next.removeEventListener('error', this.onPendingError)
    this.detach()
    this.source?.close()
    this.source = next
    next.addEventListener('error', this.onError)
    next.addEventListener('open', this.onOpen)
    for (const [type, set] of this.listeners) {
      for (const listener of set) next.addEventListener(type, listener)
    }
    this.retry = 0
    this.pendingRetry = 0
    this.deps.onState?.('live')
  }

  /** The new plane would not open: keep the old stream, say so, try again. */
  private readonly onPendingError = (): void => {
    const pending = this.pending
    if (!pending || pending.readyState !== STREAM_CLOSED) return
    this.dropPending()
    this.deps.onSwitchFailed?.()
    if (!this.alive) return this.connect()
    const wait = this.backoff[Math.min(this.pendingRetry, this.backoff.length - 1)]
    this.pendingRetry += 1
    this.timer = this.schedule(() => {
      this.timer = null
      if (!this.closed) this.restart()
    }, wait)
  }

  close(): void {
    this.closed = true
    if (this.timer !== null) this.cancel(this.timer)
    this.timer = null
    this.dropPending()
    this.detach()
    this.source?.close()
    this.source = null
  }

  private ensure(): void {
    if (!this.closed && this.source === null) this.connect()
  }

  private connect(): void {
    if (this.timer !== null) {
      this.cancel(this.timer)
      this.timer = null
    }
    this.dropPending()
    this.detach()
    this.source?.close()
    const source = this.deps.open()
    this.source = source
    source.addEventListener('error', this.onError)
    source.addEventListener('open', this.onOpen)
    for (const [type, set] of this.listeners) {
      for (const listener of set) source.addEventListener(type, listener)
    }
  }

  private detach(): void {
    const source = this.source
    if (!source) return
    source.removeEventListener('error', this.onError)
    source.removeEventListener('open', this.onOpen)
    for (const [type, set] of this.listeners) {
      for (const listener of set) source.removeEventListener(type, listener)
    }
  }

  private reconnect(): void {
    if (this.closed || this.timer !== null) return
    const wait = this.backoff[Math.min(this.retry, this.backoff.length - 1)]
    this.retry += 1
    this.timer = this.schedule(() => {
      this.timer = null
      if (!this.closed) this.connect()
    }, wait)
  }
}

/**
 * A terminal's live stream, healing. The desktop preload retries a cold
 * pty:attach with backoff because ignoring the miss "left the live pane BLACK
 * forever"; this transport's version of that miss is an HTTP 404 on the
 * stream URL while the mirror boots — FATAL to a bare EventSource (a non-2xx
 * never browser-retries) — so the first open of an idle card stayed black
 * until a second open found the mirror the first one had booted. Every
 * (re)connect replays hello + a fresh CLEAR_SCREEN-prefixed frame, so the
 * eventual attach paints whole. Unlike the preload's 8 tries, this retries
 * for as long as the overlay is open: the phone's link genuinely flaps
 * (tailnet, backgrounding) and a capped stream would go silent exactly when
 * it matters. The server's `exit` event ends it — a session that is GONE is
 * not a session to keep dialling.
 */
export interface TerminalStreamHandle {
  close(): void
  /** Reconnect NOW if the link is down — foreground return, network back. */
  revive(): void
  /** Reopen on the current data plane, live or not. See plane-streams.ts. */
  restart(): void
}

export const TERMINAL_STREAM_BACKOFF = [400, 800, 1500, 3000, 5000] as const

export function attachTerminalStream(
  deps: ReconnectingStreamDeps,
  onData: (chunk: string) => void,
  onHello?: (size: { cols: number; rows: number }) => void
): TerminalStreamHandle {
  const stream = new ReconnectingStream({ backoffMs: TERMINAL_STREAM_BACKOFF, ...deps })
  // hello arrives before the first frame; sizing the xterm from it is what
  // keeps a 45x24 phone from re-wrapping a frame serialized at the pane's
  // 100x30 and then misplacing every absolute-addressed delta.
  stream.on('hello', (e) => onHello?.(JSON.parse(e.data as string) as { cols: number; rows: number }))
  stream.on('data', (e) => onData(JSON.parse(e.data as string) as string))
  stream.on('exit', () => stream.close())
  return {
    close: () => stream.close(),
    revive: () => stream.revive(),
    restart: () => stream.restart()
  }
}
