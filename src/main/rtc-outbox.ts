/**
 * WHAT GOES DOWN THE DIRECT LINK NEXT (rtc-peer.ts).
 *
 * werift sends every data channel of a peer from ONE first-in-first-out
 * queue (transport/sctp.js · dataChannelFlush). Whatever was handed to it
 * first goes first, whichever channel it is on. So a pong, a keystroke's
 * answer or a stream's heartbeat waited behind everything queued before it:
 * a browser card's frames (up to 4 MB before the socket paused) or an
 * 800 KB workspace snapshot that every stream reconnect re-sends. Measured on
 * this Mac's own loopback at ~10 MB/s, two snapshot downloads took the pong
 * from 1 ms to 90-190 ms; over a phone's Wi-Fi the same queue is seconds.
 * That is a sluggish input box, and a heartbeat late enough reads as a dead
 * stream, which drops the phone to the relay (the LAN/RELAY flapping).
 *
 * So nothing is handed to werift beyond a small budget, and what is held here
 * is sent in LANES: one per exchange, one per socket, one for the link's own
 * frames. A lane keeps its order (a head before its chunks before its end);
 * between lanes, a lane whose next message is small goes first, and the rest
 * take turns one message at a time. A keystroke's answer and a terminal's
 * echo are small; bulk is not, and waits its turn.
 *
 * A message marked REPLACEABLE (a browser card's frame: each one is the whole
 * picture) that has not started to go is replaced by a newer one on the same
 * lane, so a slow link shows the newest picture rather than a backlog.
 */

/** A data channel, as far as the outbox needs one. */
export interface OutboxSink {
  readonly send: (text: string) => void
  /** Bytes the channel holds that the link has not yet sent. */
  readonly bufferedAmount: number
}

/** Bytes handed to the channels at most, across the peer. */
export const RTC_OUTBOX_BUDGET = 64 * 1024
/** A message this small jumps the bulk lanes. */
export const RTC_OUTBOX_URGENT = 2 * 1024
/** How soon to look again when the channels were full. */
export const RTC_OUTBOX_RETRY_MS = 10

export interface RtcOutboxOptions {
  readonly budget?: number
  readonly urgent?: number
  readonly retryMs?: number
  readonly schedule?: (run: () => void, ms: number) => unknown
  readonly cancel?: (handle: unknown) => void
}

export interface RtcOutbox {
  /** Queue one message (or its pieces, sent back to back) on a lane. */
  readonly send: (
    sink: OutboxSink,
    lane: string,
    pieces: string | readonly string[],
    options?: { readonly replaceable?: boolean }
  ) => void
  /** Bytes on a lane not yet handed to its channel. */
  readonly queued: (lane: string) => number
  /** Call `run` once, when the lane holds no more than `bytes`. */
  readonly whenBelow: (lane: string, bytes: number, run: () => void) => void
  /** Forget what a lane still holds: whoever it was for is gone. */
  readonly drop: (lane: string) => void
  /** A channel closed: what it held no longer counts, and its lanes are gone. */
  readonly forget: (sink: OutboxSink) => void
  /** Look again: a channel took some of what it held. */
  readonly pump: () => void
  readonly close: () => void
}

interface Message {
  readonly pieces: readonly string[]
  readonly replaceable: boolean
  readonly bytes: number
  next: number
}

interface Lane {
  readonly sink: OutboxSink
  readonly messages: Message[]
  bytes: number
  watchers: { readonly bytes: number; readonly run: () => void }[]
}

const sizeOf = (pieces: readonly string[]): number => pieces.reduce((sum, piece) => sum + piece.length, 0)

