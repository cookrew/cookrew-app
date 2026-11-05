/**
 * A WEBSOCKET OVER PLAIN HTTP — for the one path that cannot carry one.
 *
 * cookrew.dev's relay forwards requests and event streams, never a WebSocket,
 * so the browser card's live view (browser-cast.ts, a WebSocket) was simply
 * unavailable to a phone on the relay — which, away from home on a tailnet
 * too slow to use, is every phone. This carries the same socket as two
 * things the relay does carry:
 *
 *   DOWN: an event stream, `GET /api/socket-bridge?path=<socket path>`. The
 *   Mac dials that socket on loopback (ws-client.ts) and sends `id` with a
 *   session id, then each socket message as `m`.
 *
 *   UP: `POST /api/socket-bridge/<id>` with `{ m: [...] }`, sent in order by
 *   the phone (renderer path/bridge-socket.ts).
 *
 * Only the browser card's stream may be bridged — the path is matched, not
 * trusted — and the socket authorises itself exactly as a direct one does, by
 * the pairing token in its own query. That query now exists only on this
 * machine: the phone sends the token as a header, because this route's URL goes
 * through cookrew.dev, and it is added here to the loopback dial. Both routes
 * sit behind the pairing gate like every /api route.
 */

import { randomUUID } from 'node:crypto'
import type http from 'node:http'
import { startSse } from './mobile-http'
import { RELAY_MARKER } from './canvas-bridge'
import { dialLoopbackSocket, type LoopbackSocket, type LoopbackSocketDeps } from './ws-client'

export const SOCKET_BRIDGE_PATH = '/api/socket-bridge'
/** Bridged sockets open at once; a phone has one browser card in view. */
export const SOCKET_BRIDGE_MAX = 8
/** Past this many bytes queued for the phone, stop reading the socket until the stream drains. */
export const SOCKET_BRIDGE_HIGH = 2 * 1024 * 1024
/**
 * THE BROWSER CARD'S FRAMES, PACED. On loopback nothing slows the screencast
 * down: an animated page measured 58 frames a second, 3 MB/s (2026-10-18) —
 * through the relay and over a phone's 5G that is the whole line. A bridged
 * socket sends at most one frame per SOCKET_BRIDGE_FRAME_MS, always the
 * newest (each is a whole JPEG, so a skipped one loses nothing), and holds it
 * while the stream still has more than SOCKET_BRIDGE_FRAME_BACKLOG queued.
 * Every other message goes at once.
 */
export const SOCKET_BRIDGE_FRAME_MS = 250
export const SOCKET_BRIDGE_FRAME_BACKLOG = 256 * 1024
/** A browser card's screencast frame: each one is the whole picture. */
export const isBrowserFrame = (text: string): boolean => text.startsWith('{"t":"frame"')
/** Messages per POST, and characters per message: input and viewport control are small. */
export const SOCKET_BRIDGE_POST_MESSAGES = 64
export const SOCKET_BRIDGE_MESSAGE_MAX = 64 * 1024

/** The paths that may be bridged: the browser card's live stream and nothing else. */
const BRIDGEABLE = /^\/api\/browser\/[^/?#]+\/stream(?:\?[^#]*)?$/

export interface SocketBridgeDeps {
  readonly port?: number
  readonly dial?: (deps: LoopbackSocketDeps) => LoopbackSocket
  readonly max?: number
}

export interface SocketBridge {
  /**
   * Open a bridged socket on this response; false when the path is not
   * bridgeable or the bridge is full. `credential` is the token this request
   * presented, for a path that does not carry its own.
   */
  readonly open: (path: string, response: http.ServerResponse, credential?: string | null) => boolean
  /** Messages from the phone; false for a session that is not open. */
  readonly post: (id: string, messages: readonly string[]) => boolean
  readonly size: () => number
}

export const bridgeablePath = (path: string): boolean => BRIDGEABLE.test(path)

/** The socket's own query, for the dial on loopback. A path that brought a token keeps it. */
const withCredential = (path: string, credential: string | null | undefined): string => {
  if (!credential || /[?&]token=/.test(path)) return path
  return `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(credential)}`
}

export const createSocketBridge = (deps: SocketBridgeDeps = {}): SocketBridge => {
  const sessions = new Map<string, LoopbackSocket>()
  const max = deps.max ?? SOCKET_BRIDGE_MAX

  const open = (path: string, response: http.ServerResponse, credential?: string | null): boolean => {
    if (!bridgeablePath(path) || sessions.size >= max) return false
    const send = startSse(response)
    const id = randomUUID()
    let paused = false
    let ended = false
    let heldFrame: string | null = null
    let frameTimer: ReturnType<typeof setTimeout> | null = null
    let lastFrameAt = 0
    const flushFrame = (): void => {
      frameTimer = null
      if (ended || heldFrame === null) return
      if (response.writableLength > SOCKET_BRIDGE_FRAME_BACKLOG) {
        frameTimer = setTimeout(flushFrame, SOCKET_BRIDGE_FRAME_MS / 5)
        return
      }
      send('m', heldFrame)
      heldFrame = null
      lastFrameAt = Date.now()
    }
    const end = (): void => {
      if (ended) return
      ended = true
      if (frameTimer !== null) clearTimeout(frameTimer)
      heldFrame = null
      sessions.delete(id)
      upstream.close()
      if (!response.writableEnded) response.end()
    }
    const upstream: LoopbackSocket = (deps.dial ?? dialLoopbackSocket)({
      port: deps.port ?? 8639,
      path: withCredential(path, credential),
      headers: { [RELAY_MARKER]: '1' },
      onOpen: () => send('id', { id }),
      onMessage: (text) => {
        if (isBrowserFrame(text)) {
          heldFrame = text
          if (frameTimer === null) {
            frameTimer = setTimeout(flushFrame, Math.max(0, lastFrameAt + SOCKET_BRIDGE_FRAME_MS - Date.now()))
          }
          return
        }
        send('m', text)
        if (!paused && response.writableLength > SOCKET_BRIDGE_HIGH) {
          paused = true
          upstream.pause()
          response.once('drain', () => {
            paused = false
            upstream.resume()
          })
        }
      },
      onClose: end
    })
    sessions.set(id, upstream)
    response.on('close', end)
    return true
  }

  const post = (id: string, messages: readonly string[]): boolean => {
    const upstream = sessions.get(id)
    if (!upstream) return false
    for (const message of messages) upstream.send(message)
    return true
  }

  return { open, post, size: () => sessions.size }
}
