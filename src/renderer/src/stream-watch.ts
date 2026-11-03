/**
 * A STREAM THAT LOOKS OPEN AND IS NOT.
 *
 * EventSource only reports a connection the network RESET. A path that died
 * without one — Tailscale going down under it, a phone moving between
 * networks, a VPN taking over the routes — leaves `readyState` at OPEN for as
 * long as the OS keeps the socket, and the page simply stops hearing anything:
 * the transcript freezes, the badge still says TAILNET, nothing reconnects.
 *
 * So every stream the companion opens is watched (rtc-plane.ts ·
 * openEventSource):
 *
 *   NOT OPEN WITHIN STREAM_OPEN_MS — a connect into a black hole. Dead.
 *
 *   SILENT FOR STREAM_SILENT_MS once it has beaten — the Mac sends a named
 *   `hb` every 10 s (main/mobile-http.ts · SSE_HEARTBEAT_MS). Dead. The watch
 *   is armed only by the first beat, so a Mac too old to send one is never
 *   mistaken for a dead one.
 *
 * Dead means what a reset would have meant: the source is closed and an
 * `error` is delivered with readyState CLOSED, which every consumer already
 * answers by reconnecting on whatever plane is current.
 */

export const STREAM_OPEN_MS = 15_000
/** Two and a bit beats: one late beat is a slow path, two missing are a dead one. */
export const STREAM_SILENT_MS = 22_000
/** A timer this late did not run on time: the page was suspended, not the path silent. */
export const SUSPENDED_LATE_MS = 4_000

/**
 * Why a stream was declared dead, for whoever decides about the plane
 * (path/companion.ts): SILENT is proof the path stopped carrying a stream
 * that was working; NEVER-OPENED is one failed connect; SUSPENDED is a phone
 * that slept — the stream is reopened, and nothing is blamed.
 */
export type StreamDeath = 'silent' | 'never-opened' | 'suspended'
const deaths = new Set<(why: StreamDeath) => void>()
export const onStreamDeath = (listener: (why: StreamDeath) => void): (() => void) => {
  deaths.add(listener)
  return () => void deaths.delete(listener)
}

const CLOSED = 2

export interface WatchableSource {
  readonly readyState: number
  close(): void
  addEventListener(type: string, listener: (event: Event) => void): void
  dispatchEvent(event: Event): boolean
  onerror: ((event: Event) => void) | null
}

export interface StreamWatchOptions {
  readonly openMs?: number
  readonly silentMs?: number
  /** Is this the browser's own EventSource, whose `onerror` a dispatched event already reaches? */
  readonly native?: boolean
}

export const watchStream = <S extends WatchableSource>(source: S, options: StreamWatchOptions = {}): S => {
  const silentMs = options.silentMs ?? STREAM_SILENT_MS
  const native = options.native ?? (typeof EventSource !== 'undefined' && source instanceof EventSource)
  let beating = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let due = 0
  const close = source.close.bind(source)

  const stop = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const kill = (): void => {
    timer = null
    if (source.readyState === CLOSED) return
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    const why: StreamDeath = hidden || Date.now() - due > SUSPENDED_LATE_MS ? 'suspended' : beating ? 'silent' : 'never-opened'
    close()
    for (const listener of [...deaths]) listener(why)
    const event = new Event('error')
    source.dispatchEvent(event)
    // A stand-in's `onerror` is a plain property no dispatched event reaches.
    if (!native) source.onerror?.(event)
  }
  const arm = (ms: number): void => {
    stop()
    due = Date.now() + ms
    timer = setTimeout(kill, ms)
  }

  arm(options.openMs ?? STREAM_OPEN_MS)
  source.addEventListener('open', () => (beating ? arm(silentMs) : stop()))
  source.addEventListener('hb', () => {
    beating = true
    arm(silentMs)
  })
  source.addEventListener('error', () => {
    if (source.readyState === CLOSED) stop()
  })
  ;(source as { close: () => void }).close = () => {
    stop()
    close()
  }
  return source
}