export const createRtcOutbox = (options: RtcOutboxOptions = {}): RtcOutbox => {
  const budget = options.budget ?? RTC_OUTBOX_BUDGET
  const urgent = options.urgent ?? RTC_OUTBOX_URGENT
  const retryMs = options.retryMs ?? RTC_OUTBOX_RETRY_MS
  const schedule = options.schedule ?? ((run, ms): unknown => setTimeout(run, ms))
  const cancel = options.cancel ?? ((handle): void => clearTimeout(handle as ReturnType<typeof setTimeout>))

  /** Insertion order is the turn order: a lane served goes to the back. */
  const lanes = new Map<string, Lane>()
  const sinks = new Set<OutboxSink>()
  let retry: unknown = null
  let pumping = false
  let closed = false

  const handed = (): number => {
    let sum = 0
    for (const sink of sinks) sum += sink.bufferedAmount
    return sum
  }

  const settle = (name: string, lane: Lane): void => {
    const due = lane.watchers.filter((watcher) => lane.bytes <= watcher.bytes)
    lane.watchers = lane.watchers.filter((watcher) => lane.bytes > watcher.bytes)
    if (lane.messages.length === 0 && lane.watchers.length === 0) lanes.delete(name)
    for (const watcher of due) watcher.run()
  }

  /**
   * The next lane to serve: a lane holding little first, then whoever's turn
   * it is. By what the lane holds, not its next message: a terminal pouring
   * out small messages is bulk, and must not starve a snapshot.
   */
  const pick = (): [string, Lane] | null => {
    let first: [string, Lane] | null = null
    for (const entry of lanes) {
      if (entry[1].messages.length === 0) continue
      if (entry[1].bytes <= urgent) return entry
      first ??= entry
    }
    return first
  }

  const pump = (): void => {
    if (pumping || closed) return
    pumping = true
    try {
      for (;;) {
        const entry = pick()
        if (!entry) return
        if (handed() >= budget) {
          retry ??= schedule(() => {
            retry = null
            pump()
          }, retryMs)
          return
        }
        const [name, lane] = entry
        const message = lane.messages[0]
        const piece = message.pieces[message.next]
        message.next += 1
        lane.bytes -= piece.length
        if (message.next === message.pieces.length) lane.messages.shift()
        // Its turn is used: to the back of the line.
        lanes.delete(name)
        lanes.set(name, lane)
        try {
          lane.sink.send(piece)
        } catch {
          // The channel is gone; so is everything it was going to carry.
          lane.messages.length = 0
          lane.bytes = 0
          sinks.delete(lane.sink)
        }
        settle(name, lane)
      }
    } finally {
      pumping = false
    }
  }

  return {
    send: (sink, name, pieces, sendOptions = {}) => {
      if (closed) return
      const list = typeof pieces === 'string' ? [pieces] : pieces
      if (list.length === 0) return
      sinks.add(sink)
      const lane = lanes.get(name) ?? { sink, messages: [], bytes: 0, watchers: [] }
      lanes.set(name, lane)
      const message: Message = { pieces: list, replaceable: sendOptions.replaceable === true, bytes: sizeOf(list), next: 0 }
      const last = lane.messages.at(-1)
      if (message.replaceable && last?.replaceable && last.next === 0) {
        lane.messages[lane.messages.length - 1] = message
        lane.bytes += message.bytes - last.bytes
      } else {
        lane.messages.push(message)
        lane.bytes += message.bytes
      }
      pump()
    },
    queued: (name) => lanes.get(name)?.bytes ?? 0,
    whenBelow: (name, bytes, run) => {
      const lane = lanes.get(name)
      if (!lane || lane.bytes <= bytes) return run()
      lane.watchers.push({ bytes, run })
    },
    drop: (name) => {
      const lane = lanes.get(name)
      if (!lane) return
      lane.messages.length = 0
      lane.bytes = 0
      settle(name, lane)
    },
    forget: (sink) => {
      sinks.delete(sink)
      for (const [name, lane] of [...lanes]) {
        if (lane.sink !== sink) continue
        lane.messages.length = 0
        lane.bytes = 0
        settle(name, lane)
      }
      pump()
    },
    pump,
    close: () => {
      closed = true
      if (retry !== null) cancel(retry)
      retry = null
      lanes.clear()
      sinks.clear()
    }
  }
}
