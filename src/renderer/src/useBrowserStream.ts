import { useCallback, useEffect, useRef, useState } from 'react'
import { cookrew, hasNativeWebview, isRemoteMode } from './api'
import { apiPath } from './api-base'
import { tokenParam } from './auth-gate'
import { useDataPlaneRoute } from './use-data-plane'
import { openWebSocket } from './rtc-plane'
import type { UseStatus } from '../../shared/use-signal'
import { writeClipboardText } from './clipboard'
import {
  DESKTOP_STREAM_ORIGIN,
  clampViewport,
  frameIsFresh,
  inputWithRevision,
  nextStreamStatus,
  reconnectDelayMs,
  streamCanDrive,
  streamInputAllowed,
  streamPath,
  streamSupported,
  streamUrl,
  viewportControlMsg,
  type CastInputMsg,
  type StreamClient,
  type StreamEvent,
  type StreamMessage,
  type StreamStatus,
  type ViewportControlKind,
  type ViewportOwner,
  type ViewportPreference,
  type ViewportSize
} from './browser-stream'
import { portLine, socketLine, type StreamLine, type StreamLineHandlers } from './stream-line'
import type { PaintableFrame } from './frame-painter'

/** No first frame within this long after the line opens -> use the renderer fallback. */
const FIRST_FRAME_TIMEOUT_MS = 4000
/**
 * The phone's, longer: its socket may be bridged through the relay
 * (rtc-plane.ts · openWebSocket), where the first frame is a whole JPEG over
 * the slowest path the companion has.
 */
const REMOTE_FIRST_FRAME_TIMEOUT_MS = 10_000
const VIEWPORT_REPORT_DEBOUNCE_MS = 200

/** No frame for this long -> treat the view as NOT live (frozen), input OFF. */
export const FRAME_STALE_MS = 1200

/** One received frame, ready to paint (frame-painter.ts). */
export interface StreamFrame extends PaintableFrame {
  receivedAt: number
}

/**
 * The live view's state, without the frames. A frame is never React state: it
 * goes to subscribers (the canvas painter) and only the rare changes — first
 * frame, revision, liveness — re-render the view.
 */
export interface BrowserStream {
  status: StreamStatus
  /** A frame of the current viewport revision has arrived. */
  hasFrame: boolean
  frameRevision: number | null
  live: boolean
  effectiveViewport: ViewportSize | null
  effectiveMobile: boolean | null
  viewportRevision: number | null
  isOwner: boolean | null
  owner: ViewportOwner | null
  viewerCount: number | null
  agentHeld: boolean
  transitioning: boolean
  controlAvailable: boolean
  /** A use card's device: live, or offline and why (pixel-instance.ts). Null on a web card. */
  deviceStatus: UseStatus | null
  /** The line dropped and a new one is being dialled; the last picture stays on screen. */
  reconnecting: boolean
  /** The desktop's direct port to main, not a socket (browser-cast-ipc.ts). */
  direct: boolean
  /** Stable current frame permits input; decode/freshness is view-owned. */
  canDrive: boolean
  send: (msg: CastInputMsg) => void
  claim: () => void
  release: () => void
  /** Every frame of the current revision, as it arrives. */
  subscribeFrames: (listener: (frame: StreamFrame) => void) => () => void
  /** The newest frame not yet superseded, for a painter that subscribes late. */
  latestFrame: () => StreamFrame | null
  /** A frame was painted or skipped: over the port, that is what lets main send the next. */
  receipt: (seq: number) => void
}

function currentClient(): StreamClient {
  if (isRemoteMode()) return 'remote'
  if (hasNativeWebview()) return 'desktop'
  return 'demo'
}

function measuredViewport(viewport: ViewportPreference): boolean {
  return viewport.width > 0 && viewport.height > 0
}

function sameSize(a: ViewportSize | null, width: number, height: number): boolean {
  return a !== null && a.width === width && a.height === height
}

/**
 * One viewer for the node-owned browser. The measured browser-frame box is
 * reported separately from the stream image so the server can keep one sticky
 * viewport owner while every observer receives the same frame.
 */
