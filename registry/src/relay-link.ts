import type { IncomingMessage, ServerResponse } from 'node:http'
import { encodeFrame, MAX_FRAME_BYTES } from '../../src/shared/relay-frame'
import type { HubSocket } from './relay-hub'

/**
 * A LONG LINE HELD OPEN, AND THE TWO WAYS BYTES CROSS IT.
 *
 * A machine that cannot be dialled dials out and keeps a pair of requests
 * open: a GET whose response streams frames DOWN to it, and a chunked POST
 * whose body streams frames UP. That arrangement is not about doors — it is
 * about being behind a router — so it lives here rather than inside the
 * door relay, and the owner's own canvas uses the same three pieces.
 *
 * Extracted from relay-http.ts rather than copied. A second implementation of
 * the NDJSON write, the line reader and the pulse would be a second set of the
 * bugs those three have already had: the buffered proxy, the line that never
 * ends, and the zombie door whose sockets both looked open while nothing
 * crossed either of them.
 */

/**
 * How often a quiet line says something.
 *
 * Well under the minute-or-two an idle connection typically survives at a CDN,
 * and far too rare to be a cost: one byte.
 */
export const HEARTBEAT_MS = 25_000

/**
 * A stream of frames, one JSON object per line, and a heartbeat under it.
 *
 * The heartbeat is an EMPTY LINE, because the parsers on both ends already
 * skip one: it needs no place in the protocol. Without it every CDN and load
 * balancer in the path drops the connection after a minute or two of quiet —
 * and a desktop that is simply not being asked anything is quiet for hours.
 */
export function openNdjson(response: ServerResponse, heartbeatMs = HEARTBEAT_MS): (line: string) => void {
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Nginx and friends buffer a response until it ends unless told not to,
    // which would hold a terminal's output until the session was over.
    'x-accel-buffering': 'no'
  })
  const beat = setInterval(() => {
    if (!response.writableEnded) response.write('\n')
  }, heartbeatMs)
  beat.unref?.()
  response.on('close', () => clearInterval(beat))
  return (line) => {
    if (!response.writableEnded) response.write(`${line}\n`)
  }
}

/**
 * Read a never-ending chunked body as lines, and never accumulate one.
 *
 * A machine streaming a terminal for an hour must not grow this process by an
 * hour of output — so the buffer holds at most one unfinished line, and a
 * "line" that grows past a frame's ceiling is not a frame at all. It is
 * somebody making us allocate, and the connection is the right thing to lose.
 */
export function readFrameLines(request: IncomingMessage, onLine: (line: string) => void): void {
  let buffer = ''
  request.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let at = buffer.indexOf('\n')
    while (at >= 0) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (line.length > 0) onLine(line)
      at = buffer.indexOf('\n')
    }
    if (buffer.length > MAX_FRAME_BYTES) {
      buffer = ''
      request.destroy()
    }
  })
}

export interface LinkPulseOptions {
  now?: () => number
  /** How often each held line is pinged. */
  pulseMs?: number
  /** How long without a pong before the line is declared gone. */
  deadlineMs?: number
  /** Called for a line that missed its deadline. It must release the name. */
  drop: (name: string, why: string) => void
}

/**
 * WHICH LINES ARE REALLY CARRYING BYTES.
 *
 * A downlink and an uplink are long-lived streams through proxies that drop
 * one side without telling the other. A downlink that still delivers requests
 * to an uplink nobody is reading receives every call and answers none — and
 * NEITHER end can see it, because every socket looks open. The pong is the
 * only proof that both halves carry bytes end to end, and a missed one is
 * what closes the line (the third zombie door, 2026-09-02).
 *
 * One timer for every line rather than one per line: the work per tick is a
 * map walk, and a registry holding a thousand lines should not hold a thousand
 * intervals to say the same thing.
 */
export class LinkPulse {
  private readonly held = new Map<string, { socket: HubSocket; at: number }>()
  private readonly timer: NodeJS.Timeout
  private readonly now: () => number

  constructor(options: LinkPulseOptions) {
    this.now = options.now ?? ((): number => Date.now())
    const pulseMs = options.pulseMs ?? HEARTBEAT_MS
    const deadlineMs = options.deadlineMs ?? pulseMs * 3
    this.timer = setInterval(() => {
      const at = this.now()
      for (const [name, line] of [...this.held]) {
        if (at - line.at > deadlineMs) options.drop(name, 'lost its pulse')
        else line.socket.send(encodeFrame({ t: 'ping', at }))
      }
    }, pulseMs)
    this.timer.unref?.()
  }

  /**
   * A line is held under a name. The pulse is stamped NOW: a machine that
   * opens a downlink and never an uplink is dropped by the same rule as one
   * whose uplink died, rather than living forever on a technicality.
   */
  hold(name: string, socket: HubSocket): void {
    this.held.set(name, { socket, at: this.now() })
  }

  /** A pong arrived: both halves of this line carried a byte just now. */
  beat(name: string): void {
    const line = this.held.get(name)
    if (line) this.held.set(name, { ...line, at: this.now() })
  }

  socketOf(name: string): HubSocket | undefined {
    return this.held.get(name)?.socket
  }

  /** Is this exact socket still the one held under the name? */
  holds(name: string, socket: HubSocket): boolean {
    return this.held.get(name)?.socket === socket
  }

  release(name: string): void {
    this.held.delete(name)
  }

  get size(): number {
    return this.held.size
  }

  /** For a test, and for a registry shutting down. */
  stop(): void {
    clearInterval(this.timer)
  }
}
