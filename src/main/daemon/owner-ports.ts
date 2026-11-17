/**
 * MESSAGE PORTS ACROSS THE OWNER LINK (D0 step 4).
 *
 * A browser card's frames reach the window over a MessagePort: main makes a
 * MessageChannelMain, keeps port1 for the cast (browser-cast-ipc.ts) and hands
 * port2 to the owner window (index.ts · browser-stream:open). A port cannot
 * cross a pipe, so the daemon's MessageChannelMain makes a pair whose second
 * port, once handed to the owner window, becomes a NUMBERED remote end: the
 * owner's app (the shell) opens a real channel for it and relays.
 *
 *   daemon -> owner   $port:open [id, channel, message]   (port2 was handed over)
 *                     $port:message [id, data]
 *                     $port:close [id]
 *   owner -> daemon   $port:message [id, data]  ->  port1 'message' {data}
 *                     $port:close [id]          ->  port1 'close'
 *
 * Messages port1 posts before port2 is handed over are held (bounded), as a
 * real MessagePort holds them until the other end starts.
 */
import { EventEmitter } from 'node:events'

/** Channels of the port relay; `$` keeps them apart from every IPC channel. */
export const PORT_OPEN = '$port:open'
export const PORT_MESSAGE = '$port:message'
export const PORT_CLOSE = '$port:close'

/** Messages held for a port whose other end has not been handed over yet. */
const HELD_MAX = 256

/** Sends one frame to the owner; false when it was not sent. `essential` frames are never dropped for backlog. */
type ToOwner = (channel: string, args: readonly unknown[], essential: boolean) => boolean

/** The local end (port1): what main's code holds. */
export class RelayedPort extends EventEmitter {
  private remoteId: number | null = null
  private held: unknown[] = []
  private started = false
  private queuedIn: unknown[] = []
  private closed = false

  constructor(private readonly hub: PortHub) {
    super()
  }

  /** port2 was handed to the owner window under this id. */
  attach(id: number): void {
    this.remoteId = id
    const held = this.held
    this.held = []
    for (const data of held) this.hub.out(PORT_MESSAGE, [id, data])
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** A dropped frame is safe: the cast writes it off when its receipt does not come. */
  postMessage(data: unknown): void {
    if (this.closed) return
    if (this.remoteId === null) {
      if (this.held.length < HELD_MAX) this.held.push(data)
      return
    }
    this.hub.out(PORT_MESSAGE, [this.remoteId, data])
  }

  /** As MessagePortMain: messages are delivered once the port is started. */
  start(): void {
    this.started = true
    const queued = this.queuedIn
    this.queuedIn = []
    for (const data of queued) this.emit('message', { data })
  }

  /**
   * As MessagePortMain.close: the other end is told; this end's own 'close'
   * event is for the remote end going away (remoteClosed), not for this call.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.remoteId !== null) {
      this.hub.out(PORT_CLOSE, [this.remoteId], true)
      this.hub.forget(this.remoteId)
    }
  }

  /** From the owner's end. */
  receive(data: unknown): void {
    if (this.closed) return
    if (this.started) this.emit('message', { data })
    else if (this.queuedIn.length < HELD_MAX) this.queuedIn.push(data)
  }

  /** The owner's end closed. */
  remoteClosed(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
}

/** The second end (port2) until it is handed over: only a ticket back to its partner. */
export class PendingPort {
  constructor(readonly partner: RelayedPort) {}
}

/** Every relayed port of one daemon, by the id its owner end was given. */
export class PortHub {
  private nextId = 1
  private readonly ports = new Map<number, RelayedPort>()

  constructor(private readonly toOwner: () => ToOwner | null) {}

  out(channel: string, args: readonly unknown[], essential = false): boolean {
    return this.toOwner()?.(channel, args, essential) ?? false
  }

  forget(id: number): void {
    this.ports.delete(id)
  }

  /** A MessageChannelMain's pair. */
  channel(): { port1: RelayedPort; port2: PendingPort } {
    const port1 = new RelayedPort(this)
    return { port1, port2: new PendingPort(port1) }
  }

  /**
   * The owner window was handed these ports with this message (webContents.
   * postMessage). Answers false when there is no owner to hand them to, and
   * the ports are closed so the cast is not left waiting.
   */
  handOver(channel: string, message: unknown, transfer: readonly unknown[]): boolean {
    const pending = transfer.filter((p): p is PendingPort => p instanceof PendingPort)
    if (pending.length === 0) {
      console.error(`[cookrewd] ${channel} was posted to the owner window with no port; nothing relayed`)
      return false
    }
    if (this.toOwner() === null) {
      // Nobody to hand it to: for port1 the other end is gone.
      for (const p of pending) p.partner.remoteClosed()
      return false
    }
    let all = true
    for (const p of pending) {
      const id = this.nextId++
      this.ports.set(id, p.partner)
      if (!this.out(PORT_OPEN, [id, channel, message], true)) {
        this.ports.delete(id)
        p.partner.remoteClosed()
        all = false
        continue
      }
      // A port main closed before handing it over (a card that does not stream)
      // still reaches the window, as Electron's would, and is closed at once.
      if (p.partner.isClosed) {
        this.ports.delete(id)
        this.out(PORT_CLOSE, [id], true)
        continue
      }
      p.partner.attach(id)
    }
    return all
  }

  /** A $port: frame from the owner. Answers false when it was not one. */
  fromOwner(channel: string, args: readonly unknown[]): boolean {
    if (channel !== PORT_MESSAGE && channel !== PORT_CLOSE) return false
    const id = args[0]
    const port = typeof id === 'number' ? this.ports.get(id) : undefined
    if (port === undefined) return true
    if (channel === PORT_MESSAGE) port.receive(args[1])
    else {
      this.ports.delete(id as number)
      port.remoteClosed()
    }
    return true
  }

  /** The owner went away: every relayed port ends. */
  closeAll(): void {
    for (const [id, port] of this.ports) {
      this.ports.delete(id)
      port.remoteClosed()
    }
  }
}
