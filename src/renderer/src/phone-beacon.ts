/**
 * The phone's own black box. Apple's inspection channels are all dead against
 * iOS 26.6 (Safari's inspector loses the page on crash; ios_webkit_debug_proxy
 * cannot evaluate at all), and the kernel says WebContent carries ~1.5 GB from
 * ordinary browsing — 97 s over the limit before the kill (2026-08-27
 * 19:30:17). So the page reports its own vitals to our server every 3 s; the
 * last beacon before a crash is the autopsy nobody else can take.
 */
import { apiPath } from './api-base'
import { planeFetch } from './plane-fetch'
import { authHeaders } from './auth-gate'
import { isRemoteMode } from './api'
import { tapEventSource } from './sse-tap'
import { RELAY_ANSWER_MS, skipWhileOut } from './in-flight'

const BEACON_MS = 3000

/** Wire + liveness counters, installed before the app creates any stream. */
const wire = { sse: 0, sseMsgs: 0, fetches: 0, lagMax: 0 }
function installTaps(): void {
  const RealES = window.EventSource
  if (RealES) {
    window.EventSource = tapEventSource(RealES, (data) => {
      wire.sse += data.length
      wire.sseMsgs += 1
    })
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

/**
 * Stage marker: an IMMEDIATE keepalive POST, for instrumenting a code path
 * that kills the page in under a second — the last stage that lands in the
 * log names the killer's exact neighbourhood. keepalive lets the request
 * survive the page's own death.
 */
export function markStage(stage: string): void {
  if (!isRemoteMode()) return
  try {
    void planeFetch(apiPath('/api/beacon'), {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ stage, t: Date.now() }),
      keepalive: true
    }).catch(() => undefined)
  } catch {
    // never the crash
  }
}

/** Start the black box. Remote (phone) clients only; desktop pays nothing. */
export function startPhoneBeacon(): void {
  if (!isRemoteMode()) return
  installTaps()
  // One out at a time: a stalled Mac would otherwise collect one exchange per
  // tick, ten of the relay's sixteen before the first of them expires. Async,
  // so a throw from vitals() is a rejection skipWhileOut already absorbs: the
  // black box must never be the crash.
  const send = skipWhileOut(async () => {
    await planeFetch(apiPath('/api/beacon'), {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(vitals()),
      keepalive: true
    })
  }, RELAY_ANSWER_MS)
  send()
  window.setInterval(send, BEACON_MS)
}
