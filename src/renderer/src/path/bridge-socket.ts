import { aimedInput, coalesceInput, stripStale, type OutboxItem } from './bridge-outbox'

/**
 * A WEBSOCKET OVER PLAIN HTTP — the phone's end of main/socket-bridge.ts.
 *
 * The relay carries requests and event streams and never a WebSocket, so on
 * the relay the browser card's live view was unavailable. This stands in for
 * WebSocket with the two things the relay does carry: an event stream down and
 * ordered POSTs up. The shape is the part of WebSocket useBrowserStream.ts uses,
 * as path/rtc-socket.ts is for the direct link.
 *
 * A PHONE MOVES, AND THE LINE GOES WITH IT. Leaving the Wi-Fi kills the stream
 * and every POST in flight, and the Mac's side of this is a whole viewer that
 * took a while to set up. So a dropped stream is a pause: this stays OPEN, dials
 * the same session from the last message it saw, and what was typed meanwhile
 * goes when there is a way. It closes only when the Mac has forgotten the
 * session or its budget runs out, and then the card redials as for any socket.
 *
 * A path can die without a reset, so three things declare it dead: silence past
 * BRIDGE_SILENT_MS, a POST the network ate, and the phone saying its network
 * changed (`watch`). The first is the slow one and the others are why it rarely
 * matters.
 *
 * Input is numbered, so a POST whose answer was lost can go again and the Mac
 * takes it once; two go at a time, since one in flight caps a finger at one
 * position per round trip. A Mac from before this answers `id` without `v`, and
 * gets one POST at a time and an ending with the stream, as it always did.
 */

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

/** Messages per POST, matching what the Mac accepts (SOCKET_BRIDGE_POST_MESSAGES). */
export const BRIDGE_POST_BATCH = 64
/**
 * POSTs up at once. Each holds a relay round trip, so with two the Mac heard
 * the phone's acknowledgements about twice a round trip (~once a second on a
 * 2 s line) and had to keep that much more in flight to keep the line busy,
 * which stood as a queue in front of the finger (tests/cast-video-line.test.ts:
 * the relay at 650 ms, 8.8 fps with two, 11.2 with four). The Mac holds 32 that
 * overtake (socket-bridge-session.ts HELD_POSTS); acknowledgements are not numbered.
 */
export const BRIDGE_UP_IN_FLIGHT = 4
/** The Mac beats every second and holds the session for thirty. */
export const BRIDGE_SILENT_MS = 8000
/** A POST on a dead path does not fail, it hangs; numbered, it can safely go again. */
export const BRIDGE_POST_TIMEOUT_MS = 8000
export const BRIDGE_RESUME_BUDGET_MS = 25_000
/** The least time between acknowledgement-only POSTs (bridge-socket.ts · sendAckAlone). */
export const BRIDGE_ACK_MIN_MS = 120
/** Heard from within this long: a network change is no news to this line. */
const HEARD_LATELY_MS = 1500
/** A dial that neither opens nor fails. */
const DIAL_PATIENCE_MS = 4000
const DIAL_BACKOFF_MS = [0, 250, 500, 1000, 2000]
const POST_RETRY_MS = 400
/** A tick this late means the page slept: the line's silence says nothing about the line. */
const WOKE_LATE_MS = 3000
const OUTBOX_MAX = 512

/** What this needs of an event stream — the companion's own, watched (rtc-plane.ts · openEventSource). */
export interface BridgeStream {
  readonly readyState: number
  addEventListener(type: string, listener: (event: Event) => void): void
  close(): void
}

export interface BridgeResume {
  readonly id: string
  /** The last numbered message seen. */
  readonly after: number
}

export interface BridgeBody {
  /** The number of the first message in `m`. */
  readonly s?: number
  readonly m?: readonly string[]
  /** The newest frame painted. */
  readonly a?: number
  /** The newest H.264 chunk decoded (cast-video.ts). */
  readonly v?: number
  readonly end?: boolean
}

