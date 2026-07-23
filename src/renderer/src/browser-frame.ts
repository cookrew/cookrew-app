/**
 * Mobile browser LIVE-FRAME view (mobile-browser-ux-fix, note: phone can't see
 * file:// / PDFs / webview-only content in a dead iframe). On the phone the
 * zoomed-open browser renders the desktop's captured frame — polled from
 * GET /api/browser/:id/thumb — instead of an iframe that renders blank. This
 * module is the JSX-free, unit-tested core: the poll cadence + lifecycle gate,
 * the cache-busted frame URL, the letterbox fit math, and the interval poller.
 */

/**
 * Poll cadence (ms) for the live frame while the phone has the browser open.
 * CAPTURE-FRESHNESS CONTRACT (Forge, landed): each GET /api/browser/:id/thumb
 * marks the browser phone-viewed for an 8s TTL, so the desktop keeps capturing
 * it at the 5s rate even when its window is hidden/occluded (the poll itself is
 * the keep-alive signal). Matched to that 5s capture cadence: fresh frames
 * without refetching identical ones, and 5s < 8s TTL so the keep-alive never
 * lapses between polls. (Ask Forge for demand-driven capture if <5s is needed.)
 */
export const FRAME_POLL_MS = 5000

/**
 * Poll ONLY while the browser view is OPEN (zoomed) AND the document is visible.
 * A closed or occluded phone view must stop fetching (and stop asking the
 * desktop to capture) — never poll a browser the user isn't looking at. Pure.
 */
export function shouldPollFrame(opts: { open: boolean; hidden: boolean }): boolean {
  return opts.open && !opts.hidden
}

/**
 * The thumb URL for a poll tick. `seq` is a monotonic cache-buster so each fetch
 * pulls a FRESH frame: the endpoint is `no-store`, but an <img> reusing an
 * identical src can skip the network entirely, freezing the view. Pure.
 */
export function frameSrc(browserId: string, seq: number): string {
  return `/api/browser/${encodeURIComponent(browserId)}/thumb?f=${seq}`
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