export function useBrowserStream(
  browserId: string,
  open: boolean,
  enabled: boolean,
  desktopToken: string | null,
  viewport: ViewportPreference
): BrowserStream {
  const client = currentClient()
  const direct = client === 'desktop' && typeof cookrew().openBrowserStream === 'function'
  const planeRoute = useDataPlaneRoute()
  const viewportReady = measuredViewport(viewport)
  const [status, setStatus] = useState<StreamStatus>('idle')
  const [hasFrame, setHasFrame] = useState(false)
  const [frameRevision, setFrameRevision] = useState<number | null>(null)
  const [live, setLive] = useState(false)
  const [effectiveViewport, setEffectiveViewport] = useState<ViewportSize | null>(null)
  const [effectiveMobile, setEffectiveMobile] = useState<boolean | null>(null)
  const [viewportRevision, setViewportRevision] = useState<number | null>(null)
  const [isOwner, setIsOwner] = useState<boolean | null>(null)
  const [owner, setOwner] = useState<ViewportOwner | null>(null)
  const [viewerCount, setViewerCount] = useState<number | null>(null)
  const [agentHeld, setAgentHeld] = useState(false)
  const [transitioning, setTransitioning] = useState(false)
  const [controlAvailable, setControlAvailable] = useState(false)
  const [deviceStatus, setDeviceStatus] = useState<UseStatus | null>(null)
  const [reconnectNonce, setReconnectNonce] = useState(0)
  const [reconnecting, setReconnecting] = useState(false)
  const attemptRef = useRef(0)
  /** Set while a reconnect run is being prepared: it keeps the last picture instead of blanking the card. */
  const keepFrameRef = useRef(false)

  const lineRef = useRef<StreamLine | null>(null)
  const gotFrameRef = useRef(false)
  const warnedRef = useRef(false)
  const liveRef = useRef(false)
  const hasFrameRef = useRef(false)
  const lastFrameAtRef = useRef(0)
  const frameRevisionRef = useRef<number | null>(null)
  const viewportRevisionRef = useRef<number | null>(null)
  const agentHeldRef = useRef(false)
  const transitioningRef = useRef(false)
  const latestFrameRef = useRef<StreamFrame | null>(null)
  const frameListenersRef = useRef(new Set<(frame: StreamFrame) => void>())
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport

  const advance = useCallback(
    (event: StreamEvent): void => {
      setStatus((prev) => {
        const next = nextStreamStatus(prev, event)
        if (
          next === 'fallback' &&
          prev !== 'fallback' &&
          event !== 'disabled' &&
          !warnedRef.current
        ) {
          warnedRef.current = true
          console.error(
            `[browser-stream] live stream unavailable for ${browserId} (${event}) - ` +
              'using the renderer fallback. Shared headless drive is OFF.'
          )
        }
        return next
      })
    },
    [browserId]
  )

  const sendViewportControl = useCallback((kind: ViewportControlKind): void => {
    const line = lineRef.current
    const size = viewportRef.current
    if (!line?.isOpen()) return
    if (kind !== 'release' && !measuredViewport(size)) return
    line.send(viewportControlMsg(kind, size, size.mobile, size.scale))
  }, [])

  const claim = useCallback((): void => sendViewportControl('claim'), [sendViewportControl])
  const release = useCallback((): void => sendViewportControl('release'), [sendViewportControl])

  const receipt = useCallback((seq: number): void => {
    const line = lineRef.current
    if (line?.direct && line.isOpen()) line.send({ t: 'painted', seq })
  }, [])

  const subscribeFrames = useCallback((listener: (frame: StreamFrame) => void): (() => void) => {
    const listeners = frameListenersRef.current
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  const latestFrame = useCallback((): StreamFrame | null => latestFrameRef.current, [])

  useEffect(() => {
    const forgetFrame = (): void => {
      latestFrameRef.current = null
      hasFrameRef.current = false
      frameRevisionRef.current = null
      setHasFrame(false)
      setFrameRevision(null)
    }
    if (!open) {
      setStatus('idle')
      forgetFrame()
      setLive(false)
      setEffectiveViewport(null)
      setEffectiveMobile(null)
      setViewportRevision(null)
      setIsOwner(null)
      setOwner(null)
      setViewerCount(null)
      setAgentHeld(false)
      setTransitioning(false)
      setControlAvailable(false)
      setDeviceStatus(null)
      setReconnecting(false)
      attemptRef.current = 0
      keepFrameRef.current = false
      viewportRevisionRef.current = null
      liveRef.current = false
      agentHeldRef.current = false
      transitioningRef.current = false
      return
    }
    const keepFrame = keepFrameRef.current
    keepFrameRef.current = false

    warnedRef.current = false
    gotFrameRef.current = false
    lastFrameAtRef.current = 0
    viewportRevisionRef.current = null
    liveRef.current = false
    agentHeldRef.current = false
    transitioningRef.current = false
    setStatus('idle')
    if (!keepFrame) {
      forgetFrame()
      setEffectiveViewport(null)
      setEffectiveMobile(null)
      setDeviceStatus(null)
    } else {
      // The painted picture stays on the canvas; the frame data is the old line's.
      latestFrameRef.current = null
      frameRevisionRef.current = null
    }
    setLive(false)
    setViewportRevision(null)
    setIsOwner(null)
    setOwner(null)
    setViewerCount(null)
    setAgentHeld(false)
    setTransitioning(false)
    setControlAvailable(false)

    if (!enabled) {
      advance('disabled')
      return
    }
    if (!viewportReady) return
    if (!streamSupported(typeof WebSocket !== 'undefined' || direct, client)) {
      advance('unsupported')
      return
    }
    if (client === 'desktop' && !direct && !desktopToken) {
      advance('error')
      return
    }

    let disposed = false
    let failed = false
    let line: StreamLine | null = null
    let deadline: ReturnType<typeof setTimeout> | null = null
    let staleTimer: ReturnType<typeof setInterval> | null = null
    let redial: ReturnType<typeof setTimeout> | null = null

    const sendControl = (kind: ViewportControlKind): void => {
      const size = viewportRef.current
      if (!line?.isOpen()) return
      if (kind !== 'release' && !measuredViewport(size)) return
      line.send(viewportControlMsg(kind, size, size.mobile, size.scale))
    }

    const fail = (event: 'error' | 'close'): void => {
      if (disposed || failed) return
      failed = true
      if (deadline) {
        clearTimeout(deadline)
        deadline = null
      }
      if (staleTimer) {
        clearInterval(staleTimer)
        staleTimer = null
      }
      liveRef.current = false
      setLive(false)
      advance(event)
      line?.close()
      // Dial again, by itself. The effect re-runs on the nonce; this run's
      // cleanup clears the timer if the card closes first.
      const attempt = attemptRef.current
      attemptRef.current = attempt + 1
      setReconnecting(true)
      redial = setTimeout(() => {
        if (disposed) return
        keepFrameRef.current = true
        setReconnectNonce((n) => n + 1)
      }, reconnectDelayMs(attempt))
    }

    const adoptViewportRevision = (revision: number): void => {
      if (viewportRevisionRef.current === revision) return
      viewportRevisionRef.current = revision
      setViewportRevision(revision)
      if (frameRevisionRef.current === revision) return
      frameRevisionRef.current = null
      lastFrameAtRef.current = 0
      liveRef.current = false
      latestFrameRef.current = null
      hasFrameRef.current = false
      setHasFrame(false)
      setFrameRevision(null)
      setLive(false)
    }

    const onFrame = (msg: Extract<StreamMessage, { kind: 'frame' }>): void => {
      const revision = msg.revision ?? viewportRevisionRef.current ?? 0
      if (viewportRevisionRef.current === null) adoptViewportRevision(revision)
      if (revision !== viewportRevisionRef.current) {
        // Not for this viewport: done with, so the port may send the next.
        if (line?.direct) line.send({ t: 'painted', seq: msg.seq })
        return
      }
      const width = msg.deviceWidth
      const height = msg.deviceHeight
      if (width && height) {
        setEffectiveViewport((prev) => (sameSize(prev, width, height) ? prev : { width, height }))
      }
      if (typeof msg.mobile === 'boolean') setEffectiveMobile(msg.mobile)
      const receivedAt = Date.now()
      lastFrameAtRef.current = receivedAt
      if (frameRevisionRef.current !== revision) {
        frameRevisionRef.current = revision
        setFrameRevision(revision)
      }
      if (!liveRef.current) {
        liveRef.current = true
        setLive(true)
      }
      if (!hasFrameRef.current) {
        hasFrameRef.current = true
        setHasFrame(true)
      }
      const frame: StreamFrame = {
        seq: msg.seq,
        revision,
        receivedAt,
        ...(msg.bytes ? { bytes: msg.bytes } : {}),
        ...(msg.src ? { src: msg.src } : {})
      }
      latestFrameRef.current = frame
      const listeners = frameListenersRef.current
      if (listeners.size === 0) {
        if (line?.direct) line.send({ t: 'painted', seq: frame.seq })
      } else {
        for (const listener of listeners) listener(frame)
      }
      if (!gotFrameRef.current) {
        gotFrameRef.current = true
        attemptRef.current = 0
        setReconnecting(false)
        if (deadline) {
          clearTimeout(deadline)
          deadline = null
        }
        advance('firstFrame')
      }
    }

    const onMessage = (msg: StreamMessage): void => {
      if (disposed || failed) return
      if (msg.kind === 'error') {
        console.error(`[browser-stream] server error for ${browserId}: ${msg.msg}`)
        fail('error')
        return
      }

      if (msg.kind === 'copy') {
        // The page's copy happened inside the card's own Chrome: put it on
        // this machine's clipboard, where the owner will paste it (page-copy.ts).
        void writeClipboardText(msg.text).then((ok) => {
          if (!ok) console.error(`[browser-stream] the page's copy could not reach the clipboard for ${browserId}`)
        })
        return
      }

      if (msg.kind === 'status') {
        // The server is answering for a device; an offline one sends no
        // frames on purpose, so the first-frame deadline does not apply.
        if (deadline) {
          clearTimeout(deadline)
          deadline = null
        }
        attemptRef.current = 0
        setReconnecting(false)
        setDeviceStatus(msg.status)
        return
      }

      if (msg.kind === 'ready') {
        if (msg.w > 0 && msg.h > 0) setEffectiveViewport({ width: msg.w, height: msg.h })
        if (typeof msg.mobile === 'boolean') setEffectiveMobile(msg.mobile)
        if (typeof msg.revision === 'number') adoptViewportRevision(msg.revision)
        // A revision+mobile ready identifies the arbitration-aware server;
        // wait for its immediately-following viewport-state before driving.
        if (typeof msg.revision === 'number' && typeof msg.mobile === 'boolean') {
          setControlAvailable(true)
        }
        return
      }

      if (msg.kind === 'control') {
        setEffectiveViewport((prev) => (sameSize(prev, msg.width, msg.height) ? prev : { width: msg.width, height: msg.height }))
        setEffectiveMobile(msg.mobile)
        adoptViewportRevision(msg.revision)
        agentHeldRef.current = msg.agentHeld
        transitioningRef.current = msg.transitioning
        setControlAvailable(true)
        setIsOwner(msg.isOwner)
        setOwner(msg.owner)
        setViewerCount(msg.viewerCount)
        setAgentHeld(msg.agentHeld)
        setTransitioning(msg.transitioning)
        return
      }

      onFrame(msg)
    }

    const connect = (): void => {
      advance('connect')
      const size = viewportRef.current
      const w = clampViewport(size.width)
      const h = clampViewport(size.height)
      const handlers: StreamLineHandlers = {
        onOpen: () => {
          if (disposed || failed) return
          advance('open')
          sendControl(document.hidden ? 'release' : 'offer')
        },
        onMessage,
        onClose: () => fail('close')
      }
      const openPort = direct ? cookrew().openBrowserStream : undefined
      try {
        if (openPort) {
          // THE DESKTOP DRAWS ITS OWN CHROME DIRECTLY: a port from main, JPEG
          // bytes, no socket and no token (browser-cast-ipc.ts).
          line = portLine(openPort, browserId, handlers)
        } else {
          // THE SOCKET FOLLOWS THE DATA PLANE, like every fetch does.
          //
          // A desktop without the port (an older preload) keeps its own route:
          // it is loaded from file:// or Vite, so it has no page origin to
          // speak of and reaches the companion server on its stable loopback
          // address. A phone composes through apiPath, which answers the relay
          // prefix or the Mac's own trusted origin depending on where the plane
          // is pointing right now.
          const socket =
            client === 'desktop'
              ? new WebSocket(streamUrl(DESKTOP_STREAM_ORIGIN, browserId, w, h, desktopToken))
              : // THE TOKEN RIDES THE URL, because `new WebSocket(...)` cannot
                // set a header — the same constraint EventSource has, answered
                // the same way. Without it the socket is an unauthenticated
                // stream, and the desktop now refuses those (browser-cast.ts).
                // On the direct link it rides a data channel (rtc-plane.ts).
                openWebSocket(tokenParam(apiPath(streamPath(browserId, w, h, null))))
          line = socketLine(socket, handlers)
        }
      } catch {
        fail('error')
        return
      }
      lineRef.current = line

      deadline = setTimeout(() => {
        if (!gotFrameRef.current) fail('error')
      }, client === 'desktop' ? FIRST_FRAME_TIMEOUT_MS : REMOTE_FIRST_FRAME_TIMEOUT_MS)

      staleTimer = setInterval(() => {
        if (!disposed && liveRef.current && !frameIsFresh(lastFrameAtRef.current, Date.now(), FRAME_STALE_MS)) {
          liveRef.current = false
          setLive(false)
        }
      }, 400)
    }
    connect()

    return () => {
      disposed = true
      liveRef.current = false
      if (redial) clearTimeout(redial)
      if (deadline) clearTimeout(deadline)
      if (staleTimer) clearInterval(staleTimer)
      if (line?.isOpen()) sendControl('release')
      line?.close()
      if (lineRef.current === line) lineRef.current = null
    }
    // planeRoute is a dependency and not an unused read: a switch onto the
    // LAN has to drop this socket and open the new one, and a socket is the
    // one connection that cannot re-read its own URL (plane-streams.ts).
  }, [browserId, open, enabled, desktopToken, advance, viewportReady, client, planeRoute, reconnectNonce, direct])

  // Report the actual browser-frame content box without reconnecting the line.
  useEffect(() => {
    if (!open || !enabled || !viewportReady) return
    const timer = setTimeout(() => {
      if (!document.hidden) sendViewportControl('offer')
    }, VIEWPORT_REPORT_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [viewport.width, viewport.height, viewport.mobile, viewport.scale, open, enabled, viewportReady, sendViewportControl])

  useEffect(() => {
    if (!open || !enabled) return
    const reportVisibility = (): void =>
      sendViewportControl(document.hidden ? 'release' : 'offer')
    document.addEventListener('visibilitychange', reportVisibility)
    return () => document.removeEventListener('visibilitychange', reportVisibility)
  }, [open, enabled, sendViewportControl])

  const send = useCallback((msg: CastInputMsg): void => {
    const line = lineRef.current
    const revision = frameRevisionRef.current
    if (
      line?.isOpen() &&
      revision !== null &&
      streamInputAllowed(msg, {
        live: liveRef.current,
        agentHeld: agentHeldRef.current,
        transitioning: transitioningRef.current,
        frameRevision: revision,
        viewportRevision: viewportRevisionRef.current
      })
    ) {
      line.send(inputWithRevision(msg, revision))
    }
  }, [])

  const canDrive = streamCanDrive({
    live,
    agentHeld,
    transitioning,
    frameRevision,
    viewportRevision
  })

  const shared = { direct, send, claim, release, subscribeFrames, latestFrame, receipt }
  return open
    ? {
        ...shared,
        status,
        hasFrame,
        frameRevision,
        live,
        effectiveViewport,
        effectiveMobile,
        viewportRevision,
        isOwner,
        owner,
        viewerCount,
        agentHeld,
        transitioning,
        controlAvailable,
        deviceStatus,
        reconnecting,
        canDrive
      }
    : {
        ...shared,
        status: 'idle',
        hasFrame: false,
        frameRevision: null,
        live: false,
        effectiveViewport: null,
        effectiveMobile: null,
        viewportRevision: null,
        isOwner: null,
        owner: null,
        viewerCount: null,
        agentHeld: false,
        transitioning: false,
        controlAvailable: false,
        deviceStatus: null,
        reconnecting: false,
        canDrive: false
      }
}
