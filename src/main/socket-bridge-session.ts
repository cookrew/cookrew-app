/**
 * ONE BRIDGED SOCKET THAT OUTLIVES ITS LINE (socket-bridge.ts).
 *
 * The event stream down to a phone dies every time the phone changes network,
 * and what hangs on it here is expensive: a viewer in the card's Chrome, its
 * viewport claim, its frame contexts. So the session is held apart from the
 * response. A dropped stream detaches it; the phone comes back with the session
 * id and the last message it saw; for SOCKET_BRIDGE_RESUME_MS the Chrome side
 * never knows. Control messages are numbered and kept for that replay. A frame is
 * not: each is the whole picture, so all that is kept is the newest.
 *
 * FRAMES GO AT THE SPEED THEY ARE PAINTED. The response's own buffer says nothing
 * here: on the relay it is a loopback socket the bridge reads eagerly, so frames
 * would pile up further along, where only the phone feels it, as a picture that
 * falls further behind the finger. The phone's receipts are the one honest
 * measure of the whole path, so only so many frames are unreceipted at a time. That
 * number is felt out from how long receipts take: while a frame comes back about as
 * fast as the fastest one lately, there is room for more; once they slow down,
 * frames are queueing somewhere, and a queue is exactly the delay a finger feels.
 * Measured on a 350 KB/s line, a fixed three filled it: more frames, no less delay.
 *
 * A STILL PAGE COSTS A BEAT. Chrome's side resends the same JPEG every 750 ms so a
 * viewer can tell a still page from a dead line (headless-chrome.ts · STATIC_FRAME_
 * HEARTBEAT_MS). On the relay that was the whole picture again; here it is `same`
 * and a sequence number, which keeps the phone's frame context current and costs
 * no credit.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import type http from 'node:http'
import { startSse, type SseSend } from './mobile-http'
import type { LoopbackSocket } from './ws-client'

export const SOCKET_BRIDGE_RESUME_MS = 30_000
/** A phone gone this long gives the viewport up, so the Mac's own view is not held to its shape. */
export const SOCKET_BRIDGE_RELEASE_MS = 3000
/** Frames sent and not yet painted: where the count starts and how far it can go. */
export const SOCKET_BRIDGE_CREDIT = 2
export const SOCKET_BRIDGE_CREDIT_MAX = 6
/** How much slower than the fastest lately a receipt may be and still be no queue. */
const QUEUE_SLACK = 1.2
const QUEUE_SLACK_MS = 40
/** The fastest receipt is forgotten after this: a phone moves to a slower network. */
const FASTEST_MEMORY_MS = 10_000
export const SOCKET_BRIDGE_CREDIT_BYTES = 384 * 1024
/** Fifteen a second: past this a phone's own decode is the limit. */
export const SOCKET_BRIDGE_MIN_FRAME_MS = 66
/** A receipt this late was lost: the frame stops counting against the credit. */
export const SOCKET_BRIDGE_CREDIT_TIMEOUT_MS = 2500
export const SOCKET_BRIDGE_BEAT_MS = 1000
/** Past this many bytes queued for the phone, stop reading the socket until the stream drains. */
export const SOCKET_BRIDGE_HIGH = 2 * 1024 * 1024
/** Control messages kept for a phone that comes back. */
const RING_MESSAGES = 256
const RING_BYTES = 256 * 1024
/** POSTs that may wait for an earlier one. */
const HELD_POSTS = 32

/** A browser card's screencast frame: each one is the whole picture. */
export const isBrowserFrame = (text: string): boolean => text.startsWith('{"t":"frame"')

/** What a phone posts up a resumable session. */
export interface BridgeUp {
  readonly s?: number
  readonly m?: readonly string[]
  readonly a?: number
  readonly end?: boolean
}

interface Listener {
  readonly response: http.ServerResponse
  readonly send: SseSend
  readonly beat: ReturnType<typeof setInterval>
}

interface Held {
  readonly text: string
  readonly seq: number
  readonly data: string | null
  readonly revision: number | undefined
}

const sameCredential = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

const frameOf = (text: string): Held => {
  try {
    const frame = JSON.parse(text) as { seq?: unknown; data?: unknown; meta?: { revision?: unknown } }
    return {
      text,
      seq: typeof frame.seq === 'number' ? frame.seq : 0,
      data: typeof frame.data === 'string' ? frame.data : null,
      revision: typeof frame.meta?.revision === 'number' ? frame.meta.revision : undefined
    }
  } catch {
    return { text, seq: 0, data: null, revision: undefined }
  }
}

