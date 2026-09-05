import http from 'node:http'
import { decodeFrame, encodeFrame, type RelayFrame } from '../shared/relay-frame'

/**
 * FRAMES BACK INTO REQUESTS — the desktop end of the canvas relay.
 *
 * canvas-link owns the two long streams; this owns what rides them. Each
 * `open` becomes a real HTTP request against the companion's OWN listener on
 * loopback, and its answer goes back as head/chunk/end. Nothing here decides
 * who may ask: the request lands on the same handler that answers on the LAN,
 * so the pairing gate, the admission ceremony and the workspace scope are
 * unchanged and unaware. THE RELAY ADDS NO AUTHORITY — it carries the asking.
 *
 * WHY 127.0.0.1:8639 AND NOT THE TLS PORT. The companion serves the whole app
 * on both, and the plaintext listener is the one that needs no certificate
 * dance from a client that is this process. Loopback plaintext is the same
 * trust boundary the desktop's own renderer already uses; what leaves the
 * machine is the relay's TLS, and (when the seal lands) the seal under it.
 *
 * WHY THE MARKER HEADER. `rendererSourceFor` gives loopback clients Vite's
 * live module graph — 159 requests and six levels of import waterfall — which
 * is the exact payload shape a relayed link cannot carry. Without the marker
 * every relayed phone would be served the dev graph in development and show
 * white. `x-cookrew-relay: 1` says "this peer is not really local", and it is
 * set HERE rather than inferred there because only this file knows it.
 *
 * THE FIRST REQUEST IS THE ADMISSION, and it is not special. `?open=&key=&
 * device=` rides through in the path exactly as it does over the LAN, so there
 * is one admission ceremony rather than two that drift apart.
 *
 * WHAT IT REFUSES: more than `maxOpen` exchanges at once, a request body over
 * the registry's own ceiling, and nothing else. Both refusals are `abort`
 * frames rather than dropped lines — a caller must learn its exchange is over.
 */

/** The companion's plaintext listener. Loopback, asserted rather than assumed. */
export const BRIDGE_HOST = '127.0.0.1'

/** Set by the bridge so the served renderer is the BUILT bundle, not Vite's graph. */
export const RELAY_MARKER = 'x-cookrew-relay'

/**
 * How much RAW body travels in one `chunk`.
 *
 * A frame is capped at a megabyte by the wire and base64 costs a third, so
 * 384 KB of bytes encodes to 512 KB of frame with room to spare. The registry
 * uses the same number coming the other way; they are the same constant for
 * the same reason and not by coincidence.
 */
export const BRIDGE_CHUNK = 384 * 1024

/** The registry will not send more than this, and neither will this accept it. */
export const BRIDGE_BODY_MAX = 4 * 1024 * 1024

/** Exchanges in flight at once. Beyond it, `abort{reason:'busy'}`. */
export const BRIDGE_MAX_OPEN = 64

/** One local answer, reduced to what the bridge moves. */
export interface BridgeResponse {
  readonly status: number
  readonly headers: Record<string, string>
  onData(listener: (chunk: Buffer) => void): void
  onEnd(listener: () => void): void
}

/** One local request in flight. */
export interface BridgeCall {
  write(body: Buffer): void
  end(): void
  destroy(): void
}

/**
 * How the bridge reaches the companion. Injectable so a test can point it at
 * a server it stood up itself — the default is exactly that, aimed at 8639.
 */
export type BridgeDialer = (
  input: { readonly method: string; readonly path: string; readonly headers: Record<string, string> },
  onResponse: (response: BridgeResponse) => void,
  onError: (error: Error) => void
) => BridgeCall

export interface CanvasBridge {
  /** One line off the downlink. Anything that is not an exchange is ignored. */
  readonly frame: (line: string) => void
  /** The line went away: every local request riding it is over. */
  readonly reset: () => void
  /** Exchanges in flight, for the health line and the tests. */
  readonly open: () => number
}

export interface CanvasBridgeDeps {
  /** Frames going up. canvas-link's `send`. */
  readonly send: (line: string) => void
  readonly dial?: BridgeDialer
  readonly maxOpen?: number
  readonly log?: (message: string) => void
}

/**
 * Several `Set-Cookie` travel as ONE header value with newlines between them,
 * because a frame's headers are a map and HTTP's are not. The registry splits
 * on exactly that and re-pins each cookie to the relay path.
 */
export const flattenHeaders = (headers: http.IncomingHttpHeaders): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) out[key] = value.join(key.toLowerCase() === 'set-cookie' ? '\n' : ', ')
    else out[key] = String(value)
  }
  return out
}

