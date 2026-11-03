import { UseOverlay } from './use/UseOverlay'
import { hasNativeWebview } from './api'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CrIcon } from './icons'
import {
  FRAME_POLL_MS,
  createFramePoller,
  fitContain,
  frameSrc,
  shouldPollFrame
} from './browser-frame'
import {
  buttonName,
  emptyTouchGesture,
  fieldAt,
  keyMsg,
  pasteMsg,
  frameSource,
  inputWithFrameSeq,
  mobileViewportPreference,
  modsOf,
  moveMsg,
  pinchMsg,
  pinchScaleFromWheel,
  pointerMsg,
  releaseTouchGesture,
  streamSurfaceState,
  updateTouchGesture,
  viewScale,
  viewToFramePoint,
  wheelDeltaPx,
  wheelMsg,
  type CastInputMsg,
  type FieldMode,
  type StreamSurfaceState,
  type StreamTouchPointer
} from './browser-stream'
import { useBrowserStream } from './useBrowserStream'
import { thumbStore, useThumb } from './activity-thumb-store'
import { handOffBlob, shouldHandOff } from './browser-poster'
import { useRemoteKeyboard } from './useRemoteKeyboard'
import { FramePainter } from './frame-painter'
import { createInputPump } from './input-pump'
import { RemoteKeyBar } from './RemoteKeyBar'
import { readClipboardText, writeClipboardLater, writeClipboardText } from './clipboard'

