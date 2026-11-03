/**
 * A WEBSOCKET OVER THE DIRECT LINK — the browser card's live view, which the
 * relay cannot carry at all (it has no WebSocket), on a data channel of its
 * own (main/rtc-peer.ts · carrySocket).
 *
 * The shape is the part of WebSocket useBrowserStream.ts uses: `readyState`
 * with the standard numbers, the four `on*` handlers, `send(text)` and
 * `close()`. Messages cross in pieces (shared/rtc-socket-chunks.ts), so a
 * frame of any size arrives whole.
 */

import { createJoiner, splitMessage } from '../../../shared/rtc-socket-chunks'

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

/** What this needs of a data channel: the browser's, or a test's. */
export interface SocketChannel {
  readonly readyState: string
  send(data: string): void
  close(): void
  addEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (event: Event) => void): void
}

export class RtcWebSocket {
  static readonly CONNECTING = CONNECTING
  static readonly OPEN = OPEN
  static readonly CLOSING = CLOSING
  static readonly CLOSED = CLOSED
  readyState = CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  private channel: SocketChannel | null = null

  constructor(open: () => SocketChannel) {
    try {
      this.channel = open()
    } catch {
      // A link that closed between the check and the open: fail like a
      // socket that could not connect, after the caller has wired up.
      queueMicrotask(() => this.end(true))
      return
    }
    const join = createJoiner((text) => {
      if (this.readyState === OPEN) this.onmessage?.(new MessageEvent('message', { data: text }))
    })
    this.channel.addEventListener('open', () => {
      if (this.readyState !== CONNECTING) return
      this.readyState = OPEN
      this.onopen?.(new Event('open'))
    })
    this.channel.addEventListener('message', (event) => {
      if (!join(String((event as MessageEvent).data))) this.close()
    })
    this.channel.addEventListener('error', () => this.end(true))
    this.channel.addEventListener('close', () => this.end(false))
  }

  send(text: string): void {
    if (this.readyState !== OPEN || !this.channel) throw new DOMException('not open', 'InvalidStateError')
    for (const piece of splitMessage(text)) this.channel.send(piece)
  }

  close(): void {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSING
    try {
      this.channel?.close()
    } catch {
      // Already down.
    }
    this.end(false)
  }

  private end(error: boolean): void {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    if (error) this.onerror?.(new Event('error'))
    this.onclose?.(new Event('close'))
  }
}