/** The default: the companion's own plaintext listener, on loopback. */
export const loopbackDialer =
  (port: number, host: string = BRIDGE_HOST): BridgeDialer =>
  (input, onResponse, onError) => {
    const request = http.request(
      {
        host,
        port,
        method: input.method,
        path: input.path,
        headers: {
          ...input.headers,
          // The server builds its URL from this, so it must be present and
          // parseable — and it must be OURS, never whatever a caller sent.
          host: `${host}:${port}`,
          [RELAY_MARKER]: '1'
        }
      },
      (response) => {
        // A paused stream: nothing is read until the consumer subscribes,
        // which it does synchronously inside this call.
        response.on('error', onError)
        onResponse({
          status: response.statusCode ?? 502,
          headers: flattenHeaders(response.headers),
          onData: (listener) => void response.on('data', (chunk: Buffer) => listener(chunk)),
          onEnd: (listener) => void response.on('end', listener)
        })
      }
    )
    request.on('error', onError)
    return {
      write: (body) => void request.write(body),
      end: () => request.end(),
      destroy: () => request.destroy()
    }
  }

/** Every exchange this desktop is answering right now. */
interface Exchange {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string>
  /** The reserved seal, carried and never read. Absent when nobody sealed. */
  readonly sealed?: string
  readonly body: readonly Buffer[]
  readonly bytes: number
}

export const createCanvasBridge = (deps: CanvasBridgeDeps): CanvasBridge => {
  const dial = deps.dial ?? loopbackDialer(8639)
  const maxOpen = deps.maxOpen ?? BRIDGE_MAX_OPEN
  const log = deps.log ?? ((): void => undefined)

  /** Requests whose body is still arriving. */
  const arriving = new Map<string, Exchange>()
  /** Local calls in flight, so the caller hanging up stops the desktop working. */
  const calls = new Map<string, BridgeCall>()

  const send = (frame: RelayFrame): void => deps.send(encodeFrame(frame))

  const abort = (id: string, reason: string): void => {
    arriving.delete(id)
    calls.get(id)?.destroy()
    calls.delete(id)
    send({ t: 'abort', id, reason })
  }

  /**
   * The answer, streamed. The head goes out the moment it arrives and every
   * burst is written as it lands — buffering here would turn the companion's
   * event stream into a transcript, which is the one thing this must not do.
   */
  const answer = (id: string, exchange: Exchange): void => {
    const seal = exchange.sealed === undefined ? {} : { sealed: exchange.sealed }
    const call = dial(
      { method: exchange.method, path: exchange.path, headers: exchange.headers },
      (response) => {
        send({ t: 'head', id, status: response.status, headers: response.headers, ...seal })
        response.onData((chunk) => {
          // ≤ 384 KB of RAW bytes per frame: a single read off a fast local
          // socket can be larger, and one oversized frame is refused by the
          // decoder at the other end rather than truncated.
          for (let at = 0; at < chunk.byteLength; at += BRIDGE_CHUNK) {
            send({
              t: 'chunk',
              id,
              data: chunk.subarray(at, at + BRIDGE_CHUNK).toString('base64'),
              ...seal
            })
          }
        })
        response.onEnd(() => {
          calls.delete(id)
          send({ t: 'end', id })
        })
      },
      (error) => {
        // The companion failing is OURS, and it must not take the line with
        // it: one bad request would otherwise drop every other exchange.
        log(`canvas bridge: ${exchange.method} ${exchange.path} failed: ${error.message}`)
        abort(id, 'companion-failed')
      }
    )
    calls.set(id, call)
    if (exchange.bytes > 0) call.write(Buffer.concat(exchange.body as Buffer[]))
    call.end()
  }

  return {
    open: () => arriving.size + calls.size,

    reset: () => {
      for (const call of calls.values()) call.destroy()
      calls.clear()
      arriving.clear()
    },

    frame: (line) => {
      const frame = decodeFrame(line)
      // An unparseable message is not a frame and gets no answer: replying to
      // one would tell whoever sent it that something is listening.
      if (!frame) return
      switch (frame.t) {
        case 'open': {
          if (arriving.size + calls.size >= maxOpen) {
            log(`canvas bridge: refused ${frame.path}, ${maxOpen} exchanges already open`)
            send({ t: 'abort', id: frame.id, reason: 'busy' })
            return
          }
          arriving.set(frame.id, {
            method: frame.method,
            path: frame.path,
            headers: frame.headers,
            ...(frame.sealed === undefined ? {} : { sealed: frame.sealed }),
            body: [],
            bytes: 0
          })
          return
        }
        case 'body': {
          const held = arriving.get(frame.id)
          // A body for an exchange that is not open — a late frame after an
          // abort — is not an error worth answering.
          if (!held) return
          const bytes = Buffer.from(frame.data, 'base64')
          const size = held.bytes + bytes.byteLength
          if (size > BRIDGE_BODY_MAX) {
            abort(frame.id, 'body-too-large')
            return
          }
          const next: Exchange = { ...held, body: [...held.body, bytes], bytes: size }
          if (frame.done !== true) {
            arriving.set(frame.id, next)
            return
          }
          arriving.delete(frame.id)
          answer(frame.id, next)
          return
        }
        case 'end':
        case 'abort': {
          // THE CALLER HUNG UP — a closed tab, a lost network, a phone that
          // walked out of range. Stopping the local request is what ends an
          // event stream rather than leaking it for the life of the app.
          arriving.delete(frame.id)
          calls.get(frame.id)?.destroy()
          calls.delete(frame.id)
          return
        }
        default:
          return
      }
    }
  }
}