/** An H.264 acknowledgement's chunk number, or null for any other message. */
export function videoAckOf(text: string): number | null {
  if (!text.startsWith('{"t":"vack"')) return null
  try {
    const n = (JSON.parse(text) as { n?: unknown }).n
    return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** gone: the Mac does not know the session. retry: it could not take this now. */
export type BridgePosted = 'ok' | 'gone' | 'retry'

export interface BridgeSocketDeps {
  readonly stream: (resume?: BridgeResume) => BridgeStream
  /** Rejects when the network ate it or the signal aborts it. */
  readonly post: (id: string, body: BridgeBody, signal?: AbortSignal) => Promise<BridgePosted>
  /** Calls back when the phone's network may have changed; returns the way to stop. */
  readonly watch?: (changed: () => void) => () => void
}

interface Batch {
  readonly s: number
  readonly items: readonly OutboxItem[]
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
  /** The line is down and being dialled again; the socket stays open. */
  onresuming: ((on: boolean) => void) | null = null
  private stream: BridgeStream | null = null
  private id: string | null = null
  private resumable = false
  private outbox: OutboxItem[] = []
  private redo: Batch[] = []
  private flying = 0
  private readonly posts = new Set<AbortController>()
  private keysHeld = false
  /** The last the line was heard of before it went down. */
  private lossHeard: number | undefined
  private nextSeq = 1
  private lastN = 0
  private painted_ = 0
  private ackSent = 0
  private ackQueued = false
  /** The newest H.264 chunk decoded, and the newest the Mac has been told of. */
  private decoded_ = 0
  private decodedSent = 0
  /** An acknowledgement-only POST is on its way: the one allowed past the in-flight cap. */
  private ackFlying = false
  /** When the last acknowledgement-only POST went, and the one waiting for the gap to end. */
  private ackAloneAt = 0
  private ackTimer: ReturnType<typeof setTimeout> | null = null
  /** The Mac reads acknowledgements as `v` (its hello said `acks`). */
  private acksApart = false
  private lastHeard = 0
  private lastTick = 0
  private resuming = false
  private resumedAt = 0
  private attempt = 0
  private deadline = 0
  private dialTimer: ReturnType<typeof setTimeout> | null = null
  private patience: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private watchdog: ReturnType<typeof setInterval> | null = null
  private unwatch: (() => void) | null = null

  constructor(private readonly deps: BridgeSocketDeps) {
    try {
      this.listen(deps.stream())
    } catch {
      queueMicrotask(() => this.end(true))
    }
  }

  send(text: string): void {
    if (this.readyState !== OPEN || this.id === null) throw new DOMException('not open', 'InvalidStateError')
    // AN H.264 ACKNOWLEDGEMENT DOES NOT QUEUE BEHIND INPUT (cast-video.ts). The
    // Mac sends the next chunk only once the last are acknowledged, so one stuck
    // behind a burst of touches held the picture back: 1.2 frames a second on a
    // line with room for ten (11-24). It rides apart, as `v`, newest only.
    const decoded = this.acksApart ? videoAckOf(text) : null
    if (decoded !== null) {
      if (decoded > this.decoded_) this.decoded_ = decoded
      this.queuePump()
      return
    }
    // A press on a picture nobody can vouch for goes nowhere, and neither does what
    // is typed for it. The chip says the line is down.
    if (this.resuming && aimedInput(text)) {
      this.keysHeld = true
      return
    }
    const waiting = this.outbox.at(-1)
    const folded = waiting ? coalesceInput(waiting.text, text) : null
    const item = { text: folded ?? text, at: Date.now() }
    this.outbox = folded !== null ? [...this.outbox.slice(0, -1), item] : [...this.outbox, item].slice(-OUTBOX_MAX)
    this.pump()
  }

  /** A frame was drawn or passed over: the Mac may send the next. */
  painted(seq: number): void {
    if (!this.resumable || seq <= this.painted_) return
    this.painted_ = seq
    this.queuePump()
  }

  /** Receipts and acknowledgements gathered in one turn go in one POST. */
  private queuePump(): void {
    if (this.ackQueued) return
    this.ackQueued = true
    queueMicrotask(() => {
      this.ackQueued = false
      this.pump()
    })
  }

  close(): void {
    if (this.readyState === CLOSED) return
    const id = this.id
    const leaving = this.resumable && id !== null ? this.takeBatch() : null
    this.readyState = CLOSING
    if (this.resumable && id !== null) {
      // Best effort: the Mac's own clock ends a session nobody says goodbye to.
      void this.deps.post(id, { ...(leaving ? { s: leaving.s, m: leaving.items.map((i) => i.text) } : {}), end: true }).catch(() => undefined)
    }
    this.end(false)
  }

  private listen(stream: BridgeStream): void {
    this.stream = stream
    const live = (): boolean => this.stream === stream
    const deliver = (data: string): void => {
      if (this.readyState === OPEN) this.onmessage?.(new MessageEvent('message', { data }))
    }
    const parsed = (event: Event): unknown => {
      this.lastHeard = Date.now()
      try {
        return JSON.parse(String((event as MessageEvent).data))
      } catch {
        return undefined
      }
    }
    stream.addEventListener('id', (event) => {
      if (!live()) return
      const hello = parsed(event) as { id?: unknown; v?: unknown; acks?: unknown } | undefined
      if (this.readyState === OPEN) return this.resumed()
      if (this.readyState !== CONNECTING) return
      if (typeof hello?.id !== 'string') return this.fail()
      this.id = hello.id
      this.resumable = hello.v === 2
      // A Mac that reads `v` says so; an older one gets its acknowledgements as messages.
      this.acksApart = this.resumable && hello.acks === true
      this.readyState = OPEN
      if (this.resumable) this.watchLine()
      this.onopen?.(new Event('open'))
    })
    // Old Mac: every message is `m`. Otherwise `c` is numbered, `f` and `b` are not:
    // a picture is replaced by the next one, and is never worth replaying. `v` is
    // an H.264 chunk: in order, every one, and not replayed either (cast-video.ts).
    for (const type of ['m', 'f', 'b', 'v']) {
      stream.addEventListener(type, (event) => {
        if (!live()) return
        const data = parsed(event)
        if (type === 'b') deliver(JSON.stringify(data))
        else if (typeof data === 'string') deliver(data)
      })
    }
    stream.addEventListener('c', (event) => {
      if (!live()) return
      const data = parsed(event)
      if (!Array.isArray(data) || typeof data[0] !== 'number' || typeof data[1] !== 'string') return
      if (data[0] <= this.lastN) return
      this.lastN = data[0]
      deliver(data[1])
    })
    stream.addEventListener('hb', () => {
      if (live()) this.lastHeard = Date.now()
    })
    // One session per stream: an EventSource that reconnects by itself would
    // open a second socket on the Mac, so any error is ours to answer.
    stream.addEventListener('error', () => {
      if (!live()) return
      if (this.readyState === OPEN && this.resumable) this.lost()
      else this.fail()
    })
  }

  private watchLine(): void {
    this.lastHeard = Date.now()
    this.lastTick = this.lastHeard
    this.unwatch = this.deps.watch?.(() => this.networkChanged()) ?? null
    this.watchdog = setInterval(() => {
      const now = Date.now()
      const slept = now - this.lastTick > WOKE_LATE_MS
      this.lastTick = now
      if (this.resuming) return
      const hidden = typeof document !== 'undefined' && document.hidden
      if (slept) this.networkChanged()
      else if (!hidden && now - this.lastHeard > BRIDGE_SILENT_MS) this.lost()
    }, 1000)
  }

  private networkChanged(): void {
    if (this.readyState !== OPEN || !this.resumable) return
    if (this.resuming) {
      if (this.dialTimer !== null) {
        clearTimeout(this.dialTimer)
        this.dial()
      }
      return
    }
    if (Date.now() - this.lastHeard > HEARD_LATELY_MS) this.lost()
  }

  private dropStream(): void {
    const stream = this.stream
    this.stream = null
    try {
      stream?.close()
    } catch {
      // Already closed.
    }
  }

  private clearPatience(): void {
    if (this.patience !== null) clearTimeout(this.patience)
    this.patience = null
  }

  /** The line is gone: dial it again, for as long as the budget lasts. */
  private lost(): void {
    if (this.readyState !== OPEN) return
    this.dropStream()
    this.clearPatience()
    if (!this.resuming) {
      this.resuming = true
      this.lossHeard = this.lastHeard
      this.attempt = 0
      this.deadline = Date.now() + BRIDGE_RESUME_BUDGET_MS
      this.onresuming?.(true)
    }
    if (this.dialTimer !== null) return
    const wait = DIAL_BACKOFF_MS[Math.min(this.attempt, DIAL_BACKOFF_MS.length - 1)]
    this.attempt += 1
    this.dialTimer = setTimeout(() => this.dial(), wait)
  }

  private dial(): void {
    this.dialTimer = null
    const id = this.id
    if (this.readyState !== OPEN || id === null) return
    if (Date.now() > this.deadline) return this.fail()
    try {
      this.listen(this.deps.stream({ id, after: this.lastN }))
    } catch {
      return this.lost()
    }
    this.patience = setTimeout(() => this.lost(), DIAL_PATIENCE_MS)
    // A stream refused looks like any failed connect. A POST says whether the Mac
    // still holds the session, so a restarted Mac costs one try and not the budget.
    void this.deps
      .post(id, { a: this.painted_ })
      .then((answer) => {
        if (answer === 'gone') this.fail()
      })
      .catch(() => undefined)
  }

  private resumed(): void {
    this.clearPatience()
    if (!this.resuming) return
    this.resuming = false
    this.resumedAt = Date.now()
    this.onresuming?.(false)
    // What is still in flight went down the old line and may never answer.
    for (const post of [...this.posts]) post.abort()
    this.pump()
  }

  private strip(items: readonly OutboxItem[]): OutboxItem[] {
    const stripped = stripStale(items, {
      now: Date.now(),
      keysHeld: this.keysHeld,
      heardAt: this.lossHeard,
      ...(this.resuming ? {} : { until: this.resumedAt })
    })
    this.keysHeld = stripped.keysHeld
    return stripped.items
  }

  private takeBatch(): Batch | null {
    const again = this.redo.shift()
    if (again) return { s: again.s, items: this.strip(again.items) }
    if (this.outbox.length === 0) return null
    const items = this.strip(this.outbox.slice(0, BRIDGE_POST_BATCH))
    this.outbox = this.outbox.slice(items.length)
    const batch = { s: this.nextSeq, items }
    this.nextSeq += items.length
    return batch
  }

  /** Messages leave in order and numbered; the Mac sorts out two that overtake. */
  private pump(): void {
    const id = this.id
    if (id === null || this.readyState !== OPEN || this.retryTimer !== null) return
    const cap = this.resumable ? BRIDGE_UP_IN_FLIGHT : 1
    while (this.flying < cap) {
      const batch = this.takeBatch()
      const ack = this.painted_ > this.ackSent ? this.painted_ : undefined
      const decoded = this.decoded_ > this.decodedSent ? this.decoded_ : undefined
      if (!batch && ack === undefined && decoded === undefined) return
      // An acknowledgement on its own waits for the gap, here as in sendAckAlone:
      // one POST per BRIDGE_ACK_MIN_MS carries the newest, not one per chunk.
      if (!batch && ack === undefined && this.resumable) {
        const since = Date.now() - this.ackAloneAt
        if (since < BRIDGE_ACK_MIN_MS) {
          if (this.ackTimer === null) {
            this.ackTimer = setTimeout(() => {
              this.ackTimer = null
              this.pump()
            }, BRIDGE_ACK_MIN_MS - since)
          }
          return
        }
        this.ackAloneAt = Date.now()
      }
      this.ackSent = this.painted_
      this.decodedSent = this.decoded_
      this.flying += 1
      const postedAt = Date.now()
      const texts = batch?.items.map((item) => item.text)
      const body: BridgeBody = this.resumable
        ? {
            ...(batch ? { s: batch.s, m: texts } : {}),
            ...(ack !== undefined ? { a: ack } : {}),
            ...(decoded !== undefined ? { v: decoded } : {})
          }
        : { m: texts }
      const abort = new AbortController()
      this.posts.add(abort)
      const timer = setTimeout(() => abort.abort(), BRIDGE_POST_TIMEOUT_MS)
      const landed = (): void => {
        clearTimeout(timer)
        this.posts.delete(abort)
        this.flying -= 1
      }
      void this.deps
        .post(id, body, abort.signal)
        .then((answer) => {
          landed()
          if (answer === 'gone') return this.fail()
          if (answer === 'retry') return this.again(batch)
          this.pump()
        })
        .catch(() => {
          landed()
          this.again(batch)
          // Proof the path died, unless a newer line has already replaced it.
          if (this.resumable && !this.resuming && postedAt >= this.resumedAt) this.lost()
        })
    }
    this.sendAckAlone(id)
  }

  /**
   * Both POSTs are busy with input and an H.264 acknowledgement is waiting:
   * one more POST may go, carrying nothing else. The Mac's next chunk waits on
   * it, and a finger's next position is worth less than the picture that shows it.
   */
  private sendAckAlone(id: string): void {
    if (!this.acksApart || this.ackFlying || this.resuming || this.decoded_ <= this.decodedSent) return
    // AT MOST ONE ACKNOWLEDGEMENT POST EVERY BRIDGE_ACK_MIN_MS. On a relay whose
    // round trip is near a second, six or more chunks in flight meant six or
    // more POSTs a second upstream, competing with the finger's own input
    // (measured 11-24: ack p50 690-1290 ms, input p50 up to 840 ms). The newest
    // acknowledgement stands for all of them, so one every this often says the
    // same thing with a fraction of the traffic.
    const since = Date.now() - this.ackAloneAt
    if (since < BRIDGE_ACK_MIN_MS) {
      if (this.ackTimer === null) {
        this.ackTimer = setTimeout(() => {
          this.ackTimer = null
          const live = this.id
          if (live !== null) this.sendAckAlone(live)
        }, BRIDGE_ACK_MIN_MS - since)
      }
      return
    }
    this.ackAloneAt = Date.now()
    const decoded = this.decoded_
    this.decodedSent = decoded
    this.ackFlying = true
    const abort = new AbortController()
    this.posts.add(abort)
    const timer = setTimeout(() => abort.abort(), BRIDGE_POST_TIMEOUT_MS)
    const landed = (): void => {
      clearTimeout(timer)
      this.posts.delete(abort)
      this.ackFlying = false
    }
    void this.deps
      .post(id, { v: decoded }, abort.signal)
      .then((answer) => {
        landed()
        if (answer === 'gone') return this.fail()
        // The relay busy: wait as every other POST does, then say it again.
        if (answer === 'retry') return this.again(null)
        this.pump()
      })
      .catch(() => {
        landed()
        // Said again after the retry wait, whether or not anything else goes; the
        // line's own watch decides whether it died.
        this.again(null)
      })
  }

  private again(batch: Batch | null): void {
    if (this.readyState !== OPEN) return
    if (!this.resumable) return this.pump()
    if (batch) this.redo = [...this.redo, batch].sort((a, b) => a.s - b.s)
    this.ackSent = 0
    this.decodedSent = 0
    if (this.retryTimer !== null) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.pump()
    }, POST_RETRY_MS)
  }

  private fail(): void {
    this.end(true)
  }

  private end(error: boolean): void {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this.outbox = []
    this.redo = []
    for (const timer of [this.dialTimer, this.patience, this.retryTimer, this.ackTimer]) if (timer !== null) clearTimeout(timer)
    this.dialTimer = this.patience = this.retryTimer = this.ackTimer = null
    for (const post of [...this.posts]) post.abort()
    if (this.watchdog !== null) clearInterval(this.watchdog)
    this.watchdog = null
    this.unwatch?.()
    this.unwatch = null
    this.dropStream()
    if (error) this.onerror?.(new Event('error'))
    this.onclose?.(new Event('close'))
  }
}
