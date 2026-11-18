import type { Fields, Frame2 } from './frames'
import { ABORT, CREDIT_STEP, DATA_MAX } from './spec'

/**
 * ONE STREAM OF A COOKREW-SEAL/2 SESSION (spec.ts §4), as web streams.
 *
 * Backpressure is the streams' own: `writable.write()` resolves once the far
 * end has given credit and the session has room, and the far end gives credit
 * only as `readable` is read. So a slow reader slows its own stream and no other.
 */

export class Seal2StreamError extends Error {
  constructor(
    readonly code: number,
    readonly reason: string,
    /** True when the far end said so; false when this end decided. */
    readonly remote: boolean
  ) {
    super(`The sealed stream ended: ${reason} (${code})`)
  }
}

export interface StreamHead {
  readonly status: number
  readonly fields: Fields
}

export interface Seal2Stream {
  readonly id: number
  readonly kind: string
  /** What OPEN carried. */
  readonly fields: Fields
  /** The far end's HEAD, on a stream this end opened. */
  readonly head: Promise<StreamHead>
  /** This end's HEAD, on a stream the far end opened. Before any write. */
  respond(status: number, fields?: Fields): void
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
  /** Ends the whole stream, both ways. */
  abort(code?: number, reason?: string): void
  /** Settles when both directions have ended; rejects with a Seal2StreamError on any abort. */
  readonly closed: Promise<void>
}

/** What a stream needs from its session. */
export interface StreamHost {
  send(frame: Frame2): void
  /** Resolves when the session has room for more. */
  room(): Promise<void>
  retire(id: number): void
  readonly window: number
}

/** The session's handle on a stream: frames in, and the end of the session. */
export interface StreamControl {
  readonly stream: Seal2Stream
  onHead(status: number, fields: Fields): void
  onData(data: Uint8Array): void
  onEnd(): void
  onCredit(bytes: number): void
  onAbort(code: number, reason: string): void
  fail(error: Seal2StreamError): void
}

interface Waiter {
  resolve(): void
}

const settledQuietly = <T>(promise: Promise<T>): Promise<T> => {
  promise.catch(() => undefined)
  return promise
}

export function createStream(host: StreamHost, id: number, kind: string, fields: Fields, opened: 'here' | 'there'): StreamControl {
  let sendCredit = host.window
  let receiveAllowance = host.window
  let uncredited = 0
  const queue: Uint8Array[] = []
  let headSeen = opened === 'there'
  let headSent = opened === 'here'
  let localEnded = false
  let remoteEnded = false
  let failure: Seal2StreamError | null = null
  let waiters: Waiter[] = []
  let readController: ReadableStreamDefaultController<Uint8Array> | null = null
  let writeController: WritableStreamDefaultController | null = null

  let headDone!: { resolve(head: StreamHead): void; reject(error: Error): void }
  const head = settledQuietly(new Promise<StreamHead>((resolve, reject) => (headDone = { resolve, reject })))
  let closedDone!: { resolve(): void; reject(error: Error): void }
  const closed = settledQuietly(new Promise<void>((resolve, reject) => (closedDone = { resolve, reject })))

  const wake = (): void => {
    const woken = waiters
    waiters = []
    for (const waiter of woken) waiter.resolve()
  }
  const waitFor = (): Promise<void> => new Promise((resolve) => waiters.push({ resolve }))

  const finishIfDone = (): void => {
    if (failure !== null || !localEnded || !remoteEnded || !headSeen || !headSent) return
    host.retire(id)
    closedDone.resolve()
  }

  const fail = (error: Seal2StreamError): void => {
    if (failure !== null) return
    failure = error
    host.retire(id)
    headDone.reject(error)
    closedDone.reject(error)
    queue.length = 0
    readController?.error(error)
    writeController?.error(error)
    wake()
  }

  const abort = (code: number = ABORT.cancel, reason = 'cancelled'): void => {
    if (failure !== null) return
    host.send({ kind: 'abort', stream: id, code, reason })
    fail(new Seal2StreamError(code, reason, false))
  }

  const violation = (reason: string): void => abort(ABORT.protocol, reason)

  /** Bytes the reader took are credit for the far end, given back in steps. */
  const consumed = (bytes: number): void => {
    uncredited += bytes
    if (remoteEnded || failure !== null || uncredited < Math.min(CREDIT_STEP, host.window / 2)) return
    receiveAllowance += uncredited
    host.send({ kind: 'credit', stream: id, bytes: uncredited })
    uncredited = 0
  }

  const readable = new ReadableStream<Uint8Array>(
    {
      start: (controller) => {
        readController = controller
      },
      pull: async (controller) => {
        while (queue.length === 0 && !remoteEnded && failure === null) await waitFor()
        if (failure !== null) return
        const chunk = queue.shift()
        if (chunk !== undefined) {
          controller.enqueue(chunk)
          consumed(chunk.length)
          return
        }
        controller.close()
      },
      cancel: () => abort(ABORT.cancel, 'the reader stopped')
    },
    { highWaterMark: 0 }
  )

  const alive = (): void => {
    if (failure !== null) throw failure
  }

  const writable = new WritableStream<Uint8Array>({
    start: (controller) => {
      writeController = controller
    },
    write: async (chunk) => {
      alive()
      if (!headSent) throw new Error('Respond before writing to a stream the far end opened')
      if (localEnded) throw new Error('This side of the stream has ended')
      for (let at = 0; at < chunk.length; ) {
        while (sendCredit <= 0 && failure === null) await waitFor()
        await host.room()
        alive()
        const size = Math.min(chunk.length - at, sendCredit, DATA_MAX)
        sendCredit -= size
        host.send({ kind: 'data', stream: id, data: chunk.subarray(at, at + size) })
        at += size
      }
    },
    close: () => {
      alive()
      if (!headSent) throw new Error('Respond before ending a stream the far end opened')
      localEnded = true
      host.send({ kind: 'end', stream: id })
      finishIfDone()
    },
    abort: () => abort(ABORT.cancel, 'the writer stopped')
  })

  const stream: Seal2Stream = {
    id,
    kind,
    fields,
    head,
    respond(status, responseFields = {}) {
      alive()
      if (headSent) throw new Error('This stream has its head already')
      headSent = true
      host.send({ kind: 'head', stream: id, status, fields: responseFields })
      finishIfDone()
    },
    readable,
    writable,
    abort,
    closed
  }

  return {
    stream,
    onHead(status, headFields) {
      if (headSeen) return violation('a second head')
      headSeen = true
      headDone.resolve({ status, fields: headFields })
      finishIfDone()
    },
    onData(data) {
      if (!headSeen) return violation('data before the head')
      if (remoteEnded) return violation('data after the end')
      if (data.length > receiveAllowance) return abort(ABORT.flow, 'sent past its credit')
      receiveAllowance -= data.length
      queue.push(data)
      wake()
    },
    onEnd() {
      if (!headSeen) return violation('an end before the head')
      if (remoteEnded) return violation('a second end')
      remoteEnded = true
      wake()
      finishIfDone()
    },
    onCredit(bytes) {
      if (sendCredit + bytes > 2 ** 32) return violation('credit past any window')
      sendCredit += bytes
      wake()
    },
    onAbort(code, reason) {
      fail(new Seal2StreamError(code, reason, true))
    },
    fail
  }
}
