import { useEffect, useRef, useState } from 'react'
import { CrIcon } from './icons'
import {
  FRAME_POLL_MS,
  createFramePoller,
  fitContain,
  frameSrc,
  shouldPollFrame
} from './browser-frame'
import { frameSource, keyMsg, pointerMsg, viewToFramePoint, wheelMsg } from './browser-stream'
import { useBrowserStream } from './useBrowserStream'

/**
 * The phone's LIVE browser view (mobile-browser-ux-fix + interactive-remote-
 * browser-c). Two sources, feature-detected:
 *   • STREAM (preferred): a CDP screencast over WS — live JPEG frames the phone
 *     renders AND drives (touch/scroll/type forwarded as Input events). Works for
 *     file:// / auth / localhost because the DESKTOP loads the page.
 *   • THUMB (fallback): the static 5s /thumb capture poll (phase 1) — used when
 *     the stream/CDP path is unavailable (the hook falls back loudly).
 * A webview-only page renders blank in a phone iframe, so we never use one here.
 * Fresco owns the touch affordances, streaming indicator, and loading visuals.
 */
export function MobileBrowserFrame({
  browserId,
  open
}: {
  browserId: string
  /** True while the browser is zoomed open on the phone (stream/poll only then). */
  open: boolean
}): React.JSX.Element {
  const stream = useBrowserStream(browserId, open)
  const streaming = frameSource(stream.status) === 'stream'
  // Interactive ONLY while frames are actively flowing — a WS that's open but
  // frameless, or a stalled/frozen frame, must never present as tappable.
  const interactive = streaming && stream.live && stream.frameUrl !== null

  const [seq, setSeq] = useState(0) // /thumb cache-buster (fallback mode)
  const [loaded, setLoaded] = useState(false)
  const [view, setView] = useState({ w: 0, h: 0 })
  const [natural, setNatural] = useState({ w: 0, h: 0 })
  const boxRef = useRef<HTMLDivElement>(null)

  // Measure the view box so either source fit-scales (letterbox) into it.
  useEffect(() => {
    const el = boxRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = (): void => setView({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  // FALLBACK poll: only when NOT streaming — the /thumb refetch loop (phase 1),
  // gated on open + visible so a closed/occluded view stops fetching.
  useEffect(() => {
    if (streaming) return
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
  }, [streaming, open])

  // Both sources report their pixel size via the <img> natural size (the stream
  // frame's JPEG dims, the thumb's PNG dims) — used as the letterbox + coord basis.
  const fit = fitContain(natural.w, natural.h, view.w, view.h)

  const src = streaming ? stream.frameUrl : frameSrc(browserId, seq)
  // In stream mode the placeholder shows until the view is genuinely live, so a
  // frozen frame reads as "connecting…", not an interactive surface.
  const showPlaceholder = streaming ? !interactive : !loaded

  // ---- input forwarding (stream mode only): map view point → FRAME px, then send
  // the compact `t`-tagged message; Forge maps FRAME px → page px + whitelists. ----
  const dragging = useRef(false)
  const framePoint = (e: React.PointerEvent): { x: number; y: number } | null => {
    const box = boxRef.current
    if (!box || natural.w <= 0) return null
    const r = box.getBoundingClientRect()
    return viewToFramePoint(e.clientX - r.left, e.clientY - r.top, fit, natural.w, natural.h)
  }
  const onPointerDown = (e: React.PointerEvent): void => {
    if (!streaming) return
    const p = framePoint(e)
    if (!p) return
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    stream.send(pointerMsg('down', p))
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    if (!streaming || !dragging.current) return
    const p = framePoint(e)
    if (p) stream.send(pointerMsg('move', p))
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    if (!streaming || !dragging.current) return
    dragging.current = false
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    const p = framePoint(e)
    // down→up is a click when there was no drag, a scroll-end when there was.
    if (p) stream.send(pointerMsg('up', p))
  }
  const onWheel = (e: React.WheelEvent): void => {
    if (!streaming) return
    const box = boxRef.current
    if (!box || natural.w <= 0) return
    const r = box.getBoundingClientRect()
    const p = viewToFramePoint(e.clientX - r.left, e.clientY - r.top, fit, natural.w, natural.h)
    stream.send(wheelMsg(p, e.deltaY))
  }
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!streaming) return
    if (e.key === 'Escape') return // let harness shortcuts bubble
    e.stopPropagation()
    stream.send(keyMsg(e.key, e.code))
  }

  return (
    <div
      ref={boxRef}
      className={`browser-body browser-frame nodrag nowheel${interactive ? ' streaming' : ''}`}
      // Interactive drive ONLY while frames are actively flowing (not merely WS
      // open); the tabIndex lets it take keys.
      tabIndex={interactive ? 0 : undefined}
      onPointerDown={interactive ? onPointerDown : undefined}
      onPointerMove={interactive ? onPointerMove : undefined}
      onPointerUp={interactive ? onPointerUp : undefined}
      onPointerCancel={interactive ? onPointerUp : undefined}
      onWheel={interactive ? onWheel : undefined}
      onKeyDown={interactive ? onKeyDown : undefined}
    >
      {showPlaceholder && (
        <div className="browser-frame-loading" role="status" aria-live="polite">
          <span className="browser-frame-glyph">
            <CrIcon name="browser" />
          </span>
          <span className="cr-kicker">{streaming ? 'connecting live view…' : 'loading live view…'}</span>
        </div>
      )}
      {interactive && <span className="browser-frame-live" aria-hidden="true" />}
      {src && (
        <img
          className={`browser-frame-img${showPlaceholder ? '' : ' ready'}`}
          src={src}
          alt=""
          draggable={false}
          style={
            fit.width > 0
              ? { width: fit.width, height: fit.height, left: fit.left, top: fit.top }
              : undefined
          }
          onLoad={(e) => {
            // Both sources report their pixel size here (frame JPEG / thumb PNG);
            // it's the letterbox + input-coord basis. No client ack — Forge paces
            // the stream server-side (screencast-pace) on socket drain.
            const img = e.currentTarget
            if (img.naturalWidth > 0 && (img.naturalWidth !== natural.w || img.naturalHeight !== natural.h)) {
              setNatural({ w: img.naturalWidth, h: img.naturalHeight })
            }
            if (!streaming) setLoaded(true)
          }}
          onError={() => undefined}
        />
      )}
    </div>
  )
}
