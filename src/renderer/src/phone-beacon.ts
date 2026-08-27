/**
 * The phone's own black box. Apple's inspection channels are all dead against
 * iOS 26.6 (Safari's inspector loses the page on crash; ios_webkit_debug_proxy
 * cannot evaluate at all), and the kernel says WebContent carries ~1.5 GB from
 * ordinary browsing — 97 s over the limit before the kill (2026-08-27
 * 19:30:17). So the page reports its own vitals to our server every 3 s; the
 * last beacon before a crash is the autopsy nobody else can take.
 */
import { apiPath } from './api-base'
import { authHeaders } from './auth-gate'
import { isRemoteMode } from './api'

const BEACON_MS = 3000

/** Wire + liveness counters, installed before the app creates any stream. */
const wire = { sse: 0, sseMsgs: 0, fetches: 0, lagMax: 0 }
function installTaps(): void {
  const RealES = window.EventSource
  if (RealES) {
    const Wrapped = function (this: EventSource, ...args: ConstructorParameters<typeof EventSource>) {
      const es = new RealES(...args)
      const realAdd = es.addEventListener.bind(es)
      es.addEventListener = ((type: string, fn: EventListener, opts?: AddEventListenerOptions) =>
        realAdd(type, ((e: MessageEvent) => {
          wire.sse += (e?.data ?? '').length || 0
          wire.sseMsgs += 1
          return fn(e)
        }) as EventListener, opts)) as typeof es.addEventListener
      return es
    } as unknown as typeof EventSource
    Wrapped.prototype = RealES.prototype
    window.EventSource = Wrapped
  }
  const realFetch = window.fetch.bind(window)
  window.fetch = (input, init) => {
    wire.fetches += 1
    return realFetch(input, init)
  }
  // Event-loop lag: how late a 500ms timer fires. A wedge shows up as a
  // spike here long before any external probe could see it.
  let last = Date.now()
  window.setInterval(() => {
    const now = Date.now()
    const lag = now - last - 500
    if (lag > wire.lagMax) wire.lagMax = lag
    last = now
  }, 500)
}

function vitals(): Record<string, unknown> {
  const q = (s: string): number => document.querySelectorAll(s).length
  const canvases = [...document.querySelectorAll('canvas')]
  let transformed = 0
  let transformedPx = 0
  for (const el of document.querySelectorAll<HTMLElement>('[style*="transform"]')) {
    const r = el.getBoundingClientRect()
    if (r.width * r.height > 10_000) {
      transformed += 1
      transformedPx += Math.round(r.width * r.height)
    }
  }
  return {
    t: Date.now(),
    dom: q('*'),
    cards: q('.react-flow__node'),
    xterm: q('.xterm-screen'),
    xtermRows: q('.xterm-rows > div'),
    canv: canvases.length,
    canvPx: canvases.reduce((s, c) => s + (c.width || 0) * (c.height || 0), 0),
    canvList: canvases.slice(0, 6).map((c) => [c.width, c.height]),
    transformed,
    transformedMPx: Math.round(transformedPx / 1e6),
    imgs: document.images.length,
    zoom: window.visualViewport ? +window.visualViewport.scale.toFixed(2) : -1,
    vw: window.innerWidth,
    vh: window.innerHeight,
    dpr: window.devicePixelRatio,
    sseKB: Math.round(wire.sse / 1000),
    sseMsgs: wire.sseMsgs,
    fetches: wire.fetches,
    lagMax: wire.lagMax
  }
}

/** Start the black box. Remote (phone) clients only; desktop pays nothing. */
export function startPhoneBeacon(): void {
  if (!isRemoteMode()) return
  installTaps()
  const send = (): void => {
    try {
      void fetch(apiPath('/api/beacon'), {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(vitals()),
        keepalive: true
      }).catch(() => undefined)
    } catch {
      // The black box must never be the crash.
    }
  }
  send()
  window.setInterval(send, BEACON_MS)
}
