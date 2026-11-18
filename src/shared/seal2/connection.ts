import type { SealRecord } from '../canvas-seal'
import { createInbox, encodeRecord, type InboxAnswer } from '../canvas-seal-wire'
import { decodeFrame2, encodeFrame2, isStreamKind, type Fields, type Frame2 } from './frames'
import type { Seal2Session } from './records'
import { ABORT, ACK_DELAY_MS, HARD_LIMIT, HIGH_WATER, MAX_STREAMS, PING_MS, SILENT_MS, STREAM_WINDOW } from './spec'
import { createStream, Seal2StreamError, type Seal2Stream, type StreamControl } from './stream'

export { Seal2StreamError, type Seal2Stream } from './stream'

/**
 * A COOKREW-SEAL/2 SESSION, WHATEVER CARRIES IT (spec.ts §3-4).
 *
 * Both ends run this: the Mac's terminus, the phone page, the console, and a
 * desktop dialling another. It turns streams into sealed records and back, and
 * keeps every record it sent until the far end acks it, so a carrier that
 * drops a line can be handed the very same bytes again (`replay`).
 *
 * WHAT THE CARRIER MUST DO: pass `send`'s bytes on in order, hand whole
 * records to `receive`, call `replay(from)` when a line is replaced, call
 * `drained()` when its own queue empties, and call `tick()` every few seconds.
 * Long-poll and POST today (seal2/http-link.ts, main/seal2-terminus.ts); a
 * WebSocket later is the same four calls.
 */

export interface Seal2Limits {
  readonly maxStreams: number
  readonly streamWindow: number
  readonly highWater: number
  readonly hardLimit: number
  readonly pingMs: number
  readonly silentMs: number
  readonly ackDelayMs: number
  /** A stream whose reader took nothing for this long while the far end waited on credit is aborted. */
  readonly stallMs: number
}

const DEFAULT_LIMITS: Seal2Limits = {
  maxStreams: MAX_STREAMS,
  streamWindow: STREAM_WINDOW,
  highWater: HIGH_WATER,
  hardLimit: HARD_LIMIT,
  pingMs: PING_MS,
  silentMs: SILENT_MS,
  ackDelayMs: ACK_DELAY_MS,
  stallMs: 120_000
}

export interface Seal2ConnectionOptions {
  readonly session: Seal2Session
  readonly role: 'initiator' | 'responder'
  /** One record's wire bytes, in order. */
  send(wire: Uint8Array): void
  /** Bytes the carrier holds and has not sent yet. */
  backlog?(): number
  /** A stream the far end opened. Respond, or abort it. Absent: every stream is refused. */
  onStream?(stream: Seal2Stream): void
  /** Clean when both ends said GOAWAY's goodbye; anything else is a line lost or a fault. */
  onClose?(why: string, clean: boolean): void
  readonly limits?: Partial<Seal2Limits>
  now?(): number
  log?(line: string): void
}

export interface Seal2Connection {
  readonly id: string
  readonly closed: boolean
  openStream(kind: string, fields?: Fields): Seal2Stream
  /** Records off the wire. 'forged' never delivers anything; 'ahead' means send again later. */
  receive(records: readonly SealRecord[]): Promise<InboxAnswer[]>
  /** The unacknowledged records from `from` on, as the same bytes: for a new line. */
  replay(from: number): Uint8Array[]
  /** The next record this end waits for: what a new line asks to start from. */
  expecting(): number
  drained(): void
  /** A PING now: a new line opens at the far end only once bytes cross it. */
  ping(): void
  tick(at?: number): void
  goaway(reason: string): void
  close(why: string): void
  lastHeard(): number
  stats(): { streams: number; retained: number; queued: number; sent: number }
}

interface Kept {
  readonly seq: number
  wire: Uint8Array | null
}

