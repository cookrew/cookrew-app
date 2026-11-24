import { useCallback, useEffect, useRef, useState } from 'react'
import { cookrew, hasNativeWebview, isRemoteMode } from './api'
import { apiPath } from './api-base'
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
  remoteReconnectDelayMs,
  streamCanDrive,
  streamInputAllowed,
  streamPath,
  streamSupported,
  streamUrl,
  viewportControlMsg,
  viewScale,
  type CastInputMsg,
  type StreamClient,
  type StreamEvent,
  type StreamFields,
  type StreamMessage,
  type StreamStatus,
  type ViewportControlKind,
  type ViewportOwner,
  type ViewportPreference,
  type ViewportSize
} from './browser-stream'
import { portLine, socketLine, type StreamLine, type StreamLineHandlers } from './stream-line'
import { BridgeWebSocket } from './path/bridge-socket'
import { CAST_STATS_EVERY_MS, CastStatsMeter, frameByteSize } from './cast-stats-meter'
import type { CastLine } from '../../shared/cast-stats'
import { budgetScale } from '../../shared/cast-viewport'
import { canDecodeCastVideo, CastVideoDecoder } from './cast-video-decoder'

/** An H.264 chunk's frame meta: what the decoder carries through to the picture it makes. */
type VideoMeta = Omit<Extract<StreamMessage, { kind: 'vframe' }>, 'kind' | 'chunk' | 'seq'>

/** A decoded H.264 picture and the size it stands for in frame pixels. */
interface VideoPicture {
  video: VideoFrame
  width: number
  height: number
}
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
/**
 * The relay's bridge, longer. Live gates input, and losing it releases whatever the
 * finger is doing, so a second of jitter cut swipes in half. That line watches its
 * own silence and holds aimed input while it is down (path/bridge-socket.ts); no
 * other line does, so the rest keep the short limit.
 */
export const REMOTE_FRAME_STALE_MS = 6000
/** Just under main's SOCKET_BRIDGE_RELEASE_MS, which counts from a little later. */
const VIEWPORT_LET_GO_MS = 2500

/**
 * A viewport ask at the scale this viewer should be drawn at. A phone asks for
 * its own screen's pixel ratio, up to the Mac's `scaleMax`, so its frames come
 * at the sharpness it shows them. The desktop keeps the scale it was given
 * (MobileBrowserFrame passes none: its frames stay 1x).
 */
export function viewportAsk(
  kind: ViewportControlKind,
  size: ViewportPreference,
  client: StreamClient,
  scaleMax: number
): ReturnType<typeof viewportControlMsg> {
  if (client === 'remote' && typeof window !== 'undefined') {
    // Held to the Mac's pixel budget here too, so the ask is what will be drawn.
    const max = Math.min(scaleMax, budgetScale(size.width, size.height))
    return viewportControlMsg(kind, size, size.mobile, window.devicePixelRatio, max)
  }
  return viewportControlMsg(kind, size, size.mobile, size.scale)
}

/** Which line a socket is, for the stats: the relay's bridge, a real WebSocket, or the direct data channel. */
export function socketKind(socket: object): CastLine {
  if (socket instanceof BridgeWebSocket) return 'relay'
  if (typeof WebSocket !== 'undefined' && socket instanceof WebSocket) return 'ws'
  return 'link'
}

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
  /** The picture has not changed: this seq now stands for the one on screen. */
  subscribeBeats: (listener: (seq: number) => void) => () => void
  /** The newest frame not yet superseded, for a painter that subscribes late. */
  latestFrame: () => StreamFrame | null
  /** A frame was painted or skipped: over the port, that is what lets main send the next. */
  receipt: (seq: number) => void
  /** Where the page's text fields are (only while watched), and every new report. */
  latestFields: () => StreamFieldsAt | null
  subscribeFields: (listener: (fields: StreamFieldsAt) => void) => () => void
  /**
   * The next copy the page makes, for up to `ms`; null when none comes. While
   * one is awaited the copy is the caller's to place (an iPhone needs it
   * written inside the tap that asked — clipboard.ts · writeClipboardLater).
   */
  expectCopy: (ms: number) => Promise<string | null>
  /** A page copy this device could not write by itself (no gesture): offered for a tap. */
  copyOffer: string | null
  clearCopyOffer: () => void
}

