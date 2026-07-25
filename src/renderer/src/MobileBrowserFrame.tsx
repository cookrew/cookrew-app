import { useEffect, useRef, useState } from 'react'
import { CrIcon } from './icons'
import {
  FRAME_POLL_MS,
  createFramePoller,
  fitContain,
  frameSrc,
  shouldPollFrame
} from './browser-frame'
import {
  frameSource,
  keyMsg,
  mobileViewportPreference,
  pointerMsg,
  streamSurfaceState,
  touchMsg,
  viewToFramePoint,
  wheelMsg,
  type StreamSurfaceState
} from './browser-stream'
import { useBrowserStream } from './useBrowserStream'

/**
 * Shared LIVE browser viewport for phone and desktop. In headless mode, both
 * clients render and drive the same CDP screencast and fail closed on neutral
 * loading/unavailable surfaces. Only the flag-off phone path uses /thumb.
 */
export function MobileBrowserFrame({
  browserId,
  open,
  streamEnabled,
  desktopStreamToken,
  fallback = 'thumb'
}: {
  browserId: string
  /** True while this browser pane is zoomed open (stream/poll only then). */
  open: boolean
  /** Resolved main/remote capability; false never opens the stream socket. */
  streamEnabled: boolean
  /** Per-process credential for native Electron; always null on the phone. */
  desktopStreamToken: string | null
  /** Flag-off phone uses /thumb; headless clients use a neutral fallback. */
  fallback?: 'thumb' | 'loading'
}): React.JSX.Element {
  const [seq, setSeq] = useState(0) // /thumb cache-buster (fallback mode)
  const [loaded, setLoaded] = useState(false)
  const [streamFrameLoaded, setStreamFrameLoaded] = useState(false)
  const [view, setView] = useState({ w: 0, h: 0 })
  const [natural, setNatural] = useState({ w: 0, h: 0 })
  const [coarsePointer, setCoarsePointer] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const mobilePreference = mobileViewportPreference(view.w, coarsePointer)
  const stream = useBrowserStream(browserId, open, streamEnabled, desktopStreamToken, {
    width: view.w,
    height: view.h,
    mobile: mobilePreference
  })
  const streaming = frameSource(stream.status) === 'stream'

  // Observers still see and drive the shared frame. The viewport owner controls
  // layout fit only; input requires a decoded, live frame at the current revision.
  const frameReady = streaming && stream.live && stream.frameUrl !== null && streamFrameLoaded
  const interactive = frameReady && stream.canDrive

  useEffect(() => {
    if (!open) {
      setLoaded(false)
      setStreamFrameLoaded(false)
      setNatural({ w: 0, h: 0 })
    }
  }, [open, browserId])

  useEffect(() => setStreamFrameLoaded(false), [streaming, stream.frameRevision])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(pointer: coarse)')
    const update = (): void => setCoarsePointer(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  // Measure the view box so either source fit-scales (letterbox) into it.
  useEffect(() => {
    const el = boxRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const commit = (width: number, height: number): void => {
      const next = { w: Math.round(width), h: Math.round(height) }
      setView((current) => (current.w === next.w && current.h === next.h ? current : next))
    }
    const measure = (): void => commit(el.clientWidth, el.clientHeight)
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) commit(entry.contentRect.width, entry.contentRect.height)
      else measure()
    })
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  // LEGACY FLAG-OFF poll: the /thumb refetch loop, gated on open + visible so
  // a closed/occluded phone view stops fetching. Headless mode never enters it.
  useEffect(() => {
    if (fallback !== 'thumb' || streaming) return
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
  }, [fallback, streaming, open])

  // Both sources report their pixel size via the <img> natural size (the stream
  // frame's JPEG dims, the thumb's PNG dims) — used as the letterbox + coord basis.
  const fit = fitContain(natural.w, natural.h, view.w, view.h)

  const src = streaming
    ? stream.frameUrl
    : fallback === 'thumb' && open
      ? frameSrc(browserId, seq)
      : null
  // In stream mode the placeholder shows until the view is genuinely live, so a
  // frozen frame reads as "connecting…", not an interactive surface.
  const showPlaceholder = streaming ? !frameReady : fallback === 'loading' || !loaded
  const surfaceState = streamSurfaceState({
    open,
    status: stream.status,
    frameLoaded: streamFrameLoaded,
    live: stream.live,
    fallback
  })
  const statusText = streamStatusText(surfaceState, stream)
  const showControl = streaming && stream.controlAvailable
  const controlDisabled = stream.agentHeld || stream.transitioning
  const controlLabel = stream.agentHeld
    ? 'Viewport fit is held while the agent is driving'
    : stream.transitioning
      ? 'Browser viewport fit is changing'
      : stream.isOwner
        ? 'Release viewport fit'
        : 'Fit browser to this view'

  // ---- input forwarding (stream mode only): map view point → FRAME px, then send
  // the compact `t`-tagged message; Forge maps FRAME px → page px + whitelists. ----
  const dragging = useRef(false)
  // A touch pointer (phone) drives touch events so a swipe scrolls natively; a
  // mouse/pen pointer (desktop) keeps mouse events. Tracked per active drag.
  const dragTouch = useRef(false)
  // Exactly one pointer drives at a time — a second finger mid-drag would corrupt
  // the single-touch sequence; secondary pointers are ignored until release.
  const activePointerId = useRef<number | null>(null)
  const lastPoint = useRef<{ x: number; y: number } | null>(null)

  // If freshness disappears mid-drag, release the remote pointer (mouse OR touch)
  // before input is disabled so the headless page is not left mid-press/mid-touch.
  useEffect(() => {
    if (interactive || !dragging.current) return
    dragging.current = false
    activePointerId.current = null
    if (lastPoint.current) {
      stream.send(
        dragTouch.current ? touchMsg('touchend', lastPoint.current) : pointerMsg('up', lastPoint.current)
      )
    }
  }, [interactive, stream.send])

  const framePoint = (e: React.PointerEvent): { x: number; y: number } | null => {
    const box = boxRef.current
    if (!box || natural.w <= 0) return null
    const r = box.getBoundingClientRect()
    return viewToFramePoint(e.clientX - r.left, e.clientY - r.top, fit, natural.w, natural.h)
  }
  const onPointerDown = (e: React.PointerEvent): void => {
    if (!interactive) return
    if (activePointerId.current !== null) return // a drag is already in flight — ignore extra fingers
    const p = framePoint(e)
    if (!p) return
    e.preventDefault()
    boxRef.current?.focus()
    activePointerId.current = e.pointerId
    dragging.current = true
    dragTouch.current = e.pointerType === 'touch'
    lastPoint.current = p
    e.currentTarget.setPointerCapture(e.pointerId)
    stream.send(dragTouch.current ? touchMsg('touchstart', p) : pointerMsg('down', p))
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    if (!interactive || !dragging.current || e.pointerId !== activePointerId.current) return
    const p = framePoint(e)
    if (p) {
      lastPoint.current = p
      stream.send(dragTouch.current ? touchMsg('touchmove', p) : pointerMsg('move', p))
    }
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    if (!dragging.current || e.pointerId !== activePointerId.current) return
    dragging.current = false
    activePointerId.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    const p = framePoint(e)
    if (p) {
      lastPoint.current = p
      stream.send(dragTouch.current ? touchMsg('touchend', p) : pointerMsg('up', p))
    }
  }
  const onWheel = (e: React.WheelEvent): void => {
    if (!interactive) return
    const box = boxRef.current
    if (!box || natural.w <= 0) return
    e.preventDefault()
    const r = box.getBoundingClientRect()
    const p = viewToFramePoint(e.clientX - r.left, e.clientY - r.top, fit, natural.w, natural.h)
    stream.send(wheelMsg(p, e.deltaY))
  }
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!interactive) return
    if (e.key === 'Escape') return // let harness shortcuts bubble
    e.preventDefault()
    e.stopPropagation()
    stream.send(keyMsg(e.key, e.code))
  }

  return (
    <div
      ref={boxRef}
      className={`browser-body browser-frame nodrag nowheel${interactive ? ' streaming' : ''}`}
      data-browser-id={browserId}
      data-stream-status={stream.status}
      data-stream-state={surfaceState}
      data-frame-seq={stream.frameSeq ?? 'none'}
      data-frame-revision={stream.frameRevision ?? 'none'}
      data-last-frame-at={stream.lastFrameAt ?? 'none'}
      data-last-frame-fresh={stream.live ? 'true' : 'false'}
      data-interactive={interactive ? 'true' : 'false'}
      data-viewport-owner={stream.isOwner ? 'self' : (stream.owner ?? 'none')}
      data-viewport-revision={stream.viewportRevision ?? 'none'}
      data-viewport-width={stream.effectiveViewport?.width ?? 'none'}
      data-viewport-height={stream.effectiveViewport?.height ?? 'none'}
      data-viewport-mobile={stream.effectiveMobile === null ? 'unknown' : String(stream.effectiveMobile)}
      data-viewer-count={stream.viewerCount ?? 'unknown'}
      data-agent-held={stream.agentHeld ? 'true' : 'false'}
      data-viewport-transitioning={stream.transitioning ? 'true' : 'false'}
      data-control-available={stream.controlAvailable ? 'true' : 'false'}
      data-offer-width={view.w || 'none'}
      data-offer-height={view.h || 'none'}
      data-offer-mobile={mobilePreference ? 'true' : 'false'}
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
      <span className="browser-frame-status" role="status" aria-live="polite" aria-atomic="true">
        {statusText}
      </span>
      {showPlaceholder && (
        <div className="browser-frame-loading" aria-hidden="true">
          <span className="browser-frame-glyph">
            <CrIcon name="browser" />
          </span>
          <span className="cr-kicker">{statusText}</span>
        </div>
      )}
      {showControl && (
        <button
          type="button"
          className={`browser-frame-control${stream.isOwner ? ' owner' : ''}`}
          title={controlLabel}
          aria-label={controlLabel}
          aria-pressed={stream.isOwner === true}
          disabled={controlDisabled}
          onPointerDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={stream.isOwner ? stream.release : stream.claim}
        >
          <CrIcon name={stream.isOwner ? 'check' : 'select'} />
        </button>
      )}
      {frameReady && (
        <span className={`browser-frame-live${showControl ? ' with-control' : ''}`} aria-hidden="true" />
      )}
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
            if (streaming) setStreamFrameLoaded(true)
            else setLoaded(true)
          }}
          onError={() => undefined}
        />
      )}
    </div>
  )
}

const STREAM_STATUS_TEXT: Record<StreamSurfaceState, string> = {
  idle: 'browser stream idle',
  loading: 'loading live browser view',
  live: 'live browser view',
  stalled: 'live browser view stalled',
  fallback: 'browser preview',
  unavailable: 'live browser view unavailable'
}

function streamStatusText(
  surfaceState: StreamSurfaceState,
  stream: ReturnType<typeof useBrowserStream>
): string {
  if (surfaceState !== 'live' || !stream.controlAvailable) return STREAM_STATUS_TEXT[surfaceState]
  if (stream.agentHeld) return 'live browser view, agent driving; viewport fit held'
  if (stream.transitioning) return 'live browser view, viewport fit changing'
  if (stream.isOwner) return 'live browser view, fitted to this view'
  if (stream.owner === 'other') return 'live browser view, fitted to another view'
  return 'live browser view, viewport fit available'
}
