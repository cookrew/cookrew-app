/**
 * THREE WAYS TO KNOCK THAT ARE NOT A FETCH.
 *
 * On iOS every browser is WebKit, and a fetch from the cookrew.dev page to the
 * Mac's LAN name never leaves the phone (2026-10-11: a 2.5 s probe, no packet
 * at the Mac). So before the companion can know it is home, it needs a knock
 * the browser will carry: a WebSocket to the Mac's hello socket
 * (main/socket-hello.ts), an <img> of the Mac's pixel, and an opaque request
 * to the same hello the fetch could not make. Each answers 'answered',
 * 'network' or 'timeout' with how long it took, and all three are reported to
 * the Mac so the owner can read which one this phone carries.
 *
 * PURE OVER ITS DEPS: the constructors and the clock are injected, so the
 * rule is testable without a browser, and the browser-bound defaults sit at
 * the bottom in one place.
 */

import type { PathReportProbe } from '../../../shared/path-report'

export type ProbeOutcome = 'answered' | 'network' | 'timeout'

export interface ReachProbe extends PathReportProbe {
  readonly outcome: ProbeOutcome
}

/** A socket, an image: the subset of each the probe actually uses. */
export interface SocketLike {
  onopen: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: unknown) => void) | null
  close(): void
}
export interface ImageLike {
  onload: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
  src: string
}

export interface ReachProbeDeps {
  readonly socket?: (url: string) => SocketLike
  readonly image?: () => ImageLike
  readonly fetch?: (url: string, init: RequestInit) => Promise<unknown>
  readonly now?: () => number
  readonly deadlineMs?: number
}

/** Long enough for a cold lookup of the name (ask-hello.ts · NAME_HELLO_TIMEOUT_MS). */
export const PROBE_DEADLINE_MS = 2500

export const SOCKET_HELLO_PATH = '/api/ws-hello'
export const PIXEL_PATH = '/api/pixel'

/** `wss://host:port` for `https://host:port`. */
export const socketUrl = (origin: string): string =>
  `${origin.replace(/^http/, 'ws')}${SOCKET_HELLO_PATH}`

const probeName = (origin: string): string => {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

const settle = (
  kind: ReachProbe['kind'],
  origin: string,
  started: number,
  now: () => number,
  outcome: ProbeOutcome
): ReachProbe => ({ kind, name: probeName(origin), outcome, ms: Math.max(0, now() - started) })

/** One probe: whichever of answered / failed / the deadline comes first. */
const race = (
  kind: ReachProbe['kind'],
  origin: string,
  deps: ReachProbeDeps,
  start: (answered: () => void, failed: () => void) => (() => void) | void
): Promise<ReachProbe> =>
  new Promise((resolve) => {
    const now = deps.now ?? ((): number => Date.now())
    const started = now()
    let done = false
    let cancel: (() => void) | void
    const finish = (outcome: ProbeOutcome): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        cancel?.()
      } catch {
        // A probe that cannot be cancelled has already ended.
      }
      resolve(settle(kind, origin, started, now, outcome))
    }
    const timer = setTimeout(() => finish('timeout'), deps.deadlineMs ?? PROBE_DEADLINE_MS)
    try {
      cancel = start(
        () => finish('answered'),
        () => finish('network')
      )
    } catch {
      finish('network')
    }
  })

export const probeSocket = (origin: string, deps: ReachProbeDeps = {}): Promise<ReachProbe> =>
  race('socket', origin, deps, (answered, failed) => {
    const make = deps.socket ?? ((url) => new WebSocket(url) as unknown as SocketLike)
    const socket = make(socketUrl(origin))
    socket.onopen = answered
    socket.onerror = failed
    // A close before an open is a refusal spelled quietly.
    socket.onclose = failed
    return () => socket.close()
  })

export const probeImage = (origin: string, deps: ReachProbeDeps = {}): Promise<ReachProbe> =>
  race('image', origin, deps, (answered, failed) => {
    const make = deps.image ?? ((): ImageLike => new Image() as unknown as ImageLike)
    const image = make()
    image.onload = answered
    image.onerror = failed
    image.src = `${origin}${PIXEL_PATH}?t=${Date.now()}`
    return () => {
      image.onload = null
      image.onerror = null
    }
  })

export const probeOpaque = (origin: string, deps: ReachProbeDeps = {}): Promise<ReachProbe> =>
  race('opaque', origin, deps, (answered, failed) => {
    const call = deps.fetch ?? ((url, init) => fetch(url, init))
    const abort = new AbortController()
    void call(`${origin}/api/hello?nonce=probe`, {
      mode: 'no-cors',
      credentials: 'omit',
      cache: 'no-store',
      signal: abort.signal
    }).then(answered, failed)
    return () => abort.abort()
  })

/** All three at once; the report carries each, the decision reads any. */
export const probeReach = (origin: string, deps: ReachProbeDeps = {}): Promise<ReachProbe[]> =>
  Promise.all([probeSocket(origin, deps), probeImage(origin, deps), probeOpaque(origin, deps)])
