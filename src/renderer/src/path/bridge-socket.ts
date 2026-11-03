/**
 * A WEBSOCKET OVER PLAIN HTTP — the phone's end of main/socket-bridge.ts.
 *
 * The relay carries requests and event streams and never a WebSocket, so on
 * the relay the browser card's live view was unavailable. This stands in for
 * WebSocket with the two things the relay does carry: an event stream down
 * (`id` once, then `m` per message) and ordered POSTs up. The shape is the
 * part of WebSocket useBrowserStream.ts uses, as path/rtc-socket.ts is for the
 * direct link.
 */

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

/** Messages per POST, matching what the Mac accepts (SOCKET_BRIDGE_POST_MESSAGES). */
export const BRIDGE_POST_BATCH = 64

/** What this needs of an event stream — the companion's own, watched (rtc-plane.ts · openEventSource). */
export interface BridgeStream {
  readonly readyState: number
  addEventListener(type: string, listener: (event: Event) => void): void
  close(): void
}

export interface BridgeSocketDeps {
  readonly stream: () => BridgeStream
  /** POST messages up; false when the Mac no longer knows the session. */
  readonly post: (id: string, messages: readonly string[]) => Promise<boolean>
}

export class BridgeWebSocket {
  static readonly CONNECTING = CONNECTING
  static readonly OPEN = OPEN
  static readonly CLOSING = CLOSING
  static readonly CLOSED = CLOSED
  readyState = CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  private stream: BridgeStream | null = null
  private id: string | null = null
  private readonly outbox: string[] = []
  private posting = false

  constructor(private readonly deps: BridgeSocketDeps) {
    try {
      this.stream = deps.stream()
    } catch {
      queueMicrotask(() => this.end(true))
      return
    }
    this.stream.addEventListener('id', (event) => {
      if (this.readyState !== CONNECTING) return
      try {
        const { id } = JSON.parse(String((event as MessageEvent).data)) as { id?: unknown }
        if (typeof id !== 'string') throw new Error('no id')
        this.id = id
      } catch {
        return this.fail()
      }
      this.readyState = OPEN
      this.onopen?.(new Event('open'))
    })
    this.stream.addEventListener('m', (event) => {
      if (this.readyState !== OPEN) return
      let text: unknown
      try {
        text = JSON.parse(String((event as MessageEvent).data))
      } catch {
        return
      }
      if (typeof text === 'string') this.onmessage?.(new MessageEvent('message', { data: text }))
    })
    // One session per stream: an EventSource that reconnects by itself would
    // open a second socket on the Mac, so any error ends this one and the
    // consumer opens anew, as it does for a dropped WebSocket.
    this.stream.addEventListener('error', () => this.fail())
  }

  send(text: string): void {
    if (this.readyState !== OPEN || this.id === null) throw new DOMException('not open', 'InvalidStateError')
    this.outbox.push(text)
    this.pump()
  }

  close(): void {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSING
    this.end(false)
  }

  /** Messages leave in order, one POST in flight, the rest batched behind it. */
  private pump(): void {
    if (this.posting || this.outbox.length === 0 || this.id === null || this.readyState !== OPEN) return
    const batch = this.outbox.splice(0, BRIDGE_POST_BATCH)
    this.posting = true
    void this.deps
      .post(this.id, batch)
      .then((known) => {
        if (!known) this.fail()
      })
      .catch(() => undefined)
      .finally(() => {
        this.posting = false
        this.pump()
      })
  }

  private fail(): void {
    this.end(true)
  }

  private end(error: boolean): void {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this.outbox.length = 0
    try {
      this.stream?.close()
    } catch {
      // Already closed.
    }
    if (error) this.onerror?.(new Event('error'))
    this.onclose?.(new Event('close'))
  }
}
