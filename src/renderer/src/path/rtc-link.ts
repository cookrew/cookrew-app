/**
 * THE DIRECT LINK BY WEBRTC (round P1) — the companion's requests and event
 * streams, carried on one data channel to the Mac.
 *
 * The frames are the relay's own (shared/relay-frame.ts): `open`, `body`,
 * then `head`, `chunk`s and `end` back. The Mac runs the relay's bridge on
 * the channel (main/rtc-peer.ts), so a request here becomes the same
 * loopback request a relayed one does — the server cannot tell them apart,
 * and nothing about auth or routing is new. What is new is the path: no
 * name to resolve, no proxy to route it, no certificate authority, and the
 * DTLS fingerprint the link is checked against arrived over the relay's TLS.
 */

import { decodeFrame, encodeFrame, type RelayFrame } from '../../../shared/relay-frame'
import { socketLabel } from '../../../shared/rtc-socket-chunks'
import { RtcWebSocket, type SocketChannel } from './rtc-socket'

export const RTC_BRIDGE_LABEL = 'cookrew-bridge'
export const RTC_GATHER_MS = 1_500
/** From the answer to the Mac's first frame; past this the link is not there. */
export const RTC_OPEN_MS = 6_000
/**
 * Raw bytes per body frame going up. A data channel message past the peer's
 * limit throws (Safari's is far below the relay's 1 MiB frame), and 16 KB is
 * the size every browser takes — the Mac sends its chunks at the same size.
 */
export const RTC_BODY_CHUNK = 16 * 1024

/** Statuses whose Response may not carry a body. */
const BODILESS = new Set([101, 204, 205, 304])

export interface RtcLinkDeps {
  /** POST the offer over the current plane; the Mac's answer SDP, or null. */
  readonly offer: (sdp: string) => Promise<string | null>
  readonly peer?: () => RTCPeerConnection
  readonly gatherMs?: number
  readonly openMs?: number
}

export interface RtcRequest {
  readonly method: string
  /** A path on the Mac, `/api/...`, never a URL. */
  readonly path: string
  readonly headers: Record<string, string>
  readonly body?: Uint8Array | null
  readonly signal?: AbortSignal
}

export interface RtcLink {
  /** The Mac's address this link runs on, as the Mac named it. */
  readonly via: string
  readonly request: (request: RtcRequest) => Promise<Response>
  /** A WebSocket at a Mac path (`/api/...`), on a data channel of its own. */
  readonly openSocket: (path: string) => RtcWebSocket
  readonly isOpen: () => boolean
  readonly onClose: (cb: () => void) => () => void
  readonly close: () => void
}

const toBase64 = (bytes: Uint8Array): string => {
  let text = ''
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(text)
}

const fromBase64 = (data: string): Uint8Array => {
  const text = atob(data)
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i)
  return bytes
}

interface Exchange {
  readonly controller: ReadableStreamDefaultController<Uint8Array>
  readonly stream: ReadableStream<Uint8Array>
  readonly head: (response: Response) => void
  readonly fail: (error: Error) => void
  headed: boolean
}

const gathered = (pc: RTCPeerConnection, ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    const timer = setTimeout(resolve, ms)
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer)
        resolve()
      }
    })
  })

