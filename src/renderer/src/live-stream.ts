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
  /** Timer injection, so the backoff is testable without waiting it out. */
  schedule?: (run: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
  /** Delay before each successive retry; the last value repeats. */
  backoffMs?: readonly number[]
}

const DEFAULT_BACKOFF = [1000, 2000, 5000, 10_000, 15_000] as const

type Listener = (event: MessageEvent) => void

/**
 * One event stream that outlives its connections. Subscribers register with
 * `on()` once and keep receiving events across every reconnect — they never
 * see the socket underneath change.
 */
export class ReconnectingStream {
  private source: EventStreamLike | null = null
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
      if (this.source && this.source.readyState === STREAM_CLOSED) this.reconnect()
    }
    this.onOpen = () => {
      this.retry = 0
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

  close(): void {
    this.closed = true
    if (this.timer !== null) this.cancel(this.timer)
    this.timer = null
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
  return { close: () => stream.close(), revive: () => stream.revive() }
}