/** A touch that moved less than this (view px), and let go sooner than TAP_MS, is a tap. */
const TAP_SLOP_PX = 12
const TAP_MS = 650
/** The page's own focus may raise the keyboard this long after a tap (Android allows it; iOS ignores it). */
const FOCUS_RAISE_WINDOW_MS = 2500
/** Right after a raise, a stale "nothing focused" report must not close it again. */
const RAISE_GRACE_MS = 700
/** How long a Copy waits for the page to say what it copied. */
const COPY_WAIT_MS = 1500
const CTRL = 2

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
  fallback = 'thumb',
  actions
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
  /**
   * Page-level actions (open in browser) joined to the frame's own controls in
   * one floating cluster — the parent owns them because it knows the active
   * tab's url.
   */
  actions?: React.ReactNode
}): React.JSX.Element {
  const [seq, setSeq] = useState(0) // /thumb cache-buster (fallback mode)
  const [loaded, setLoaded] = useState(false)
  const [streamFrameLoaded, setStreamFrameLoaded] = useState(false)
  const [view, setView] = useState({ w: 0, h: 0 })
  const [natural, setNatural] = useState({ w: 0, h: 0 })
  // Read at mount, not after: the first viewport offer must already say phone or desktop.
  const [coarsePointer, setCoarsePointer] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
  )
  /** The canvas holds a picture from this open (it survives a reconnect). */
  const [hasPicture, setHasPicture] = useState(false)
  const [pixelRatio, setPixelRatio] = useState(() => window.devicePixelRatio)
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const paintedFrameSeq = useRef<number | null>(null)
  /**
   * THE CARD'S OWN PICTURE, read here for two reasons and fetched for neither.
   * It is the POSTER under the status chip while the stream has no decoded
   * frame (connecting, stalled, unavailable — over the relay, always); and it
   * is where the last painted live frame goes at zoom-out, so the card keeps
   * the picture the owner was just looking at instead of the poll's last
   * guess (browser-poster.ts).
   */
  const poster = useThumb(browserId)
  /** The last painted live frame's JPEG: the card's picture at zoom-out. */
  const lastPaintedRef = useRef<Blob | null>(null)
  const wasOpenRef = useRef(open)
  const mobilePreference = mobileViewportPreference(view.w, coarsePointer)
  // A fine pointer has a keyboard: its keys come as keys, not a soft keyboard's input.
  const desktopInput = !coarsePointer
  // Only the app itself asks for its display's pixel ratio (crisp on a Retina
  // Mac, at no network cost): a laptop on the relay would pull 4x the bytes.
  const scale = hasNativeWebview() && desktopInput ? viewScale(pixelRatio) : 1
  const stream = useBrowserStream(
    browserId,
    open,
    streamEnabled,
    desktopStreamToken,
    {
      width: view.w,
      height: view.h,
      mobile: mobilePreference,
      ...(scale > 1 ? { scale } : {})
    },
    // A touch viewer asks where the page's text fields are, so a tap on one
    // raises the keyboard (page-fields.ts).
    { watchFields: !desktopInput }
  )
  const streaming = frameSource(stream.status) === 'stream'

  // Observers still see and drive the shared frame. The viewport owner controls
  // layout fit only; input requires a decoded, live frame at the current revision.
  const frameReady = streaming && stream.live && stream.hasFrame && streamFrameLoaded
  // A use card whose device refuses input (a Mac nobody may drive, a camera)
  // is watched only: no pointer handlers that would send into a void.
  const interactive = frameReady && stream.canDrive && (stream.deviceStatus?.input ?? true)
  const sendFrameInput = useCallback((msg: CastInputMsg): void => {
    const frameSeq = paintedFrameSeq.current
    if (frameSeq !== null) stream.send(inputWithFrameSeq(msg, frameSeq))
  }, [stream.send])
  // Keyboard bridge: the stream is a picture, so a hidden field takes the keys.
  // Desktop: focused by the first click into the page. Phone: the ⌨ button
  // focuses it within the tap gesture (the only way iOS shows the keyboard).
  const kbd = useRemoteKeyboard(stream.send, desktopInput ? 'desktop' : 'touch')
  const kbdRef = useRef(kbd)
  kbdRef.current = kbd
  const tapStart = useRef<{ x: number; y: number; at: number } | null>(null)
  const lastTapAt = useRef(0)
  const raisedAt = useRef(0)
  const [fieldMode, setFieldMode] = useState<FieldMode>('text')
  /** A short word on the frame: "Copied", "Nothing selected". */
  const [note, setNote] = useState<string | null>(null)
  /** A copy this phone could not write without a tap (iOS), offered as one. */
  const [localOffer, setLocalOffer] = useState<string | null>(null)
  const copyOffer = localOffer ?? stream.copyOffer
  useEffect(() => {
    if (note === null) return
    const timer = setTimeout(() => setNote(null), 1800)
    return () => clearTimeout(timer)
  }, [note])

  useEffect(() => {
    // The zoom-out EDGE: the last painted live frame becomes the card's
    // picture — once, here, never per frame. Read before the reset below
    // forgets it.
    if (shouldHandOff({ wasOpen: wasOpenRef.current, open, painted: lastPaintedRef.current !== null })) {
      handOffBlob(thumbStore, browserId, lastPaintedRef.current as Blob)
    }
    wasOpenRef.current = open
    lastPaintedRef.current = null
    paintedFrameSeq.current = null
    setStreamFrameLoaded(false)
    setHasPicture(false)
    if (!open) {
      setLoaded(false)
      setNatural({ w: 0, h: 0 })
    }
  }, [open, browserId])

  // Unmounted while open — the layer took the frame down with the zoom, so
  // the edge above never ran. Same hand-off, from the cleanup.
  useEffect(
    () => () => {
      if (wasOpenRef.current && lastPaintedRef.current !== null) {
        handOffBlob(thumbStore, browserId, lastPaintedRef.current)
      }
    },
    [browserId]
  )

  useEffect(() => {
    paintedFrameSeq.current = null
    setStreamFrameLoaded(false)
  }, [streaming, stream.frameRevision])

  // THE PAINTER: frames go from the stream to the canvas without React.
  // Only the frame's size and "painted at this revision" ever re-render.
  const { subscribeFrames, latestFrame, receipt } = stream
  useEffect(() => {
    const canvas = canvasRef.current
    if (!open || !canvas) return
    const painter = new FramePainter(canvas, {
      onPainted: (frame) => {
        receipt(frame.seq)
        paintedFrameSeq.current = frame.seq
        lastPaintedRef.current = frame.blob
        const box = boxRef.current
        if (box) {
          // Probe-facing, set here rather than rendered: per frame, never a render.
          box.dataset.frameSeq = String(frame.seq)
          box.dataset.lastFrameAt = String(Date.now())
        }
        setNatural((current) =>
          current.w === frame.width && current.h === frame.height ? current : { w: frame.width, h: frame.height }
        )
        setStreamFrameLoaded(true)
        setHasPicture(true)
      },
      onSkipped: receipt
    })
    const pending = latestFrame()
    if (pending) painter.push(pending)
    const unsubscribe = subscribeFrames((frame) => painter.push(frame))
    return () => {
      unsubscribe()
      painter.dispose()
    }
  }, [open, browserId, subscribeFrames, latestFrame, receipt])

  // A display change (the window moved to another screen, a zoom) re-asks for
  // that one's pixel ratio; the query is re-armed on every ratio it reports.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(`(resolution: ${pixelRatio}dppx)`)
    const update = (): void => setPixelRatio(window.devicePixelRatio)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [pixelRatio])

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
    // Commit on the NEXT frame, not inside the observation cycle. setView here
    // re-renders and relays out the frame, which the observer then sees as a
    // fresh resize before the cycle closes — "ResizeObserver loop completed
    // with undelivered notifications", once per frame while the overlay rect
    // tracks a zoom. It converged (commit no-ops on an unchanged size) but paid
    // an extra layout pass every frame of the animation to get there.
    let frame = 0
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (rect) commit(rect.width, rect.height)
        else measure()
      })
    })
    ro.observe(el)
    measure()
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
    }
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

  // Both sources report their pixel size — the stream's on the canvas, the
  // thumb's via the <img> — used as the letterbox + input-coord basis.
  const fit = fitContain(natural.w, natural.h, view.w, view.h)

  // Headless: the live canvas, else the card's picture as the poster, else
  // nothing. The legacy flag-off phone keeps its own /thumb poll while open.
  // Reconnecting keeps the last picture: a dropped line is a chip, not a blank card.
  const holdingFrame = stream.reconnecting && hasPicture
  const canvasShown = (streaming || holdingFrame) && hasPicture
  const imgSrc =
    streaming || holdingFrame
      ? null
      : fallback === 'thumb'
        ? open
          ? frameSrc(browserId, seq)
          : null
        : (poster ?? null)
  // In stream mode the placeholder shows until the view is genuinely live, so a
  // frozen frame reads as "connecting…", not an interactive surface. Headless
  // with a poster: the picture shows and the status chip says the state — the
  // glyph would only cover the one thing worth looking at.
  const showPlaceholder = holdingFrame
    ? false
    : streaming
      ? !frameReady && !(stream.deviceStatus !== null && hasPicture)
      : fallback === 'loading' ? poster === undefined : !loaded
  const surfaceState = streamSurfaceState({
    open,
    status: stream.status,
    frameLoaded: streamFrameLoaded,
    live: stream.live,
    fallback
  })
  // A use card's device that is offline on purpose is not "loading": say what it is.
  const statusText =
    stream.deviceStatus?.state === 'offline' && !stream.live
      ? 'device offline'
      : stream.deviceStatus?.state === 'connecting' && !stream.live
        ? 'connecting to the device'
        : streamStatusText(surfaceState, stream)
  const showControl = streaming && stream.controlAvailable
  const controlDisabled = stream.agentHeld || stream.transitioning
  const controlLabel = stream.agentHeld
    ? 'Viewport fit is held while the agent is driving'
    : stream.transitioning
      ? 'Browser viewport fit is changing'
      : stream.isOwner
        ? 'Release viewport fit'
        : 'Fit browser to this view'

  // THE PAGE'S FOCUS, on a phone: a field that loses focus closes the keyboard
  // a tap on it raised; a field the page focuses itself, right after a tap,
  // raises it (Android lets a focus that close to a gesture show the keyboard).
  const { subscribeFields } = stream
  useEffect(() => {
    if (desktopInput) return
    let closing: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeFields((fields) => {
      const keys = kbdRef.current
      if (fields.focus.editable) {
        if (closing) clearTimeout(closing)
        closing = null
        setFieldMode(fields.focus.mode)
        if (!keys.open && Date.now() - lastTapAt.current < FOCUS_RAISE_WINDOW_MS) {
          keys.raise({ mode: fields.focus.mode, auto: true })
          raisedAt.current = Date.now()
        }
        return
      }
      if (!keys.open || !keys.auto || Date.now() - raisedAt.current < RAISE_GRACE_MS) return
      if (closing) clearTimeout(closing)
      closing = setTimeout(() => {
        closing = null
        if (kbdRef.current.auto) kbdRef.current.close()
      }, 250)
    })
    return () => {
      unsubscribe()
      if (closing) clearTimeout(closing)
    }
  }, [desktopInput, subscribeFields])

  // ---- clipboard, both ways ----
  /** Copy what is selected on the page onto THIS device, written inside the tap (clipboard.ts). */
  const copyFromPage = (): void => {
    const copied = stream.expectCopy(COPY_WAIT_MS)
    stream.send(keyMsg('c', 'KeyC', CTRL))
    void writeClipboardLater(copied).then(({ text, ok }) => {
      if (ok) setNote('Copied')
      else if (text) setLocalOffer(text)
      else setNote('Nothing selected')
    })
  }
  /** This device's clipboard into the page's field, as a paste the page sees. */
  const pasteIntoPage = (): void => {
    void readClipboardText().then((text) => {
      const msg = text ? pasteMsg(text) : null
      if (msg) stream.send(msg)
      else setNote(text === null ? 'This phone will not share its clipboard here' : 'The clipboard is empty')
    })
  }
  const takeCopyOffer = (): void => {
    const text = copyOffer
    if (text === null) return
    void writeClipboardText(text).then((ok) => setNote(ok ? 'Copied' : 'Could not copy'))
    setLocalOffer(null)
    stream.clearCopyOffer()
  }

  /**
   * A TAP ON A TEXT FIELD RAISES THE KEYBOARD. Decided here, synchronously, in
   * the touch's own handler — the only place iOS will show a keyboard for a
   * focus — against where the page last said its fields are.
   */
  /** A touch on the frame's own controls (or the bar, portaled but still a React child) is not a tap on the page. */
  const onControl = (e: React.TouchEvent): boolean =>
    e.target instanceof Element && e.target.closest('button, textarea, .remote-keybar') !== null
  const onTouchStart = (e: React.TouchEvent): void => {
    if (onControl(e)) {
      tapStart.current = null
      return
    }
    const touch = e.touches.length === 1 ? e.touches[0] : null
    tapStart.current = touch ? { x: touch.clientX, y: touch.clientY, at: Date.now() } : null
  }
  const onTouchEnd = (e: React.TouchEvent): void => {
    const start = tapStart.current
    tapStart.current = null
    if (!interactive || desktopInput || !start || e.touches.length > 0 || e.changedTouches.length !== 1) return
    const touch = e.changedTouches[0]
    if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > TAP_SLOP_PX || Date.now() - start.at > TAP_MS) return
    lastTapAt.current = Date.now()
    const point = framePointAt(touch.clientX, touch.clientY)
    const fields = stream.latestFields()
    if (!point || !fields || fields.revision !== stream.frameRevision) return
    const field = fieldAt(fields, point)
    if (!field) return
    const r = boxRef.current?.getBoundingClientRect()
    setFieldMode(field.mode)
    kbd.raise({ mode: field.mode, auto: true, at: r ? { x: touch.clientX - r.left, y: touch.clientY - r.top } : undefined })
    raisedAt.current = Date.now()
  }

  // ---- input forwarding (stream mode only): map view point → FRAME px, then send
  // the compact `t`-tagged message; Forge maps FRAME px → page px + whitelists. ----
  const touchGesture = useRef(emptyTouchGesture())
  const mousePointerId = useRef<number | null>(null)
  const mouseLastPoint = useRef<{ x: number; y: number } | null>(null)
  const mouseButton = useRef<number>(0)
  // Moves, wheels and pinch steps arrive faster than a frame; one of each goes
  // per animation frame, and a click flushes what is pending before it.
  const [pump] = useState(() => createInputPump(sendFrameInput))
  pump.retarget(sendFrameInput)
  useEffect(() => () => pump.cancel(), [pump])

  // If freshness disappears mid-gesture, release every remote contact before
  // input is disabled so Chromium is never left with a stuck mouse or touch.
  useEffect(() => {
    if (interactive) return
    pump.cancel()
    const touches = touchGesture.current
    const touchRelease = releaseTouchGesture(touches)
    touchGesture.current = emptyTouchGesture()
    for (const contact of touches.contacts) {
      if (boxRef.current?.hasPointerCapture?.(contact.pointerId)) {
        boxRef.current.releasePointerCapture(contact.pointerId)
      }
    }
    if (touchRelease) sendFrameInput(touchRelease.message)

    const pointerId = mousePointerId.current
    mousePointerId.current = null
    if (pointerId !== null && boxRef.current?.hasPointerCapture?.(pointerId)) {
      boxRef.current.releasePointerCapture(pointerId)
    }
    if (pointerId !== null && mouseLastPoint.current) {
      sendFrameInput(pointerMsg('up', mouseLastPoint.current, 1, { button: buttonName(mouseButton.current) }))
    }
  }, [interactive, sendFrameInput, pump])

  const framePointAt = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const box = boxRef.current
    if (!box || natural.w <= 0) return null
    const r = box.getBoundingClientRect()
    return viewToFramePoint(clientX - r.left, clientY - r.top, fit, natural.w, natural.h)
  }
  const framePoint = (e: React.PointerEvent): { x: number; y: number } | null => framePointAt(e.clientX, e.clientY)
  const touchPoint = (e: React.PointerEvent): StreamTouchPointer | null => {
    const point = framePoint(e)
    return point ? { pointerId: e.pointerId, ...point } : null
  }
  /** Desktop: the keys follow the click, with the IME's window where the click was. */
  const takeKeys = (e: React.PointerEvent): void => {
    if (!desktopInput) return
    const r = boxRef.current?.getBoundingClientRect()
    kbd.focusAt(r ? e.clientX - r.left : 0, r ? e.clientY - r.top : 0)
  }
  const onPointerDown = (e: React.PointerEvent): void => {
    if (!interactive) return
    if (e.pointerType === 'touch') {
      if (mousePointerId.current !== null) return
      const point = touchPoint(e)
      if (!point) return
      const update = updateTouchGesture(touchGesture.current, 'start', point)
      if (!update) return // At most two active touch pointers.
      e.preventDefault()
      // No focus move: the key field keeps the keyboard up while the page is tapped.
      touchGesture.current = update.state
      e.currentTarget.setPointerCapture(e.pointerId)
      sendFrameInput(update.message)
      return
    }

    if (mousePointerId.current !== null || touchGesture.current.contacts.length > 0) return
    const point = framePoint(e)
    if (!point) return
    e.preventDefault()
    // A click mid-composition commits it where it was being typed, first —
    // never into the field the click is about to focus.
    kbd.endComposition()
    takeKeys(e)
    mousePointerId.current = e.pointerId
    mouseLastPoint.current = point
    mouseButton.current = e.button
    e.currentTarget.setPointerCapture(e.pointerId)
    pump.flush()
    // e.detail is the click multiplicity — a double-click carries 2 so the page
    // can select a word (3 = triple → select line/all).
    sendFrameInput(pointerMsg('down', point, e.detail, { button: buttonName(e.button), mods: modsOf(e) }))
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    if (!interactive) return
    if (touchGesture.current.contacts.some((contact) => contact.pointerId === e.pointerId)) {
      const point = touchPoint(e)
      if (!point) return
      const update = updateTouchGesture(touchGesture.current, 'move', point)
      if (!update) return
      touchGesture.current = update.state
      sendFrameInput(update.message)
      return
    }
    if (e.pointerType === 'touch') return
    const dragging = e.pointerId === mousePointerId.current
    // Not pressed: a HOVER, so menus open, links underline and tooltips show.
    if (!dragging && mousePointerId.current !== null) return
    const point = framePoint(e)
    if (!point) return
    if (dragging) mouseLastPoint.current = point
    pump.move(moveMsg(point, dragging ? e.buttons : 0, modsOf(e)))
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    const contact = touchGesture.current.contacts.find((point) => point.pointerId === e.pointerId)
    if (contact) {
      const point = touchPoint(e) ?? contact
      const contacts = touchGesture.current.contacts
      const update = updateTouchGesture(touchGesture.current, 'end', point)
      if (update) {
        touchGesture.current = update.state
        sendFrameInput(update.message)
      }
      for (const active of contacts) {
        if (e.currentTarget.hasPointerCapture?.(active.pointerId)) {
          e.currentTarget.releasePointerCapture(active.pointerId)
        }
      }
      return
    }

    if (e.pointerId !== mousePointerId.current) return
    mousePointerId.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    const point = framePoint(e) ?? mouseLastPoint.current
    pump.flush()
    if (point) {
      sendFrameInput(pointerMsg('up', point, e.detail, { button: buttonName(mouseButton.current), mods: modsOf(e) }))
    }
  }
  /**
   * Scroll is forwarded to the remote page, so the local surface must NOT also
   * scroll — which means preventDefault has to actually land.
   *
   * React registers `wheel` on its root as a PASSIVE listener, so calling
   * preventDefault from an onWheel prop is silently ignored and logs "Unable to
   * preventDefault inside passive event listener invocation" for every tick of
   * the wheel. This attaches the real thing with { passive: false } instead.
   *
   * Held in a ref and attached once: the handler closes over fit/natural/stream,
   * which change on almost every render, and re-registering a wheel listener
   * that often is its own problem.
   *
   * A TRACKPAD PINCH arrives as ctrl+wheel (Chromium's convention): it zooms
   * the page (Input.synthesizePinchGesture) instead of scrolling it — a ctrl
   * wheel forwarded as a wheel only scrolled. Two-finger swipes carry dx too.
   */
  const onWheelRef = useRef<(e: WheelEvent) => void>(() => {})
  onWheelRef.current = (e: WheelEvent): void => {
    if (!interactive) return
    const p = framePointAt(e.clientX, e.clientY)
    if (!p) return
    e.preventDefault()
    if (e.ctrlKey) {
      pump.pinch(p, pinchScaleFromWheel(e.deltaY))
      return
    }
    const { dx, dy } = wheelDeltaPx(e, view.h)
    pump.wheel(p, dx, dy, modsOf(e))
  }
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const onWheel = (e: WheelEvent): void => onWheelRef.current(e)
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div
      ref={boxRef}
      className={`browser-body browser-frame nodrag nowheel${interactive ? ' streaming' : ''}`}
      data-browser-id={browserId}
      data-stream-status={stream.status}
      data-stream-state={surfaceState}
      data-frame-revision={stream.frameRevision ?? 'none'}
      data-stream-line={stream.direct ? 'port' : 'socket'}
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
      tabIndex={interactive && desktopInput ? 0 : undefined}
      onPointerDown={interactive ? onPointerDown : undefined}
      onPointerMove={interactive ? onPointerMove : undefined}
      onPointerUp={interactive ? onPointerUp : undefined}
      onPointerCancel={interactive ? onPointerUp : undefined}
      onTouchStart={interactive && !desktopInput ? onTouchStart : undefined}
      onTouchEnd={interactive && !desktopInput ? onTouchEnd : undefined}
      // The page's own context menu, not the app's: a right click is the page's.
      onContextMenu={interactive ? (event) => event.preventDefault() : undefined}
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
      {/* One floating cluster, bottom-right OVER the page: translucent so it
          costs the browser no layout height at all — every pixel of the view
          stays the page's. */}
      {(showControl || interactive || actions) && (
        <div className="browser-frame-actions">
          {showControl && (
            <button
              type="button"
              className={`browser-frame-btn${stream.isOwner ? ' on' : ''}`}
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
          {interactive && !desktopInput && (
            <button
              type="button"
              className="browser-frame-btn"
              title="Copy what is selected on the page"
              aria-label="Copy what is selected on the page"
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={copyFromPage}
            >
              <span aria-hidden="true">⧉</span>
            </button>
          )}
          {interactive && !desktopInput && (
            <button
              type="button"
              className={`browser-frame-btn${kbd.open ? ' on' : ''}`}
              title={kbd.open ? 'Hide keyboard' : 'Show keyboard'}
              aria-label={kbd.open ? 'Hide keyboard' : 'Show keyboard'}
              aria-pressed={kbd.open}
              // Focus must happen in the tap gesture (onClick) for iOS to raise
              // the keyboard; stop pointer events reaching the drag handlers.
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={kbd.toggle}
            >
              <span aria-hidden="true">⌨</span>
            </button>
          )}
          {actions}
        </div>
      )}
      {/* Hidden keystroke capture — the desktop's after a click into the page,
          the phone's within the ⌨ gesture so its keyboard rises. Keys, IME
          compositions and pastes forward to the remote field (useRemoteKeyboard). */}
      <textarea
        ref={kbd.inputRef}
        className="browser-frame-keys"
        aria-hidden="true"
        tabIndex={-1}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onBeforeInput={kbd.onBeforeInput}
        onInput={kbd.onInput}
        onKeyDown={kbd.onKeyDown}
        onCompositionStart={kbd.onCompositionStart}
        onCompositionUpdate={kbd.onCompositionUpdate}
        onCompositionEnd={kbd.onCompositionEnd}
        onPaste={kbd.onPaste}
        onCopy={kbd.onCopy}
        onCut={kbd.onCut}
        onBlur={kbd.onBlur}
        style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, opacity: 0, border: 0, padding: 0, pointerEvents: 'none' }}
      />
      {!desktopInput && kbd.open && interactive && (
        <RemoteKeyBar
          composition={kbd.composition}
          mode={fieldMode}
          note={note}
          onPaste={pasteIntoPage}
          onCopy={copyFromPage}
          onSelectAll={() => stream.send(keyMsg('a', 'KeyA', CTRL))}
          onHide={kbd.close}
        />
      )}
      {copyOffer !== null && (
        <button
          type="button"
          className="browser-frame-copychip"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={takeCopyOffer}
        >
          Copied on the page · tap to copy here
        </button>
      )}
      {note !== null && !kbd.open && <span className="browser-frame-note" role="status">{note}</span>}
      {/* The live dot keeps the corner to itself now that the controls sit in
          the dock — nothing left up here to make room for. */}
      {frameReady && <span className="browser-frame-live" aria-hidden="true" />}
      <UseOverlay
        card={browserId}
        box={fit.width > 0 ? fit : null}
        status={stream.deviceStatus}
        reconnecting={stream.reconnecting}
      />
      {/* The live view: drawn by the painter, frame by frame, outside React. */}
      <canvas
        ref={canvasRef}
        className={`browser-frame-img browser-frame-canvas${canvasShown && !showPlaceholder ? ' ready' : ''}`}
        aria-hidden="true"
        style={
          canvasShown && fit.width > 0
            ? { width: fit.width, height: fit.height, left: fit.left, top: fit.top }
            : { width: 0, height: 0 }
        }
      />
      {imgSrc && (
        <img
          className={`browser-frame-img${showPlaceholder ? '' : ' ready'}`}
          src={imgSrc}
          alt=""
          draggable={false}
          style={
            fit.width > 0
              ? { width: fit.width, height: fit.height, left: fit.left, top: fit.top }
              : undefined
          }
          onLoad={(e) => {
            // The poster's / thumb's pixel size is the letterbox basis until a
            // live frame is painted (then the canvas's size is).
            const img = e.currentTarget
            if (img.naturalWidth > 0 && (img.naturalWidth !== natural.w || img.naturalHeight !== natural.h)) {
              setNatural({ w: img.naturalWidth, h: img.naturalHeight })
            }
            setLoaded(true)
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
