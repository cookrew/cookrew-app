/**
 * Legacy flag-off mobile browser frame. Because a phone cannot render file://,
 * PDFs, or webview-only content in an iframe, it polls the desktop capture at
 * GET /api/browser/:id/thumb. Flag-on desktop and phone use the node-owned
 * headless stream and never enter this fallback. This is the JSX-free core for
 * poll cadence/lifecycle, cache-busting, letterbox math, and interval control.
 */

import { withStreamToken } from './stream-ticket'

/**
 * Poll cadence (ms) for the legacy frame while the phone has the browser open.
 * CAPTURE-FRESHNESS CONTRACT (Forge, landed): each GET /api/browser/:id/thumb
 * marks the browser phone-viewed for an 8s TTL, so the desktop keeps capturing
 * it at the 5s rate even when its window is hidden/occluded (the poll itself is
 * the keep-alive signal). Matched to that 5s capture cadence: fresh frames
 * without refetching identical ones, and 5s < 8s TTL so the keep-alive never
 * lapses between polls. (Ask Forge for demand-driven capture if <5s is needed.)
 */
export const FRAME_POLL_MS = 5000

/**
 * In flag-off mode, poll ONLY while the browser view is OPEN (zoomed) and the
 * document is visible. A closed or occluded phone view must stop fetching and
 * stop asking the desktop to capture. Pure.
 */
export function shouldPollFrame(opts: { open: boolean; hidden: boolean }): boolean {
  return opts.open && !opts.hidden
}

/**
 * The thumb URL for a poll tick. `seq` is a monotonic cache-buster so each fetch
 * pulls a FRESH frame: the endpoint is `no-store`, but an <img> reusing an
 * identical src can skip the network entirely, freezing the view. Pure.
 */
export function frameSrc(browserId: string, seq: number, token?: string | null): string {
  // `<img src>` cannot carry a bearer header, so the phone's credential rides
  // as a stream ticket (v4 §4) — this GET is gated like every other /api/*.
  return withStreamToken(`/api/browser/${encodeURIComponent(browserId)}/thumb?f=${seq}`, token)
}

/** A fitted (letterboxed) rect for the frame within the view. */
export interface FitRect {
  width: number
  height: number
  left: number
  top: number
}

/**
 * Letterbox fit (fit-scale to the view): the largest rect with the FRAME's
 * aspect ratio that fits inside the view, centered — so a portrait PDF or a
 * wide page shows whole, never cropped or stretched. Any non-positive dimension
 * (unmeasured view / no frame yet) → a zero rect. Pure — unit-tested.
 */
export function fitContain(
  frameW: number,
  frameH: number,
  viewW: number,
  viewH: number
): FitRect {
  if (frameW <= 0 || frameH <= 0 || viewW <= 0 || viewH <= 0) {
    return { width: 0, height: 0, left: 0, top: 0 }
  }
  const scale = Math.min(viewW / frameW, viewH / frameH)
  const width = frameW * scale
  const height = frameH * scale
  return { width, height, left: (viewW - width) / 2, top: (viewH - height) / 2 }
}

export interface FramePoller {
  start: () => void
  stop: () => void
}

/**
 * Interval poll controller (control-flow, fake-timer testable): `start` is
 * idempotent (never stacks intervals); each tick calls `onTick`; `stop` clears.
 * Pure.
 */
export function createFramePoller(onTick: () => void, intervalMs: number): FramePoller {
  let timer: ReturnType<typeof setInterval> | null = null
  return {
    start: (): void => {
      if (timer) return
      timer = setInterval(onTick, intervalMs)
    },
    stop: (): void => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }
}