export class BridgeSession {
  readonly id = randomUUID()
  private listener: Listener | null = null
  private upstream: LoopbackSocket | null = null
  private ended = false
  private paused = false
  detachedAt: number | null = null
  private nextN = 1
  private ring: { n: number; text: string }[] = []
  private ringBytes = 0
  private held: Held | null = null
  private lastData: string | null = null
  private lastRevision: number | undefined
  private releaseTimer: ReturnType<typeof setTimeout> | null = null
  private inFlight: { seq: number; bytes: number; at: number }[] = []
  private lastSentAt = 0
  private credit = SOCKET_BRIDGE_CREDIT
  private fastest = Number.POSITIVE_INFINITY
  private fastestAt = 0
  private frameTimer: ReturnType<typeof setTimeout> | null = null
  private nextUp = 1
  private readonly waitingUp = new Map<number, readonly string[]>()

  constructor(
    private readonly credential: string,
    private readonly now: () => number,
    private readonly onEnd: (id: string) => void,
    private readonly onDetach: () => void
  ) {}

  /** The socket on the Mac's side, once dialled. */
  bind(upstream: LoopbackSocket): void {
    this.upstream = upstream
  }

  attach(response: http.ServerResponse): void {
    const send = startSse(response)
    const beat = setInterval(() => send('hb', {}), SOCKET_BRIDGE_BEAT_MS)
    beat.unref?.()
    const listener: Listener = { response, send, beat }
    this.dropListener()
    this.listener = listener
    this.detachedAt = null
    this.clearRelease()
    response.on('close', () => {
      clearInterval(beat)
      if (this.listener !== listener) return
      this.listener = null
      this.detachedAt = this.now()
      this.releaseTimer = setTimeout(() => this.upstream?.send('{"t":"viewport-release"}'), SOCKET_BRIDGE_RELEASE_MS)
      this.releaseTimer.unref?.()
      this.onDetach()
    })
  }

  private clearRelease(): void {
    if (this.releaseTimer !== null) clearTimeout(this.releaseTimer)
    this.releaseTimer = null
  }

  /** The phone that opened this session, by the token it presented. */
  owns(credential: string): boolean {
    return sameCredential(credential, this.credential)
  }

  private dropListener(): void {
    const old = this.listener
    this.listener = null
    if (!old) return
    clearInterval(old.beat)
    if (!old.response.writableEnded) old.response.end()
  }

  opened(): void {
    this.listener?.send('id', { id: this.id, v: 2 })
  }

  /** False when this phone cannot pick the session up from where it says it was. */
  resume(after: number, response: http.ServerResponse, credential: string): boolean {
    if (this.ended || !this.owns(credential)) return false
    const oldest = this.ring[0]?.n ?? this.nextN
    if (after + 1 < oldest) return false
    this.attach(response)
    this.listener?.send('id', { id: this.id, v: 2 })
    for (const entry of this.ring) if (entry.n > after) this.listener?.send('c', [entry.n, entry.text])
    // Nothing in flight survived the line, and the picture has to be sent whole.
    this.inFlight = []
    this.lastData = null
    this.lastSentAt = 0
    // A drain armed on the old response will never fire.
    if (this.paused) {
      this.paused = false
      this.upstream?.resume()
    }
    // Very likely another network: what was learned about the last one is no use.
    this.credit = SOCKET_BRIDGE_CREDIT
    this.fastest = Number.POSITIVE_INFINITY
    this.pump()
    return true
  }

  fromSocket(text: string): void {
    if (isBrowserFrame(text)) this.frame(text)
    else this.control(text)
  }

  private control(text: string): void {
    const n = this.nextN
    this.nextN += 1
    this.ring = [...this.ring, { n, text }]
    this.ringBytes += text.length
    while (this.ring.length > RING_MESSAGES || this.ringBytes > RING_BYTES) {
      const [dropped, ...rest] = this.ring
      this.ring = rest
      this.ringBytes -= dropped.text.length
    }
    const listener = this.listener
    if (!listener) return
    listener.send('c', [n, text])
    if (this.paused || listener.response.writableLength <= SOCKET_BRIDGE_HIGH) return
    this.paused = true
    this.upstream?.pause()
    listener.response.once('drain', () => {
      this.paused = false
      this.upstream?.resume()
    })
  }