export function createSeal2Connection(options: Seal2ConnectionOptions): Seal2Connection {
  const { session, role } = options
  const limits: Seal2Limits = { ...DEFAULT_LIMITS, ...options.limits }
  const now = options.now ?? Date.now
  const log = options.log ?? ((): void => undefined)
  const backlog = options.backlog ?? ((): number => 0)
  const streams = new Map<number, StreamControl>()
  /** Streams of ours past the far end's limit, waiting their turn, with what they said meanwhile. */
  const waitingOpens: Array<{ readonly id: number; readonly open: Frame2; readonly held: Frame2[]; readonly let: () => void; readonly sent: Promise<void> }> = []
  const mine = role === 'initiator' ? 1 : 0
  let nextOwn = role === 'initiator' ? 1 : 2
  let highestTheirs = 0
  let kept: Kept[] = []
  let keptHead = 0
  let retained = 0
  let queued = 0
  let sealedCount = 0
  let acked = 0
  let tail: Promise<void> = Promise.resolve()
  let roomWaiters: Array<() => void> = []
  let lastHeard = now()
  let lastPing = now()
  let ackTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let leaving = false
  let theyLeave = false
  let goodbye = ''

  const pressure = (): number => retained + queued + backlog()

  const releaseRoom = (): void => {
    if (pressure() > limits.highWater && !closed) return
    const waiting = roomWaiters
    roomWaiters = []
    for (const resolve of waiting) resolve()
  }

  const close = (why: string, clean = false): void => {
    if (closed) return
    closed = true
    if (ackTimer !== null) clearTimeout(ackTimer)
    for (const waiting of waitingOpens.splice(0)) waiting.let()
    for (const control of [...streams.values()]) control.fail(new Seal2StreamError(ABORT.ended, `the session ended: ${why}`, false))
    streams.clear()
    kept = []
    keptHead = 0
    retained = 0
    releaseRoom()
    log(`seal2: session ended, ${why}`)
    options.onClose?.(why, clean)
  }

  const put = async (plain: Uint8Array): Promise<void> => {
    const record = await session.seal(plain)
    queued -= plain.length
    if (closed) return
    const wire = encodeRecord(record)
    kept.push({ seq: record.seq, wire })
    retained += wire.length
    sealedCount = record.seq + 1
    options.send(wire)
  }

  /** One at a time: the cipher is asynchronous, and the wire must stay in sequence. */
  const send = (frame: Frame2): void => {
    if (closed) return
    const plain = encodeFrame2(frame)
    queued += plain.length
    if (retained + queued > limits.hardLimit) return close('the far end fell too far behind')
    tail = tail.then(() => put(plain)).catch((error: unknown) => close(`sealing failed: ${String(error)}`))
  }

  const maybeLeave = (): void => {
    if ((leaving || theyLeave) && streams.size === 0 && !closed) void tail.then(() => close(goodbye, true))
  }

  const ownOpen = (): number => [...streams.keys()].filter((id) => id % 2 === mine && !waitingOpens.some((waiting) => waiting.id === id)).length

  /** Opens in the order asked, so ids still rise on the wire. */
  const letWaitingIn = (): void => {
    while (waitingOpens.length > 0 && ownOpen() < limits.maxStreams && !closed) {
      const next = waitingOpens.shift()
      if (next === undefined) return
      send(next.open)
      for (const frame of next.held) send(frame)
      next.let()
    }
  }

  const room = (): Promise<void> => (pressure() <= limits.highWater || closed ? Promise.resolve() : new Promise<void>((resolve) => roomWaiters.push(resolve)))

  const retire = (id: number): void => {
    streams.delete(id)
    const waiting = waitingOpens.findIndex((entry) => entry.id === id)
    // Ended before its turn came: the far end never hears of it.
    if (waiting >= 0) waitingOpens.splice(waiting, 1)[0].let()
    letWaitingIn()
    maybeLeave()
  }

  const host = { send, window: limits.streamWindow, room, retire, now }

  /** A stream of ours speaks only once its OPEN has gone: its body waits for that, outside any count. */
  const hostFor = (id: number) => ({
    ...host,
    room: async (): Promise<void> => {
      await waitingOpens.find((entry) => entry.id === id)?.sent
      return room()
    },
    send: (frame: Frame2): void => {
      const waiting = waitingOpens.find((entry) => entry.id === id)
      if (waiting === undefined) return send(frame)
      if (frame.kind !== 'abort') waiting.held.push(frame)
    }
  })

  const sendAck = (): void => {
    if (ackTimer !== null) clearTimeout(ackTimer)
    ackTimer = null
    send({ kind: 'ack', stream: 0, next: inbox.next() })
  }

  const ackSoon = (): void => {
    if (limits.ackDelayMs <= 0) return sendAck()
    ackTimer ??= setTimeout(sendAck, limits.ackDelayMs)
  }

  const acknowledged = (next: number): void => {
    if (next > sealedCount || next <= acked) return
    acked = next
    while (keptHead < kept.length && kept[keptHead].seq < next) {
      retained -= kept[keptHead].wire?.length ?? 0
      kept[keptHead].wire = null
      keptHead += 1
    }
    if (keptHead > 1024) {
      kept = kept.slice(keptHead)
      keptHead = 0
    }
    releaseRoom()
  }

  const opened = (frame: Extract<Frame2, { kind: 'open' }>): void => {
    const id = frame.stream
    if (id % 2 === mine || id <= highestTheirs) return close('protocol: a stream id out of turn')
    highestTheirs = id
    if (leaving) return send({ kind: 'abort', stream: id, code: ABORT.refused, reason: 'going away' })
    // The far end's own open streams count against it, never this end's.
    const theirs = [...streams.keys()].filter((open) => open % 2 !== mine).length
    if (theirs >= limits.maxStreams) return send({ kind: 'abort', stream: id, code: ABORT.busy, reason: 'too many streams' })
    if (options.onStream === undefined) return send({ kind: 'abort', stream: id, code: ABORT.unknownKind, reason: 'no streams here' })
    const control = createStream(host, id, frame.type, frame.fields, 'there')
    streams.set(id, control)
    try {
      options.onStream(control.stream)
    } catch (error) {
      control.stream.abort(ABORT.internal, 'the handler failed')
      log(`seal2: a stream handler failed: ${String(error)}`)
    }
  }

  const heard = (frame: Frame2): void => {
    // A frame in the same batch as the fault that ended the session is not acted on.
    if (closed) return
    if (frame.kind === 'open') return opened(frame)
    if (frame.kind === 'ack') return acknowledged(frame.next)
    if (frame.kind === 'ping') return
    if (frame.kind === 'goaway') {
      theyLeave = true
      goodbye = frame.reason
      return maybeLeave()
    }
    // Frames for a stream already over are late, not wrong.
    const control = streams.get(frame.stream)
    if (control === undefined) return
    if (frame.kind === 'head') control.onHead(frame.status, frame.fields)
    else if (frame.kind === 'data') control.onData(frame.data)
    else if (frame.kind === 'end') control.onEnd()
    else if (frame.kind === 'credit') control.onCredit(frame.bytes)
    else if (frame.kind === 'abort') control.onAbort(frame.code, frame.reason)
  }

  let wantsAck = false
  const inbox = createInbox(
    session,
    (plain) => {
      const frame = decodeFrame2(plain)
      if (frame === null) return close('protocol: a frame that is not one')
      if (frame.kind !== 'ack') wantsAck = true
      heard(frame)
    },
    (error) => log(`seal2: a frame failed: ${String(error)}`)
  )

  return {
    id: session.id,
    get closed() {
      return closed
    },
    openStream(kind, fields = {}) {
      if (closed) throw new Error('The sealed session has ended')
      if (leaving || theyLeave) throw new Error('The sealed session is going away')
      if (!isStreamKind(kind)) throw new Error(`Not a stream kind: ${kind}`)
      const id = nextOwn
      nextOwn += 2
      const open: Frame2 = { kind: 'open', stream: id, type: kind, fields }
      const full = waitingOpens.length > 0 || ownOpen() >= limits.maxStreams
      // Encoded now, so a field that cannot be sent fails here and not later.
      encodeFrame2(open)
      if (full) {
        let lets = (): void => undefined
        const sent = new Promise<void>((resolve) => (lets = resolve))
        waitingOpens.push({ id, open, held: [], let: () => lets(), sent })
      }
      const control = createStream(hostFor(id), id, kind, fields, 'here')
      streams.set(id, control)
      if (!full) send(open)
      return control.stream
    },
    async receive(records) {
      const answers: InboxAnswer[] = []
      for (const record of records) {
        if (closed) break
        const answer = await inbox.accept(record)
        answers.push(answer)
        if (answer === 'taken') lastHeard = now()
        // A resend means our ack went missing: say it again.
        if (answer === 'duplicate') wantsAck = true
        // One failed open per batch: a carrier without the keys buys no more than that.
        if (answer === 'forged') break
      }
      if (wantsAck && !closed) {
        wantsAck = false
        ackSoon()
      }
      return answers
    },
    replay: (from) => kept.slice(keptHead).flatMap(({ seq, wire }) => (seq >= from && wire !== null ? [wire] : [])),
    expecting: () => inbox.next(),
    drained: releaseRoom,
    ping() {
      lastPing = now()
      send({ kind: 'ping', stream: 0 })
    },
    tick(at = now()) {
      if (closed) return
      if (at - lastHeard > limits.silentMs) return close('the far end went silent')
      for (const control of [...streams.values()]) if (control.stalled(at, limits.stallMs)) control.stream.abort(ABORT.timeout, 'nobody read the answer')
      releaseRoom()
      if (at - lastPing < limits.pingMs) return
      lastPing = at
      send({ kind: 'ping', stream: 0 })
    },
    goaway(reason) {
      if (closed || leaving) return
      leaving = true
      goodbye = reason
      send({ kind: 'goaway', stream: 0, code: ABORT.none, reason })
      maybeLeave()
    },
    close: (why) => close(why),
    lastHeard: () => lastHeard,
    stats: () => ({ streams: streams.size, retained, queued, sent: sealedCount })
  }
}
