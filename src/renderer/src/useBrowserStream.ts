import { useCallback, useEffect, useRef, useState } from 'react'
import { hasNativeWebview, isRemoteMode } from './api'
import {
  clampViewport,
  frameIsFresh,
  nextStreamStatus,
  parseStreamMessage,
  streamOrigin,
  streamSupported,
  streamUrl,
  type CastInputMsg,
  type StreamClient,
  type StreamEvent,
  type StreamStatus
} from './browser-stream'

/** No first frame within this long after the socket opens → use the renderer fallback. */
const FIRST_FRAME_TIMEOUT_MS = 4000

/** No frame for this long → treat the view as NOT live (frozen), input OFF. */
export const FRAME_STALE_MS = 1200

/** The current renderable frame + the input sender, exposed to the view. */
export interface BrowserStream {
  status: StreamStatus
  /** Data URL of the latest frame (stream mode), or null before the first one. */
  frameUrl: string | null
  /** Sequence assigned by this viewer's server connection. */
  frameSeq: number | null
  /** Local receipt time of the latest real frame, or null before one arrives. */
  lastFrameAt: number | null
  /**
   * True only while frames are ACTIVELY arriving (a frame within FRAME_STALE_MS).
   * Gates interactivity — a stalled/frozen frame must not look tappable.
   */
  live: boolean
  /** Forward a whitelisted input event to the shared headless page over the WS. */
  send: (msg: CastInputMsg) => void
}

function currentClient(): StreamClient {
  if (isRemoteMode()) return 'remote'
  if (hasNativeWebview()) return 'desktop'
  return 'demo'
}

/**
 * WebSocket screencast client (interactive-remote-browser-c). While either the
 * desktop or phone has a browser OPEN, connect GET /api/browser/:id/stream,
 * drive the status machine, render the latest JPEG frame, and forward input.
 * Ack/backpressure is SERVER-SIDE — the client sends no acks.
 *
 * The caller resolves the main/remote feature capability first. This hook then
 * feature-detects WebSocket + eligible renderer and, on any unavailability
 * (unsupported, connect error, socket close, no first frame before the deadline),
 * transitions to 'fallback' — LOUDLY, never silent — so the caller renders its
 * honest fallback instead. Closing the socket on teardown detaches this
 * viewer without changing ownership of the node-owned Chromium instance.
 */
export function useBrowserStream(
  browserId: string,
  open: boolean,
  enabled: boolean,
  desktopToken: string | null
): BrowserStream {
  const [status, setStatus] = useState<StreamStatus>('idle')
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [frameSeq, setFrameSeq] = useState<number | null>(null)
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null)
  const [live, setLive] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const gotFrameRef = useRef(false)
  const warnedRef = useRef(false)
  const lastFrameAtRef = useRef(0)

  // Drive one status transition; log LOUDLY the first time we fall back.
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
            `[browser-stream] live stream unavailable for ${browserId} (${event}) — ` +
              'using the renderer fallback. Shared headless drive is OFF.'
          )
        }
        return next
      })
    },
    [browserId]
  )

  useEffect(() => {
    if (!open) {
      setStatus('idle')
      setFrameUrl(null)
      setFrameSeq(null)
      setLastFrameAt(null)
      setLive(false)
      return
    }
    warnedRef.current = false
    gotFrameRef.current = false
    lastFrameAtRef.current = 0
    setStatus('idle')
    setFrameUrl(null)
    setFrameSeq(null)
    setLastFrameAt(null)
    setLive(false)

    if (!enabled) {
      advance('disabled')
      return
    }

    const client = currentClient()
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
      setLive(false)
      advance(event)
      try {
        ws?.close()
      } catch {
        // already closing
      }
    }

    const connect = (): void => {
      advance('connect')
      // Request a screencast sized to this viewer (Forge clamps 320..2048).
      const w = clampViewport(window.innerWidth || 800)
      const h = clampViewport(window.innerHeight || 1400)
      try {
        ws = new WebSocket(
          streamUrl(
            streamOrigin(window.location.origin, client),
            browserId,
            w,
            h,
            client === 'desktop' ? desktopToken : null
          )
        )
      } catch {
        fail('error')
        return
      }
      wsRef.current = ws

      // No first frame in time (Chrome/CDP unavailable) → use the honest fallback.
      deadline = setTimeout(() => {
        if (!gotFrameRef.current) fail('error')
      }, FIRST_FRAME_TIMEOUT_MS)

      // Frames must keep ARRIVING for the view to stay interactive. A stalled
      // socket returns to the placeholder and releases any active pointer.
      staleTimer = setInterval(() => {
        if (!disposed && !frameIsFresh(lastFrameAtRef.current, Date.now(), FRAME_STALE_MS)) {
          setLive(false)
        }
      }, 400)

      ws.onopen = (): void => advance('open')
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
        if (msg.kind !== 'frame') return // 'ready' — connected, awaiting frames
        const receivedAt = Date.now()
        setFrameUrl(msg.src)
        setFrameSeq(msg.seq)
        setLastFrameAt(receivedAt)
        lastFrameAtRef.current = receivedAt
        setLive(true)
        if (!gotFrameRef.current) {
          gotFrameRef.current = true
          if (deadline) clearTimeout(deadline)
          advance('firstFrame')
        }
      }
    }
    connect()

    return () => {
      disposed = true
      if (deadline) clearTimeout(deadline)
      if (staleTimer) clearInterval(staleTimer)
      if (ws) ws.onopen = ws.onerror = ws.onclose = ws.onmessage = null
      try {
        ws?.close()
      } catch {
        // already closing
      }
      if (wsRef.current === ws) wsRef.current = null
    }
  }, [browserId, open, enabled, desktopToken, advance])

  const send = useCallback((msg: CastInputMsg): void => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }, [])

  // Effects clean up after paint; derive the closed state synchronously so a
  // just-collapsed pane cannot remain visually live or accept input.
  return open
    ? { status, frameUrl, frameSeq, lastFrameAt, live, send }
    : {
        status: 'idle',
        frameUrl: null,
        frameSeq: null,
        lastFrameAt: null,
        live: false,
        send
      }
}
