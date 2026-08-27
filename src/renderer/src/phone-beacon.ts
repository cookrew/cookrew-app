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
    dpr: window.devicePixelRatio
  }
}

/** Start the black box. Remote (phone) clients only; desktop pays nothing. */
export function startPhoneBeacon(): void {
  if (!isRemoteMode()) return
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
