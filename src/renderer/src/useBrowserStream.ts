import { useCallback, useEffect, useRef, useState } from 'react'
import { hasNativeWebview, isRemoteMode } from './api'
import { authStore } from './auth-gate'
import {
  clampViewport,
  frameIsFresh,
  inputWithRevision,
  nextStreamStatus,
  parseStreamMessage,
  streamCanDrive,
  streamInputAllowed,
  streamOrigin,
  streamSupported,
  streamUrl,
  viewportControlMsg,
  type CastInputMsg,
  type StreamClient,
  type StreamEvent,
  type StreamStatus,
  type ViewportControlKind,
  type ViewportOwner,
  type ViewportPreference,
  type ViewportSize
} from './browser-stream'

/** No first frame within this long after the socket opens -> use the renderer fallback. */
const FIRST_FRAME_TIMEOUT_MS = 4000
const VIEWPORT_REPORT_DEBOUNCE_MS = 200

/** No frame for this long -> treat the view as NOT live (frozen), input OFF. */
export const FRAME_STALE_MS = 1200

/** The current renderable frame, viewport ownership, and input sender. */
export interface BrowserStream {
  status: StreamStatus
  frameUrl: string | null
  frameSeq: number | null
  frameRevision: number | null
  lastFrameAt: number | null
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
  /** Stable current frame permits input; decode/freshness is view-owned. */
  canDrive: boolean
  send: (msg: CastInputMsg) => void
  claim: () => void
  release: () => void
}

function currentClient(): StreamClient {
  if (isRemoteMode()) return 'remote'
  if (hasNativeWebview()) return 'desktop'
  return 'demo'
}

function measuredViewport(viewport: ViewportPreference): boolean {
  return viewport.width > 0 && viewport.height > 0
}

/**
 * One WebSocket viewer for the node-owned browser. The measured browser-frame
 * box is reported separately from the stream image so the server can keep one
 * sticky viewport owner while every observer receives the same frame.
 */