/** Open a link, or null when the Mac offers none or nothing connects in time. */
export const connectRtcLink = async (deps: RtcLinkDeps): Promise<RtcLink | null> => {
  const make = deps.peer ?? ((): RTCPeerConnection => new RTCPeerConnection({ iceServers: [] }))
  let pc: RTCPeerConnection
  try {
    pc = make()
  } catch {
    return null
  }
  const exchanges = new Map<string, Exchange>()
  const closers = new Set<() => void>()
  let closed = false
  let next = 0
  const channel = pc.createDataChannel(RTC_BRIDGE_LABEL, { ordered: true })

  const shut = (): void => {
    if (closed) return
    closed = true
    for (const exchange of exchanges.values()) exchange.fail(new Error('the direct link closed'))
    exchanges.clear()
    try {
      channel.close()
      pc.close()
    } catch {
      // Already down.
    }
    for (const cb of [...closers]) cb()
  }

  const send = (frame: RelayFrame): void => {
    if (closed || channel.readyState !== 'open') throw new Error('the direct link is not open')
    channel.send(encodeFrame(frame))
  }

  // Listened for from the start: on a LAN the Mac's first frame can arrive in
  // the same turn the answer goes in.
  let via: (name: string | null) => void = () => undefined
  const ready = new Promise<string | null>((resolve) => void (via = resolve))

  channel.addEventListener('message', (event) => {
    const frame = decodeFrame(String((event as MessageEvent).data))
    if (!frame) return
    if (frame.t === 'ready') return via(frame.name)
    if (!('id' in frame)) return
    const exchange = exchanges.get(frame.id)
    if (!exchange) return
    switch (frame.t) {
      case 'head': {
        exchange.headed = true
        const headers = new Headers(frame.headers)
        // The bridge asked for identity; a stray encoding would be raw bytes here.
        headers.delete('content-encoding')
        headers.delete('content-length')
        exchange.head(
          new Response(BODILESS.has(frame.status) ? null : exchange.stream, { status: frame.status, headers })
        )
        return
      }
      case 'chunk':
        exchange.controller.enqueue(fromBase64(frame.data))
        return
      case 'end':
        exchanges.delete(frame.id)
        try {
          exchange.controller.close()
        } catch {
          // A reader that went away first.
        }
        return
      case 'abort':
        exchanges.delete(frame.id)
        exchange.fail(new Error(`the Mac gave up: ${frame.reason}`))
        return
      default:
        return
    }
  })
  channel.addEventListener('close', () => {
    via(null)
    shut()
  })
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') shut()
  })

  try {
    await pc.setLocalDescription(await pc.createOffer())
    await gathered(pc, deps.gatherMs ?? RTC_GATHER_MS)
    const answer = await deps.offer(pc.localDescription?.sdp ?? '')
    if (answer === null) {
      shut()
      return null
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: answer })
  } catch {
    shut()
    return null
  }
  const timer = setTimeout(() => via(null), deps.openMs ?? RTC_OPEN_MS)
  const name = await ready
  clearTimeout(timer)
  if (name === null || closed) {
    shut()
    return null
  }

  const request = (input: RtcRequest): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const id = `r${(next += 1).toString(36)}`
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => void (controller = c),
        cancel: () => {
          if (!exchanges.delete(id)) return
          try {
            send({ t: 'end', id })
          } catch {
            // Link already down.
          }
        }
      })
      const exchange: Exchange = {
        controller,
        stream,
        headed: false,
        head: resolve,
        fail: (error) => {
          if (!exchange.headed) reject(error)
          else {
            try {
              controller.error(error)
            } catch {
              // Already errored or closed.
            }
          }
        }
      }
      exchanges.set(id, exchange)
      input.signal?.addEventListener('abort', () => {
        if (!exchanges.delete(id)) return
        exchange.fail(new DOMException('aborted', 'AbortError'))
        try {
          send({ t: 'end', id })
        } catch {
          // Link already down.
        }
      })
      try {
        send({
          t: 'open',
          id,
          method: input.method,
          path: input.path,
          headers: { ...input.headers, 'accept-encoding': 'identity' }
        })
        const body = input.body ?? new Uint8Array(0)
        let at = 0
        do {
          const slice = body.subarray(at, at + RTC_BODY_CHUNK)
          at += RTC_BODY_CHUNK
          send({ t: 'body', id, data: toBase64(slice), done: at >= body.length })
        } while (at < body.length)
      } catch (error) {
        exchanges.delete(id)
        reject(error)
      }
    })

  return {
    via: name,
    request,
    openSocket: (path) =>
      new RtcWebSocket(() => {
        if (closed) throw new Error('the direct link is closed')
        return pc.createDataChannel(socketLabel(path), { ordered: true }) as unknown as SocketChannel
      }),
    isOpen: () => !closed,
    onClose: (cb) => {
      closers.add(cb)
      return () => void closers.delete(cb)
    },
    close: shut
  }
}

/**
 * AN EVENTSOURCE OVER THE LINK — the shape every stream consumer here uses
 * (live-stream.ts · EventStreamLike, stream-http.ts): named events as
 * MessageEvents, `open` and `error`, `onerror`/`onopen`, `readyState`, and
 * `close()`. A stream that ends is an error with readyState CLOSED, which is
 * what makes the consumers reconnect.
 */
export class RtcEventSource extends EventTarget {
  readyState = 0
  onerror: ((event: Event) => void) | null = null
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  private readonly abort = new AbortController()

  constructor(link: RtcLink, path: string) {
    super()
    void this.run(link, path)
  }

  private emit(type: string, event: Event): void {
    this.dispatchEvent(event)
    if (type === 'error') this.onerror?.(event)
    else if (type === 'open') this.onopen?.(event)
    else if (type === 'message') this.onmessage?.(event as MessageEvent)
  }

  private fail(): void {
    if (this.readyState === 2) return
    this.readyState = 2
    this.emit('error', new Event('error'))
  }

  private async run(link: RtcLink, path: string): Promise<void> {
    try {
      const response = await link.request({
        method: 'GET',
        path,
        headers: { accept: 'text/event-stream' },
        signal: this.abort.signal
      })
      if (!response.ok || !response.body) return this.fail()
      if (this.readyState === 2) return
      this.readyState = 1
      this.emit('open', new Event('open'))
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let cut = buffer.search(/\r?\n\r?\n/)
        while (cut !== -1) {
          const block = buffer.slice(0, cut)
          buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '')
          this.dispatchBlock(block)
          cut = buffer.search(/\r?\n\r?\n/)
        }
      }
    } catch {
      // Falls through to the error below.
    }
    this.fail()
  }

  private dispatchBlock(block: string): void {
    let type = 'message'
    const data: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':') || line.length === 0) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'event') type = value
      else if (field === 'data') data.push(value)
    }
    if (data.length === 0 || this.readyState === 2) return
    this.emit(type, new MessageEvent(type, { data: data.join('\n') }))
  }

  close(): void {
    this.readyState = 2
    this.abort.abort()
  }
}
