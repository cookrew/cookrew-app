import { useEffect, useRef, useState } from 'react'
import { CrIcon } from './icons'
import {
  FRAME_POLL_MS,
  createFramePoller,
  fitContain,
  frameSrc,
  shouldPollFrame
} from './browser-frame'

/**
 * The phone's LIVE browser view (mobile-browser-ux-fix): a webview-only page —
 * file://, a PDF, cross-origin content — renders BLANK in a phone iframe, but
 * the desktop already captures the real frame and serves it at
 * GET /api/browser/:id/thumb. So on the phone we show that captured frame as the
 * PRIMARY display, polled while the browser is open, fit-scaled (letterbox), with
 * a loading placeholder until the first frame lands. Fresco owns the placeholder
 * + fit visuals; this owns the poll lifecycle + fit wiring.
 */
export function MobileBrowserFrame({
  browserId,
  open
}: {
  browserId: string
  /** True while the browser is zoomed open on the phone (poll only then). */
  open: boolean
}): React.JSX.Element {
  const [seq, setSeq] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [view, setView] = useState({ w: 0, h: 0 })
  const [natural, setNatural] = useState({ w: 0, h: 0 })
  const boxRef = useRef<HTMLDivElement>(null)

  // Measure the view box so the frame fit-scales to it (re-measures on resize /
  // rotate). This is the letterbox target.
  useEffect(() => {
    const el = boxRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = (): void => setView({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  // Poll the live frame while OPEN + visible; stop on close/occlude. A new seq
  // each tick → a fresh cache-busted <img> src → the newest captured frame.
  useEffect(() => {
    const poller = createFramePoller(() => setSeq((s) => s + 1), FRAME_POLL_MS)
    const sync = (): void => {
      if (shouldPollFrame({ open, hidden: document.hidden })) poller.start()
      else poller.stop()
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      poller.stop()
      document.removeEventListener('visibilitychange', sync)
    }
  }, [open])

  const fit = fitContain(natural.w, natural.h, view.w, view.h)

  return (
    <div ref={boxRef} className="browser-body browser-frame nodrag nowheel">
      {!loaded && (
        <div className="browser-frame-loading" role="status" aria-live="polite">
          <span className="browser-frame-glyph">
            <CrIcon name="browser" />
          </span>
          <span className="cr-kicker">loading live view…</span>
        </div>
      )}
      <img
        className={`browser-frame-img${loaded ? ' ready' : ''}`}
        src={frameSrc(browserId, seq)}
        alt=""
        draggable={false}
        style={
          fit.width > 0
            ? { width: fit.width, height: fit.height, left: fit.left, top: fit.top }
            : undefined
        }
        onLoad={(e) => {
          const img = e.currentTarget
          if (img.naturalWidth > 0) setNatural({ w: img.naturalWidth, h: img.naturalHeight })
          setLoaded(true)
        }}
        // A 404 (no frame yet) keeps the placeholder; the next poll retries.
        onError={() => undefined}
      />
    </div>
  )
}
