import { parseStreamMessage, parseStreamObject, type StreamMessage } from './browser-stream'

/**
 * ONE VIEWER, TWO LINES.
 *
 * A browser card's live view reaches its Chrome one of two ways, and the view
 * should not care which:
 *
 *   PORT — the desktop. The renderer and the card's Chrome live under the same
 *   main process, so main hands the view one end of a MessageChannel and the
 *   frames come over it as JPEG bytes (browser-cast-ipc.ts). No socket, no
 *   token in a URL, no base64.
 *
 *   SOCKET — the phone, over the LAN, the relay or a data channel; and the
 *   desktop too when its preload predates the port.
 *
 * Both deliver the same parsed messages and take the same input objects.
 */

export interface StreamLineHandlers {
  onOpen: () => void
  onMessage: (message: StreamMessage) => void
  /** The line dropped or failed; called once. */
  onClose: () => void
  /** The line is down and being dialled again; messages wait (path/bridge-socket.ts). */
  onResuming?: (on: boolean) => void
}

export interface StreamLine {
  /** Frames come as bytes over the desktop's port; receipts pace them. */
  readonly direct: boolean
  isOpen: () => boolean
  /** The other end ever answered (a port arrived, a socket opened), whatever happened since. */
  answered: () => boolean
  send: (message: object) => void
  /** A frame was drawn or passed over, for a line paced by that. */
  receipt: (seq: number) => void
  close: () => void
}

/** A socket that takes paint receipts and says when it is resuming (path/bridge-socket.ts). */
interface ResumingSocket {
  painted?: (seq: number) => void
  onresuming?: ((on: boolean) => void) | null
}

/** The preload's port to main (preload/index.ts · openBrowserStream). */
export interface BrowserStreamPort {
  post: (message: unknown) => void
  close: () => void
}

export interface BrowserStreamPortHandlers {
  onOpen: () => void
  onMessage: (message: unknown) => void
  onClose: () => void
}

export type OpenBrowserStream = (browserId: string, handlers: BrowserStreamPortHandlers) => BrowserStreamPort

export function portLine(open: OpenBrowserStream, browserId: string, handlers: StreamLineHandlers): StreamLine {
  let opened = false
  let closed = false
  const port = open(browserId, {
    onOpen: () => {
      if (closed) return
      opened = true
      handlers.onOpen()
    },
    onMessage: (raw) => {
      if (closed) return
      const message = parseStreamObject(raw)
      if (message) handlers.onMessage(message)
    },
    onClose: () => {
      if (closed) return
      closed = true
      handlers.onClose()
    }
  })
  return {
    direct: true,
    isOpen: () => opened && !closed,
    answered: () => opened,
    send: (message) => {
      if (opened && !closed) port.post(message)
    },
    receipt: (seq) => {
      if (opened && !closed) port.post({ t: 'painted', seq })
    },
    close: () => {
      if (closed) return
      closed = true
      port.close()
    }
  }
}

export function socketLine(socket: WebSocket, handlers: StreamLineHandlers): StreamLine {
  let closed = false
  let opened = false
  const drop = (): void => {
    if (closed) return
    closed = true
    handlers.onClose()
  }
  socket.onopen = (): void => {
    opened = true
    if (!closed) handlers.onOpen()
  }
  socket.onerror = drop
  socket.onclose = drop
  const resuming = socket as WebSocket & ResumingSocket
  if ('onresuming' in resuming) resuming.onresuming = (on) => handlers.onResuming?.(on)
  socket.onmessage = (event: MessageEvent): void => {
    if (closed) return
    const message = parseStreamMessage(event.data)
    if (message) handlers.onMessage(message)
  }
  return {
    direct: false,
    isOpen: () => !closed && socket.readyState === WebSocket.OPEN,
    answered: () => opened,
    send: (message) => {
      if (!closed && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
    },
    receipt: (seq) => {
      if (!closed) resuming.painted?.(seq)
    },
    close: () => {
      closed = true
      socket.onopen = socket.onerror = socket.onclose = socket.onmessage = null
      try {
        socket.close()
      } catch {
        // already closing
      }
    }
  }
}
