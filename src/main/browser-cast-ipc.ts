// The desktop's own way to a browser card: a MessagePort, not a socket.
//
// The Electron renderer used to watch its OWN headless Chrome through the
// companion server — a WebSocket to 127.0.0.1:8639 carrying base64 JPEG in
// JSON, a token in the URL, the same path a phone takes across the LAN. It is
// the same process tree on the same Mac: main holds the CDP connection, the
// renderer holds the canvas. So the desktop now asks main for a
// MessageChannel (owner window, top frame only — index.ts) and the frames go
// over it as raw JPEG bytes, paced by the renderer's own "painted" receipts
// instead of a socket's drain. Same CastViewer, same viewport arbitration,
// same closed input vocabulary (sanitizeInput) as every phone.

import type { BrowserInstance } from './browser-instance'
import { MAC_VIEWER } from '../shared/remote-access'
import { CastViewer, type OutboundFrame, type ViewerSink } from './cast-viewer'

/** The slice of Electron's MessagePortMain this uses (and a test can fake). */
export interface CastPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  on(event: 'close', listener: () => void): unknown
  start(): void
  close(): void
}

export interface BrowserCastIpcDeps {
  getInstance: (browserId: string) => Promise<BrowserInstance | null>
  /** Main draws this card (browser-owner.ts); a page in a webview has no stream. */
  enabled: (browserId: string) => boolean
}

export interface BrowserCastIpc {
  /** Serve one browser card's viewer on this port; refused (closed) when the flag is off. */
  open: (browserId: string, port: CastPort) => void
  /** Close one card's viewers: its instance was replaced or removed; each reopens on the new one. */
  drop: (browserId: string) => void
  shutdown: () => void
  activeCount: () => number
}

/**
 * Frames on the wire at once. Two keeps the pipe full (one decoding while the
 * next crosses) without letting a busy renderer queue a backlog it would only
 * paint late: anything beyond waits as "latest" and older ones are skipped.
 */
export const IPC_FRAMES_IN_FLIGHT = 2
/** A receipt that never comes (a renderer that froze, a reload) must not stall the card forever. */
export const IPC_RECEIPT_TIMEOUT_MS = 1000

export function createBrowserCastIpc(deps: BrowserCastIpcDeps): BrowserCastIpc {
  const viewers = new Set<PortViewer>()

  return {
    open: (browserId, port) => {
      if (!deps.enabled(browserId)) {
        try {
          port.close()
        } catch {
          // Already closed.
        }
        return
      }
      const viewer = new PortViewer(port, browserId, () => viewers.delete(viewer))
      viewers.add(viewer)
      void deps
        .getInstance(browserId)
        .then((instance) => {
          if (!instance) return viewer.fail('no headless instance')
          viewer.attach(instance)
        })
        .catch(() => viewer.fail('headless instance failed'))
    },
    drop: (browserId) => {
      for (const viewer of [...viewers]) if (viewer.browserId === browserId) viewer.close()
    },
    shutdown: () => {
      for (const viewer of [...viewers]) viewer.close()
    },
    activeCount: () => viewers.size
  }
}

class PortViewer {
  private readonly viewer: CastViewer
  /** The frames on the wire, by seq: a receipt counts only for one of these (a late or stray one is nothing). */
  private readonly inFlight = new Set<number>()
  private readyCallbacks: Array<() => void> = []
  private receiptTimer: ReturnType<typeof setTimeout> | null = null
  private portClosed = false

  constructor(
    private readonly port: CastPort,
    readonly browserId: string,
    onClosed: () => void
  ) {
    const sink: ViewerSink = {
      sendControl: (message) => this.post(message),
      frameReady: () => this.inFlight.size < IPC_FRAMES_IN_FLIGHT,
      sendFrame: (frame) => this.sendFrame(frame),
      onceReady: (callback) => {
        this.readyCallbacks.push(callback)
      },
      close: () => this.closePort()
    }
    // The port is the owner window's own (index.ts · isOwnerSender): this is the Mac itself.
    this.viewer = new CastViewer(sink, onClosed, browserId, MAC_VIEWER)
    port.on('message', (event) => this.onMessage(event.data))
    port.on('close', () => this.close())
    port.start()
  }

  attach(instance: BrowserInstance): void {
    this.viewer.attach(instance)
  }

  fail(message: string): void {
    this.viewer.fail(message)
  }

  close(): void {
    this.viewer.close()
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'object' || data === null) return
    const message = data as Record<string, unknown>
    if (message.t === 'painted') return this.receipt(message.seq)
    this.viewer.handleMessage(message)
  }

  private sendFrame(frame: OutboundFrame): void {
    this.inFlight.add(frame.seq)
    this.armReceiptTimeout()
    this.post({ t: 'frame', seq: frame.seq, jpeg: ownBytes(frame.bytes), meta: frame.meta })
  }

  /** The renderer painted (or skipped) a frame: one more may go. */
  private receipt(seq: unknown): void {
    if (typeof seq !== 'number' || !this.inFlight.delete(seq)) return
    if (this.inFlight.size === 0 && this.receiptTimer) {
      clearTimeout(this.receiptTimer)
      this.receiptTimer = null
    }
    this.flushReady()
  }

  private armReceiptTimeout(): void {
    if (this.receiptTimer) clearTimeout(this.receiptTimer)
    this.receiptTimer = setTimeout(() => {
      this.receiptTimer = null
      // Whatever is still out is written off: its receipt, if it ever comes, counts for nothing.
      this.inFlight.clear()
      this.flushReady()
    }, IPC_RECEIPT_TIMEOUT_MS)
  }

  private flushReady(): void {
    if (this.inFlight.size >= IPC_FRAMES_IN_FLIGHT) return
    const callbacks = this.readyCallbacks
    this.readyCallbacks = []
    for (const callback of callbacks) callback()
  }

  private post(message: Record<string, unknown>): void {
    if (this.portClosed || this.viewer?.isClosed) return
    try {
      this.port.postMessage(message)
    } catch {
      this.close()
    }
  }

  private closePort(): void {
    if (this.portClosed) return
    this.portClosed = true
    if (this.receiptTimer) clearTimeout(this.receiptTimer)
    this.receiptTimer = null
    this.readyCallbacks = []
    this.inFlight.clear()
    try {
      // The renderer's port gets no close event of its own: say it, so the
      // view redials (a replaced instance) instead of waiting on a dead line.
      this.port.postMessage({ t: 'bye' })
    } catch {
      // Already closed.
    }
    try {
      this.port.close()
    } catch {
      // Already closed.
    }
  }
}

/**
 * The JPEG as a view over exactly its own bytes. A small Buffer can be a
 * window into Node's shared 8 KB pool, and a structured clone copies the
 * whole backing store — someone else's bytes included. Copy only then.
 */
function ownBytes(bytes: Buffer): Uint8Array {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return new Uint8Array(bytes.buffer, 0, bytes.byteLength)
  }
  return new Uint8Array(bytes)
}