export function useBrowserStream(
  browserId: string,
  open: boolean,
  enabled: boolean,
  desktopToken: string | null,
  viewport: ViewportPreference
): BrowserStream {
  const client = currentClient()
  const viewportReady = measuredViewport(viewport)
  const [status, setStatus] = useState<StreamStatus>('idle')
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [frameSeq, setFrameSeq] = useState<number | null>(null)
  const [frameRevision, setFrameRevision] = useState<number | null>(null)
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null)
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

  const wsRef = useRef<WebSocket | null>(null)
  const gotFrameRef = useRef(false)
  const warnedRef = useRef(false)
  const liveRef = useRef(false)
  const lastFrameAtRef = useRef(0)
  const frameRevisionRef = useRef<number | null>(null)
  const viewportRevisionRef = useRef<number | null>(null)
  const agentHeldRef = useRef(false)
  const transitioningRef = useRef(false)
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

  const sendViewportControl = useCallback(
    (kind: ViewportControlKind): void => {
      const ws = wsRef.current
      const size = viewportRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (kind !== 'release' && !measuredViewport(size)) return
      ws.send(JSON.stringify(viewportControlMsg(kind, size, size.mobile)))
    },
    []
  )

  const claim = useCallback((): void => {
    sendViewportControl('claim')
  }, [sendViewportControl])

  const release = useCallback((): void => {
    sendViewportControl('release')
  }, [sendViewportControl])

  useEffect(() => {
    if (!open) {
      setStatus('idle')
      setFrameUrl(null)
      setFrameSeq(null)
      setFrameRevision(null)
      setLastFrameAt(null)
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
      frameRevisionRef.current = null
      viewportRevisionRef.current = null
      liveRef.current = false
      agentHeldRef.current = false
      transitioningRef.current = false
      return
    }

    warnedRef.current = false
    gotFrameRef.current = false
    lastFrameAtRef.current = 0
    frameRevisionRef.current = null
    viewportRevisionRef.current = null
    liveRef.current = false
    agentHeldRef.current = false
    transitioningRef.current = false
    setStatus('idle')
    setFrameUrl(null)
    setFrameSeq(null)
    setFrameRevision(null)
    setLastFrameAt(null)
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

    if (!enabled) {
      advance('disabled')
      return
    }
    if (!viewportReady) return
    if (!streamSupported(typeof WebSocket !== 'undefined', client)) {
      advance('unsupported')
      return
    }
    if (client === 'desktop' && !desktopToken) {
      advance('error')
      return
    }

    let disposed = false
    let failed = false
    let ws: WebSocket | null = null
    let deadline: ReturnType<typeof setTimeout> | null = null
    let staleTimer: ReturnType<typeof setInterval> | null = null

    const sendControl = (kind: ViewportControlKind): void => {
      const size = viewportRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (kind !== 'release' && !measuredViewport(size)) return
      ws.send(JSON.stringify(viewportControlMsg(kind, size, size.mobile)))
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
      try {
        ws?.close()
      } catch {
        // already closing
      }
    }

    const adoptViewportRevision = (revision: number): void => {
      if (viewportRevisionRef.current === revision) return
      viewportRevisionRef.current = revision
      setViewportRevision(revision)
      if (frameRevisionRef.current === revision) return
      frameRevisionRef.current = null
      lastFrameAtRef.current = 0
      liveRef.current = false
      setFrameUrl(null)
      setFrameSeq(null)
      setFrameRevision(null)
      setLastFrameAt(null)
      setLive(false)
    }

    const connect = (): void => {
      advance('connect')
      const size = viewportRef.current
      const w = clampViewport(size.width)
      const h = clampViewport(size.height)
      try {
        ws = new WebSocket(
          streamUrl(
            streamOrigin(window.location.origin, client),
            browserId,
            w,
            h,
            client === 'desktop' ? desktopToken : null,
            // The phone's pairing token rides as a stream ticket; the desktop
            // presents its per-process secret instead (v4 §4).
            client === 'desktop' ? null : authStore().token()
          )
        )
      } catch {
        fail('error')
        return
      }
      wsRef.current = ws

      deadline = setTimeout(() => {
        if (!gotFrameRef.current) fail('error')
      }, FIRST_FRAME_TIMEOUT_MS)

      staleTimer = setInterval(() => {
        if (!disposed && !frameIsFresh(lastFrameAtRef.current, Date.now(), FRAME_STALE_MS)) {
          liveRef.current = false
          setLive(false)
        }
      }, 400)

      ws.onopen = (): void => {
        advance('open')
        sendControl(document.hidden ? 'release' : 'offer')
      }
      ws.onerror = (): void => fail('error')
      ws.onclose = (): void => fail('close')
      ws.onmessage = (ev: MessageEvent): void => {
        if (disposed || failed) return
        const msg = parseStreamMessage(ev.data)
        if (!msg) return
        if (msg.kind === 'error') {
          console.error(`[browser-stream] server error for ${browserId}: ${msg.msg}`)
          fail('error')
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
          setEffectiveViewport({ width: msg.width, height: msg.height })
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

        const revision = msg.revision ?? viewportRevisionRef.current ?? 0
        if (viewportRevisionRef.current === null) adoptViewportRevision(revision)
        if (revision !== viewportRevisionRef.current) return
        if (msg.deviceWidth && msg.deviceHeight) {
          setEffectiveViewport({ width: msg.deviceWidth, height: msg.deviceHeight })
        }
        if (typeof msg.mobile === 'boolean') setEffectiveMobile(msg.mobile)
        const receivedAt = Date.now()
        frameRevisionRef.current = revision
        setFrameUrl(msg.src)
        setFrameSeq(msg.seq)
        setFrameRevision(revision)
        setLastFrameAt(receivedAt)
        lastFrameAtRef.current = receivedAt
        liveRef.current = true
        setLive(true)
        if (!gotFrameRef.current) {
          gotFrameRef.current = true
          if (deadline) {
            clearTimeout(deadline)
            deadline = null
          }
          advance('firstFrame')
        }
      }
    }
    connect()

    return () => {
      disposed = true
      liveRef.current = false
      if (deadline) clearTimeout(deadline)
      if (staleTimer) clearInterval(staleTimer)
      if (ws?.readyState === WebSocket.OPEN) sendControl('release')
      if (ws) ws.onopen = ws.onerror = ws.onclose = ws.onmessage = null
      try {
        ws?.close()
      } catch {
        // already closing
      }
      if (wsRef.current === ws) wsRef.current = null
    }
  }, [browserId, open, enabled, desktopToken, advance, viewportReady, client])

  // Report the actual browser-frame content box without reconnecting the socket.
  useEffect(() => {
    if (!open || !enabled || !viewportReady) return
    const timer = setTimeout(() => {
      if (!document.hidden) sendViewportControl('offer')
    }, VIEWPORT_REPORT_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [viewport.width, viewport.height, viewport.mobile, open, enabled, viewportReady, sendViewportControl])

  useEffect(() => {
    if (!open || !enabled) return
    const reportVisibility = (): void =>
      sendViewportControl(document.hidden ? 'release' : 'offer')
    document.addEventListener('visibilitychange', reportVisibility)
    return () => document.removeEventListener('visibilitychange', reportVisibility)
  }, [open, enabled, sendViewportControl])

  const send = useCallback((msg: CastInputMsg): void => {
    const ws = wsRef.current
    const revision = frameRevisionRef.current
    if (
      ws &&
      ws.readyState === WebSocket.OPEN &&
      revision !== null &&
      streamInputAllowed(msg, {
        live: liveRef.current,
        agentHeld: agentHeldRef.current,
        transitioning: transitioningRef.current,
        frameRevision: revision,
        viewportRevision: viewportRevisionRef.current
      })
    ) {
      ws.send(JSON.stringify(inputWithRevision(msg, revision)))
    }
  }, [])

  const canDrive = streamCanDrive({
    live,
    agentHeld,
    transitioning,
    frameRevision,
    viewportRevision
  })

  return open
    ? {
        status,
        frameUrl,
        frameSeq,
        frameRevision,
        lastFrameAt,
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
        canDrive,
        send,
        claim,
        release
      }
    : {
        status: 'idle',
        frameUrl: null,
        frameSeq: null,
        frameRevision: null,
        lastFrameAt: null,
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
        canDrive: false,
        send,
        claim,
        release
      }
}