/** A field report and the viewport revision its FRAME px belong to. */
export interface StreamFieldsAt extends StreamFields {
  revision: number
}

export interface BrowserStreamOptions {
  /** A touch viewer: ask the page where its text fields are (page-fields.ts). */
  watchFields?: boolean
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
  viewport: ViewportPreference,
  options: BrowserStreamOptions = {}
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
  /**
   * Main never answered the port (a preload newer than the main process that
   * serves it, until the app restarts): the next dial takes the socket.
   */
  const portUnansweredRef = useRef(false)
  /** Set while a reconnect run is being prepared: it keeps the last picture instead of blanking the card. */
  const keepFrameRef = useRef(false)

  const lineRef = useRef<StreamLine | null>(null)
  /**
   * The most device scale the Mac lets this viewer ask for (its `ready`); 1
   * until it says, and from a Mac that never will. Kept across redials to the
   * same card, so a reconnect asks the right scale the first time.
   */
  const scaleMaxRef = useRef(1)
  /** This line's live-view numbers, reported to the Mac while a phone watches (cast-stats-meter.ts). */
  const meterRef = useRef<CastStatsMeter | null>(null)
  /** The line's H.264 decoder, while the Mac sends H.264 (cast-video-decoder.ts); null for JPEG. */
  const decoderRef = useRef<CastVideoDecoder<VideoMeta> | null>(null)
  const gotFrameRef = useRef(false)
  const warnedRef = useRef(false)
  const liveRef = useRef(false)
  const restingRef = useRef(false)
  const hasFrameRef = useRef(false)
  const lastFrameAtRef = useRef(0)
  const frameRevisionRef = useRef<number | null>(null)
  const viewportRevisionRef = useRef<number | null>(null)
  const agentHeldRef = useRef(false)
  const transitioningRef = useRef(false)
  const latestFrameRef = useRef<StreamFrame | null>(null)
  const frameListenersRef = useRef(new Set<(frame: StreamFrame) => void>())
  const beatListenersRef = useRef(new Set<(seq: number) => void>())
  /** The plane this view's line was opened on: a move keeps the picture while the line changes. */
  const routeRef = useRef(planeRoute)
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const watchFieldsRef = useRef(options.watchFields === true)
  watchFieldsRef.current = options.watchFields === true
  const latestFieldsRef = useRef<StreamFieldsAt | null>(null)
  const fieldListenersRef = useRef(new Set<(fields: StreamFieldsAt) => void>())
  const copyWaitersRef = useRef(new Set<(text: string | null) => void>())
  const [copyOffer, setCopyOffer] = useState<string | null>(null)

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
    line.send(viewportAsk(kind, size, client, scaleMaxRef.current))
  }, [client])

  const claim = useCallback((): void => sendViewportControl('claim'), [sendViewportControl])
  const release = useCallback((): void => sendViewportControl('release'), [sendViewportControl])

  const receipt = useCallback((seq: number): void => {
    meterRef.current?.paint(seq, Date.now())
    lineRef.current?.receipt(seq)
  }, [])

  const subscribeFrames = useCallback((listener: (frame: StreamFrame) => void): (() => void) => {
    const listeners = frameListenersRef.current
    listeners.add(listener)
    // An H.264 picture is not kept for a painter that comes late (latestFrame):
    // the Mac sends the picture again, whole, instead.
    if (listeners.size === 1 && decoderRef.current) lineRef.current?.send({ t: 'vkey' })
    return () => {
      listeners.delete(listener)
    }
  }, [])

  const subscribeBeats = useCallback((listener: (seq: number) => void): (() => void) => {
    const listeners = beatListenersRef.current
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  const latestFrame = useCallback((): StreamFrame | null => latestFrameRef.current, [])

  const latestFields = useCallback((): StreamFieldsAt | null => latestFieldsRef.current, [])
  const subscribeFields = useCallback((listener: (fields: StreamFieldsAt) => void): (() => void) => {
    const listeners = fieldListenersRef.current
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  const expectCopy = useCallback(
    (ms: number): Promise<string | null> =>
      new Promise((resolve) => {
        const waiters = copyWaitersRef.current
        const done = (text: string | null): void => {
          clearTimeout(timer)
          waiters.delete(done)
          resolve(text)
        }
        const timer = setTimeout(() => done(null), ms)
        waiters.add(done)
      }),
    []
  )
  const clearCopyOffer = useCallback((): void => setCopyOffer(null), [])

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
    // A move between planes is a new line under the same picture.
    const moved = routeRef.current !== planeRoute
    routeRef.current = planeRoute
    const keepFrame = keepFrameRef.current || (moved && hasFrameRef.current)
    keepFrameRef.current = false
    if (moved && keepFrame) setReconnecting(true)

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
    if (client === 'desktop' && (!direct || portUnansweredRef.current) && !desktopToken) {
      advance('error')
      return
    }

    latestFieldsRef.current = null
    let disposed = false
    let failed = false
    let line: StreamLine | null = null
    let deadline: ReturnType<typeof setTimeout> | null = null
    let staleTimer: ReturnType<typeof setInterval> | null = null
    let redial: ReturnType<typeof setTimeout> | null = null
    let statsTimer: ReturnType<typeof setInterval> | null = null
    let resumingSince = 0

    const sendControl = (kind: ViewportControlKind): void => {
      const size = viewportRef.current
      if (!line?.isOpen()) return
      if (kind !== 'release' && !measuredViewport(size)) return
      line.send(viewportAsk(kind, size, client, scaleMaxRef.current))
    }

    const stopStats = (): void => {
      if (statsTimer) clearInterval(statsTimer)
      statsTimer = null
      meterRef.current = null
    }

    /** The Mac sends H.264 from now on (cast-video.ts): a decoder for this line. */
    const startVideo = (): void => {
      if (decoderRef.current) return
      decoderRef.current = new CastVideoDecoder<VideoMeta>({
        onPicture: (decoded) => {
          if (disposed || failed) return decoded.frame.close()
          onFrame({ kind: 'frame', seq: decoded.seq, ...decoded.meta }, { video: decoded.frame, width: decoded.width, height: decoded.height })
        },
        askKey: () => line?.send({ t: 'vkey' }),
        ack: (n) => line?.send({ t: 'vack', n }),
        // This browser's decoder keeps failing: JPEG again, which the Mac confirms.
        giveUp: () => {
          decoderRef.current = null
          line?.send({ t: 'codecs', h264: false })
        }
      })
    }

    const stopVideo = (): void => {
      decoderRef.current?.close()
      decoderRef.current = null
    }

    /** A phone says how its view is doing every few seconds while it watches (cast-stats-meter.ts). */
    const startStats = (kind: CastLine): void => {
      if (client !== 'remote') return
      const meter = new CastStatsMeter(Date.now())
      meterRef.current = meter
      statsTimer = setInterval(() => {
        if (disposed || failed || document.hidden) return
        const size = viewportRef.current
        const asked = viewScale(window.devicePixelRatio, Math.min(scaleMaxRef.current, budgetScale(size.width, size.height)))
        const report = meter.report(Date.now(), kind, window.devicePixelRatio, asked, decoderRef.current ? 'h264' : 'jpeg')
        if (report && line?.isOpen()) line.send(report)
      }, CAST_STATS_EVERY_MS)
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
      stopStats()
      stopVideo()
      liveRef.current = false
      setLive(false)
      advance(event)
      // Only a port that was never answered: one main said goodbye on (a
      // replaced instance) is answered, and the next dial is a port again.
      if (line?.direct && !line.answered() && desktopToken) portUnansweredRef.current = true
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
      }, client === 'remote' ? remoteReconnectDelayMs(attempt) : reconnectDelayMs(attempt))
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

    /**
     * One picture for the painter: a JPEG frame off the line, or an H.264
     * chunk already decoded (`picture`, which whoever ends up holding it closes).
     */
    const onFrame = (msg: Extract<StreamMessage, { kind: 'frame' }>, picture?: VideoPicture): void => {
      const revision = msg.revision ?? viewportRevisionRef.current ?? 0
      if (viewportRevisionRef.current === null) adoptViewportRevision(revision)
      if (revision !== viewportRevisionRef.current) {
        // Not for this viewport: done with, so the line may send the next.
        picture?.video.close()
        line?.receipt(msg.seq)
        return
      }
      const width = msg.deviceWidth
      const height = msg.deviceHeight
      if (width && height) {
        setEffectiveViewport((prev) => (sameSize(prev, width, height) ? prev : { width, height }))
      }
      if (typeof msg.mobile === 'boolean') setEffectiveMobile(msg.mobile)
      const receivedAt = Date.now()
      // A chunk was counted when it arrived, before it was decoded.
      if (!picture) meterRef.current?.frame(msg.seq, frameByteSize(msg), receivedAt)
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
        ...(msg.src ? { src: msg.src } : {}),
        ...(picture ? { video: picture.video, width: picture.width, height: picture.height } : {}),
        ...(msg.scrollY !== undefined ? { scrollY: msg.scrollY } : {}),
        ...(msg.pageScaleFactor !== undefined ? { pageScale: msg.pageScaleFactor } : {})
      }
      // A decoded picture is the painter's to close, so it is never kept for a later one.
      latestFrameRef.current = picture ? null : frame
      const listeners = [...frameListenersRef.current]
      if (listeners.length === 0) {
        picture?.video.close()
        meterRef.current?.paint(frame.seq, Date.now())
        line?.receipt(frame.seq)
      } else if (picture && listeners.length > 1) {
        // Each painter closes what it is given: each gets its own.
        for (const listener of listeners) listener({ ...frame, video: picture.video.clone() })
        picture.video.close()
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

      if (msg.kind === 'same') {
        if (msg.revision !== undefined && msg.revision !== viewportRevisionRef.current) return
        lastFrameAtRef.current = Date.now()
        if (hasFrameRef.current && !liveRef.current) {
          liveRef.current = true
          setLive(true)
        }
        for (const listener of beatListenersRef.current) listener(msg.seq)
        return
      }

      if (msg.kind === 'video') {
        if (msg.codec) startVideo()
        else stopVideo()
        // An H.264 viewer on the relay may be sharper than a JPEG one (cast-tuning.ts).
        const scaleMax = msg.scaleMax ?? scaleMaxRef.current
        if (scaleMax !== scaleMaxRef.current) {
          scaleMaxRef.current = scaleMax
          if (client === 'remote' && !document.hidden) sendControl('offer')
        }
        return
      }

      if (msg.kind === 'vframe') {
        const decoder = decoderRef.current
        if (!decoder) return
        const arrivedAt = Date.now()
        meterRef.current?.frame(msg.seq, Math.floor((msg.chunk.data.length * 3) / 4), arrivedAt)
        lastFrameAtRef.current = arrivedAt
        const { kind: _kind, chunk, seq: _seq, ...meta } = msg
        decoder.push(chunk, meta)
        return
      }

      if (msg.kind === 'copy') {
        // The page's copy happened inside the card's own Chrome: put it on
        // this machine's clipboard, where the owner will paste it (page-copy.ts).
        const waiters = [...copyWaitersRef.current]
        if (waiters.length > 0) {
          // Asked for by a Copy tap, which places it itself.
          for (const waiter of waiters) waiter(msg.text)
          return
        }
        void writeClipboardText(msg.text).then((ok) => {
          if (ok) return
          // No gesture to write it with (an iPhone): offer it for a tap instead.
          if (client === 'remote') setCopyOffer(msg.text)
          else console.error(`[browser-stream] the page's copy could not reach the clipboard for ${browserId}`)
        })
        return
      }

      if (msg.kind === 'fields') {
        const fields: StreamFieldsAt = { revision: msg.revision, focus: msg.focus, fields: msg.fields }
        latestFieldsRef.current = fields
        for (const listener of fieldListenersRef.current) listener(fields)
        return
      }

      if (msg.kind === 'status') {
        // The server is answering for a device; an offline one sends no
        // frames on purpose, so the first-frame deadline does not apply.
        if (deadline) {
          clearTimeout(deadline)
          deadline = null
        }
        // A refusal comes with a shut door: the backoff has to keep growing through it.
        if (!(msg.status.state === 'offline' && msg.status.remote)) attemptRef.current = 0
        setReconnecting(false)
        setDeviceStatus(msg.status)
        restingRef.current = msg.status.state === 'resting'
        return
      }

      if (msg.kind === 'ready') {
        if (msg.w > 0 && msg.h > 0) setEffectiveViewport({ width: msg.w, height: msg.h })
        if (typeof msg.mobile === 'boolean') setEffectiveMobile(msg.mobile)
        if (typeof msg.revision === 'number') adoptViewportRevision(msg.revision)
        // The Mac says how sharp this viewer may be. A change is asked for at
        // once; the Mac folds it with the opening offer into one resize.
        const scaleMax = msg.scaleMax ?? 1
        if (scaleMax !== scaleMaxRef.current) {
          scaleMaxRef.current = scaleMax
          if (client === 'remote' && !document.hidden) sendControl('offer')
        }
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
          if (document.hidden) line?.send({ t: 'visibility', hidden: true })
          if (watchFieldsRef.current) line?.send({ t: 'watch-fields' })
          // A phone that can decode H.264 says so; the Mac decides (cast-video.ts).
          if (client === 'remote') {
            void canDecodeCastVideo().then((ok) => {
              if (ok && !disposed && !failed && line?.isOpen()) line.send({ t: 'codecs', h264: true })
            })
          }
        },
        onMessage,
        onClose: () => fail('close'),
        onResuming: (on) => {
          if (disposed || failed) return
          setReconnecting(on)
          // The Mac let the viewport go if this took a while; offering it back any
          // sooner is a viewport change for nothing.
          if (on) resumingSince = Date.now()
          else if (Date.now() - resumingSince >= VIEWPORT_LET_GO_MS && !document.hidden) sendControl('offer')
        }
      }
      const openPort = direct && !portUnansweredRef.current ? cookrew().openBrowserStream : undefined
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
              : // The credential is the opener's to add, because the plane
                // decides how: a direct socket's query, a data channel, or the
                // relay's header. Without one the desktop refuses the stream
                // (browser-cast.ts).
                openWebSocket(apiPath(streamPath(browserId, w, h, null)))
          line = socketLine(socket, handlers)
          startStats(socketKind(socket))
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
        const staleMs = line?.paced ? REMOTE_FRAME_STALE_MS : FRAME_STALE_MS
        // Coming back is one message, and on the relay a lost POST is gone: a page in
        // plain sight with no frames coming says it again.
        if (!disposed && !document.hidden && (restingRef.current || (liveRef.current && !frameIsFresh(lastFrameAtRef.current, Date.now(), staleMs)))) {
          line?.send({ t: 'visibility', hidden: false })
        }
        if (!disposed && liveRef.current && !frameIsFresh(lastFrameAtRef.current, Date.now(), staleMs)) {
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
      stopStats()
      stopVideo()
      if (line?.isOpen()) sendControl('release')
      line?.close()
      if (lineRef.current === line) lineRef.current = null
    }
    // planeRoute is a dependency and not an unused read: a switch onto the
    // LAN has to drop this socket and open the new one, and a socket is the
    // one connection that cannot re-read its own URL (plane-streams.ts).
  }, [browserId, open, enabled, desktopToken, advance, viewportReady, client, planeRoute, reconnectNonce, direct])

  // A viewer that starts or stops wanting the page's fields says so on the open line.
  useEffect(() => {
    const line = lineRef.current
    if (!open || !line?.isOpen()) return
    line.send({ t: options.watchFields === true ? 'watch-fields' : 'unwatch-fields' })
    if (options.watchFields !== true) latestFieldsRef.current = null
  }, [open, options.watchFields])

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
    const reportVisibility = (): void => {
      sendViewportControl(document.hidden ? 'release' : 'offer')
      // Said apart from the viewport: a viewer can release that and go on watching.
      lineRef.current?.send({ t: 'visibility', hidden: document.hidden })
    }
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
      meterRef.current?.input(Date.now())
    }
  }, [])

  const canDrive = streamCanDrive({
    live,
    agentHeld,
    transitioning,
    frameRevision,
    viewportRevision
  })

  const shared = {
    direct: direct && !portUnansweredRef.current,
    send,
    claim,
    release,
    subscribeFrames,
    subscribeBeats,
    latestFrame,
    receipt,
    latestFields,
    subscribeFields,
    expectCopy,
    copyOffer,
    clearCopyOffer
  }
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