  private frame(text: string): void {
    const frame = frameOf(text)
    // Same bytes under a new viewport revision are still a new picture to the phone.
    if (this.listener && !this.held && frame.data !== null && frame.data === this.lastData && frame.revision === this.lastRevision) {
      const { revision } = frame
      this.listener.send('b', { t: 'same', seq: frame.seq, ...(revision !== undefined ? { revision } : {}) })
      return
    }
    this.held = frame
    this.pump()
  }

  private pump(): void {
    if (this.frameTimer !== null) {
      clearTimeout(this.frameTimer)
      this.frameTimer = null
    }
    const listener = this.listener
    const held = this.held
    if (this.ended || !listener || !held) return
    const now = this.now()
    const unreceipted = this.inFlight.length
    this.inFlight = this.inFlight.filter((frame) => now - frame.at < SOCKET_BRIDGE_CREDIT_TIMEOUT_MS)
    // That late means queueing, or a line this slow should be sent less.
    if (this.inFlight.length < unreceipted) this.credit = Math.max(SOCKET_BRIDGE_CREDIT, this.credit - 1)
    const bytes = this.inFlight.reduce((sum, frame) => sum + frame.bytes, 0)
    if (this.inFlight.length >= Math.floor(this.credit) || bytes >= SOCKET_BRIDGE_CREDIT_BYTES) {
      this.frameTimer = setTimeout(() => this.pump(), SOCKET_BRIDGE_CREDIT_TIMEOUT_MS)
      return
    }
    const wait = this.lastSentAt + SOCKET_BRIDGE_MIN_FRAME_MS - now
    if (wait > 0) {
      this.frameTimer = setTimeout(() => this.pump(), wait)
      return
    }
    this.held = null
    this.lastData = held.data
    this.lastRevision = held.revision
    this.lastSentAt = now
    this.inFlight = [...this.inFlight, { seq: held.seq, bytes: held.text.length, at: now }]
    listener.send('f', held.text)
  }

  post(up: BridgeUp): void {
    if (typeof up.a === 'number') {
      const painted = up.a
      for (const frame of this.inFlight) if (frame.seq <= painted) this.learn(this.now() - frame.at)
      this.inFlight = this.inFlight.filter((frame) => frame.seq > painted)
      this.pump()
    }
    if (up.m && up.m.length > 0) this.takeUp(up.s ?? this.nextUp, up.m)
    if (up.end) this.end()
  }

  private learn(took: number): void {
    const now = this.now()
    if (took <= this.fastest || now - this.fastestAt > FASTEST_MEMORY_MS) {
      this.fastest = took
      this.fastestAt = now
    }
    const queueing = took > this.fastest * QUEUE_SLACK + QUEUE_SLACK_MS
    this.credit = queueing
      ? Math.max(SOCKET_BRIDGE_CREDIT, this.credit - 1)
      : Math.min(SOCKET_BRIDGE_CREDIT_MAX, this.credit + 0.25)
  }

  /** In order and once, however the POSTs arrived. */
  private takeUp(start: number, messages: readonly string[]): void {
    if (start > this.nextUp) {
      if (this.waitingUp.size < HELD_POSTS) this.waitingUp.set(start, messages)
      return
    }
    this.deliver(start, messages)
    for (;;) {
      const next = this.waitingUp.get(this.nextUp)
      if (!next) break
      this.waitingUp.delete(this.nextUp)
      this.deliver(this.nextUp, next)
    }
    for (const start of [...this.waitingUp.keys()]) if (start < this.nextUp) this.waitingUp.delete(start)
  }

  private deliver(start: number, messages: readonly string[]): void {
    const fresh = messages.slice(Math.max(0, this.nextUp - start))
    this.nextUp = Math.max(this.nextUp, start + messages.length)
    for (const message of fresh) if (message.length > 0) this.upstream?.send(message)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    if (this.frameTimer !== null) clearTimeout(this.frameTimer)
    this.clearRelease()
    this.held = null
    this.ring = []
    this.onEnd(this.id)
    this.upstream?.close()
    this.dropListener()
  }
}
