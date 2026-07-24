import { useCallback, useEffect, useRef, useState } from 'react'
import { isRemoteMode } from './api'
import {
  clampViewport,
  nextStreamStatus,
  parseStreamMessage,
  streamSupported,
  streamUrl,
  type CastInputMsg,
  type StreamEvent,
  type StreamStatus
} from './browser-stream'

/** No first frame within this long after the socket opens → fall back to /thumb. */
const FIRST_FRAME_TIMEOUT_MS = 4000

/** No frame for this long → treat the view as NOT live (frozen), touch OFF. */
const FRAME_STALE_MS = 1200

/** The current renderable frame + the input sender, exposed to the view. */
export interface BrowserStream {
  status: StreamStatus
  /** Data URL of the latest frame (stream mode), or null before the first one. */
  frameUrl: string | null
  /**
   * True only while frames are ACTIVELY arriving (a frame within FRAME_STALE_MS).
   * Gates interactivity — a stalled/frozen frame must not look tappable.
   */
  live: boolean
  /** Forward a whitelisted input event to the desktop webview over the WS. */
  send: (msg: CastInputMsg) => void
}

/**
 * WebSocket screencast client (interactive-remote-browser-c). While the phone has
 * a browser OPEN, connect GET /api/browser/:id/stream, drive the status machine,
 * render the latest JPEG frame, and forward input. Ack/backpressure is SERVER-SIDE
 * (Forge's screencast-pace acks CDP on socket drain) — the client sends no acks.
 *
 * FEATURE-DETECTS (WebSocket + remote mode) and, on any unavailability
 * (unsupported, connect error, socket close, no first frame before the deadline),
 * transitions to 'fallback' — LOUDLY, never silent — so the caller renders the
 * static /thumb frame instead. Closing the socket on teardown lets Forge detach
 * the CDP debugger cleanly (mutually exclusive with DevTools).
 */
export function useBrowserStream(browserId: string, open: boolean): BrowserStream {
  const [status, setStatus] = useState<StreamStatus>('idle')
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [live, setLive] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const gotFrameRef = useRef(false)
  const warnedRef = useRef(false)
  const lastFrameAt = useRef(0)

  // Drive one status transition; log LOUDLY the first time we fall back.
  const advance = useCallback(
    (event: StreamEvent): void => {
      setStatus((prev) => {
        const next = nextStreamStatus(prev, event)
        if (next === 'fallback' && prev !== 'fallback' && !warnedRef.current) {
          warnedRef.current = true
          console.error(
            `[browser-stream] live stream unavailable for ${browserId} (${event}) — ` +
              'falling back to the static /thumb frame. Interactive drive is OFF.'
          )
        }
        return next
      })
    },
    [browserId]
  )

  useEffect(() => {
    if (!open) return
    warnedRef.current = false
    gotFrameRef.current = false
    lastFrameAt.current = 0
    setFrameUrl(null)
    setLive(false)

    if (!streamSupported(typeof WebSocket !== 'undefined', isRemoteMode())) {
      advance('unsupported')
      return
    }

    let disposed = false
    advance('connect')
    // Request a screencast sized to the phone viewport (Forge clamps 320..2048).
    const w = clampViewport(window.innerWidth || 800)
    const h = clampViewport(window.innerHeight || 1400)
    let ws: WebSocket
    try {
      ws = new WebSocket(streamUrl(window.location.origin, browserId, w, h))
    } catch {
      advance('error')
      return
    }
    wsRef.current = ws

    // No first frame in time (flag off / CDP attach failed / attach refused) → fall back.
    const deadline = setTimeout(() => {
      if (!disposed && !gotFrameRef.current) advance('error')
    }, FIRST_FRAME_TIMEOUT_MS)

    // Liveness: frames must keep ARRIVING for the view to stay interactive. If
    // they stall (occlusion throttle, network), drop live so touch turns off
    // and the placeholder returns instead of a frozen, tappable frame.
    const staleTimer = setInterval(() => {
      if (!disposed && Date.now() - lastFrameAt.current > FRAME_STALE_MS) setLive(false)
    }, 400)

    ws.onopen = (): void => advance('open')
    ws.onerror = (): void => advance('error')
    ws.onclose = (): void => advance('close')
    ws.onmessage = (ev: MessageEvent): void => {
      const msg = parseStreamMessage(ev.data)
      if (!msg) return
      if (msg.kind === 'error') {
        console.error(`[browser-stream] server error for ${browserId}: ${msg.msg}`)
        advance('error')
        return
      }
      if (msg.kind !== 'frame') return // 'ready' — connected, awaiting frames
      setFrameUrl(msg.src)
      lastFrameAt.current = Date.now()
      setLive(true)
      if (!gotFrameRef.current) {
        gotFrameRef.current = true
        advance('firstFrame')
      }
    }

    return () => {
      disposed = true
      clearTimeout(deadline)
      clearInterval(staleTimer)
      ws.onopen = ws.onerror = ws.onclose = ws.onmessage = null
      try {
        ws.close()
      } catch {
        // already closing
      }
      wsRef.current = null
    }
  }, [browserId, open, advance])

  const send = useCallback((msg: CastInputMsg): void => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }, [])

  return { status, frameUrl, live, send }
}
