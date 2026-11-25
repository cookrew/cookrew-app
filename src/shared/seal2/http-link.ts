import { createRecordReader } from '../canvas-seal-wire'
import { createSeal2Connection, type Seal2Connection, type Seal2ConnectionOptions } from './connection'
import type { Seal2Session } from './records'

/**
 * THE CALLER'S END OF A COOKREW-SEAL/2 SESSION OVER PLAIN HTTP, as the relay
 * carries it today: POST /~seal/hello and /~seal/finish, one long GET down,
 * POSTs up (main/canvas-seal-terminus.ts is the other end). The relay carries
 * no WebSocket; when one exists it replaces only this file.
 *
 * Runs wherever fetch does: the phone page, the console, and Electron's main
 * process dialling another desktop.
 *
 * THE LINE IS NOT TRUSTED FOR ANYTHING. A POST that fails is sent again as the
 * same bytes (the far end takes each record once); a down stream that ends is
 * opened again from the next record expected; a record that does not open ends
 * the session. Nothing here ever falls back to sending in the clear.
 */

const RETRY_MS = 1_000
const UP_MS = 20_000
const UP_TRIES = 6
const DOWN_TRIES = 8
const TICK_MS = 5_000
const UP_BATCH = 1024 * 1024
/**
 * POSTs on the line at once (owner 2026-11-25, "sealed之后整体反应变得卡顿"). One at a
 * time, a record sealed a moment after a POST left waited for that POST's whole
 * round trip: a request's last record left one round trip late, so a sealed
 * request cost two relay round trips where a plain one costs one. The Mac holds
 * records that arrive early and drops a resent one (canvas-seal-wire.ts · createInbox).
 *
 * Only a record a request or an answer waits for (the connection's `urgent`)
 * opens a POST beside others. An ACK, a CREDIT or a PING rides the next POST
 * out, or opens one when none is on the line: while an answer streams down the
 * session acks every 20 ms, and each a POST of its own was ~5 relay exchanges
 * per round trip, of the relay's 64 per Mac (v2-canvas-relay.ts · EXCHANGES_PER_LINK).
 */
export const UP_IN_FLIGHT = 8
/**
 * How far past the oldest record not yet answered a POST may reach, in
 * sequence numbers. Everything below that record the Mac has taken (its POST
 * was answered), so its inbox waits on no lower record, and holds up to
 * SEAL_WINDOW (1024) past it: a POST that overtakes an earlier one is held
 * there, never answered "ahead" and sent again. A span, not a count: POSTs
 * answered out of order free count while the gap behind them stays open.
 */
export const UP_SEQ_SPAN = 768
/**
 * Bytes on the line at once, all POSTs together. The relay buffers each POST's
 * body whole, from one budget all its Macs share (v2-canvas-relay.ts ·
 * BODY_BUDGET, 64 MiB): eight POSTs of a megabyte would be an eighth of it for
 * one upload. A batch larger than the room left still goes when it is alone.
 */
export const UP_BYTES_IN_FLIGHT = 2 * 1024 * 1024
/**
 * How long a record waits for the ones sealed with it. Sealing is async, so a
 * page opening (eight requests) seals its records one by one over a few
 * milliseconds; sent as they come, the first four took a POST each and the rest
 * waited a round trip. A few milliseconds against a relay round trip of hundreds.
 */
export const UP_GATHER_MS = 4

export interface HttpLinkDeps {
  /** Where a seal path lives: the relay's prefix for this machine, or the machine's own origin. */
  url(path: string): string
  readonly fetchFn?: typeof fetch
  readonly retryMs?: number
  readonly upMs?: number
}

/** "The Mac refused": a code it does not know or replaced, or a proof that failed. Nothing was sent. */
export class Seal2RefusedError extends Error {
  constructor(
    readonly why: 'code' | 'replaced' | 'proof' | 'device',
    message: string
  ) {
    super(message)
  }
}

export interface StartedHandshake<T extends { readonly finish: unknown }> {
  readonly hello: unknown
  finish(accept: unknown): Promise<T | null>
}

/** What the hello's 403 said, for the code's own check (canvas-seal.ts · checkReplaced). */
export type OnRefused = (said: Record<string, unknown> | null) => Promise<Seal2RefusedError>

const fetcher = (deps: HttpLinkDeps): typeof fetch => deps.fetchFn ?? ((input, init) => fetch(input, init))

/** Hello, then finish: nothing inside the session is sent until both checked. */
export async function shakeHandsOverHttp<T extends { readonly finish: unknown }>(deps: HttpLinkDeps, started: StartedHandshake<T>, onRefused: OnRefused): Promise<T> {
  const fetchFn = fetcher(deps)
  const post = (path: string, body: unknown): Promise<Response> =>
    fetchFn(deps.url(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const hello = await post('/~seal/hello', started.hello)
  if (hello.status === 403) throw await onRefused((await hello.json().catch(() => null)) as Record<string, unknown> | null)
  if (!hello.ok) throw new Error(`The sealed session did not open (${hello.status}).`)
  const answer = (await hello.json().catch(() => null)) as { session?: unknown; accept?: unknown } | null
  const done = await started.finish(answer?.accept).catch(() => null)
  if (done === null || typeof answer?.session !== 'string') throw new Seal2RefusedError('proof', 'The other end could not prove who it is.')
  const finish = await post('/~seal/finish', { session: answer.session, ...(done.finish as Record<string, unknown>) })
  if (finish.status === 403) throw new Seal2RefusedError('proof', 'The other end could not prove who it is.')
  if (!finish.ok) throw new Error(`The sealed session did not open (${finish.status}).`)
  return done
}

export interface Seal2Link {
  readonly connection: Seal2Connection
  /** Says goodbye, then lets go of the line. */
  close(): void
}

export type LinkOptions = Omit<Seal2ConnectionOptions, 'session' | 'role' | 'send' | 'backlog'>

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface Queued {
  readonly wire: Uint8Array
  readonly seq: number
  readonly urgent: boolean
}

/** One POST's records, from `first` on. */
interface Batch {
  readonly first: number
  readonly body: Uint8Array
}

/** The session, carried: a down stream kept open and an up queue sent in order. */
export function runSeal2Link(deps: HttpLinkDeps, session: Seal2Session, options: LinkOptions = {}): Seal2Link {
  const fetchFn = fetcher(deps)
  const retryMs = deps.retryMs ?? RETRY_MS
  const stop = new AbortController()
  /** Sealed, not yet on the line. */
  const outgoing: Queued[] = []
  /** Of those, the ones a request or an answer waits for. */
  let urgentWaiting = 0
  /** Every byte sealed and not yet taken by the far end: waiting and on the line alike (the session's backlog). */
  let outgoingBytes = 0
  /** POSTs not yet answered, retries included. */
  const inFlight = new Set<Batch>()
  let bytesInFlight = 0
  let ended = false
  /** The far end refused or is gone: what is still queued would only be refused too. */
  let failed = false
  let ticker: ReturnType<typeof setInterval> | null = null

  const end = (): void => {
    if (ended) return
    ended = true
    stop.abort()
    if (ticker !== null) clearInterval(ticker)
    if (gathering !== null) clearTimeout(gathering)
  }

  const connection = createSeal2Connection({
    ...options,
    session,
    role: 'initiator',
    send: (wire, { seq, urgent }) => {
      outgoing.push({ wire, seq, urgent })
      outgoingBytes += wire.length
      if (urgent) urgentWaiting += 1
      // A control record behind a POST on the line leaves when that POST is answered (flush, from carry's end).
      if (urgent || inFlight.size === 0) gather()
    },
    backlog: () => outgoingBytes,
    onClose: (why, clean) => {
      // What was already sealed (a GOAWAY, a last ACK) gets its moment to leave before the line is let go.
      void drainedOrLate().then(end)
      options.onClose?.(why, clean)
    }
  })
  const drainedOrLate = async (): Promise<void> => {
    const deadline = Date.now() + retryMs
    while (!failed && (outgoing.length > 0 || inFlight.size > 0) && Date.now() < deadline) await sleep(20)
  }
  const fail = (why: string): void => {
    failed = true
    connection.close(why)
  }
  const at = (path: string): string => deps.url(`${path}${path.includes('?') ? '&' : '?'}s=${encodeURIComponent(connection.id)}`)

  /** The status, or 0 for no answer at all. */
  const postBatch = async (body: Uint8Array): Promise<number> => {
    const hung = new AbortController()
    const timer = setTimeout(() => hung.abort(), deps.upMs ?? UP_MS)
    const release = (): void => hung.abort()
    stop.signal.addEventListener('abort', release, { once: true })
    try {
      const up = await fetchFn(at('/~seal/up'), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: body as BodyInit, signal: hung.signal })
      await up.arrayBuffer().catch(() => undefined)
      return up.status
    } catch {
      return 0
    } finally {
      clearTimeout(timer)
      stop.signal.removeEventListener('abort', release)
    }
  }

  /** The oldest record the far end may not have taken: its inbox waits on nothing lower. */
  const oldestUnanswered = (): number => [...inFlight].reduce((oldest, batch) => Math.min(oldest, batch.first), outgoing[0]?.seq ?? Infinity)

  /** How many records off the front of the queue go in the next POST: within its size, the bytes on the line, and the span. */
  const batchLength = (): number => {
    const alone = inFlight.size === 0
    const bytesRoom = Math.min(UP_BATCH, UP_BYTES_IN_FLIGHT - bytesInFlight)
    const spanEnd = oldestUnanswered() + UP_SEQ_SPAN
    let count = 0
    let size = 0
    for (; count < outgoing.length; count += 1) {
      const { wire, seq } = outgoing[count]
      if (seq >= spanEnd) break
      // The first record always goes on a line with nothing else on it, however large.
      if (size + wire.length > bytesRoom && !(alone && count === 0)) break
      size += wire.length
    }
    return count
  }

  /** The next records off the queue, in order, as one body; null when none may go yet. */
  const takeBatch = (): Batch | null => {
    const count = batchLength()
    if (count === 0) return null
    const taken = outgoing.splice(0, count)
    const body = new Uint8Array(taken.reduce((size, { wire }) => size + wire.length, 0))
    taken.reduce((offset, { wire }) => (body.set(wire, offset), offset + wire.length), 0)
    urgentWaiting -= taken.filter(({ urgent }) => urgent).length
    return { first: taken[0].seq, body }
  }

  let gathering: ReturnType<typeof setTimeout> | null = null
  /** The first record of a burst waits UP_GATHER_MS for the rest, then they leave together. */
  function gather(): void {
    if (gathering !== null) return
    gathering = setTimeout(() => {
      gathering = null
      flush()
    }, UP_GATHER_MS)
  }

  /** A new POST may open: always onto an empty line, beside others only for what a request or an answer waits for. */
  const mayOpen = (): boolean => !ended && !failed && outgoing.length > 0 && (inFlight.size === 0 || (urgentWaiting > 0 && inFlight.size < UP_IN_FLIGHT))

  /** Puts what is waiting on the line. Records leave in order; the far end puts them back in order. */
  function flush(): void {
    while (mayOpen()) {
      const batch = takeBatch()
      if (batch === null) return
      inFlight.add(batch)
      bytesInFlight += batch.body.length
      void carry(batch).finally(() => {
        inFlight.delete(batch)
        bytesInFlight -= batch.body.length
        flush()
      })
    }
  }

  /** One batch to the far end; a failed POST goes again as the same bytes. */
  async function carry({ body }: Batch): Promise<void> {
    for (let tries = 0; !ended && !failed; ) {
      const status = await postBatch(body)
      if (status >= 200 && status < 300) {
        outgoingBytes -= body.length
        connection.drained()
        return
      }
      if (status === 404) return fail('the far end has no such session')
      if (status === 400 || status === 413) return fail(`the far end refused a record (${status})`)
      // 409: ahead of what it can hold. 0, 5xx: the line. Both: the same bytes, a little later.
      tries = status === 409 ? 0 : tries + 1
      if (tries > UP_TRIES) return fail('the line up stopped answering')
      await sleep(retryMs * Math.min(tries + 1, 5))
    }
  }

  /** One down stream to its end. True when it opened. */
  const readDown = async (): Promise<boolean> => {
    const down = await fetchFn(at(`/~seal/down?from=${connection.expecting()}`), { signal: stop.signal })
    if (down.status === 404) {
      fail('the far end has no such session')
      return false
    }
    if (!down.ok || down.body === null) return false
    const reader = createRecordReader()
    const stream = down.body.getReader()
    for (;;) {
      const { done, value } = await stream.read()
      if (done) return true
      const answers = await connection.receive(reader.push(value))
      if (answers.includes('forged')) {
        connection.close('a record was tampered with')
        return true
      }
    }
  }

  const listen = async (): Promise<void> => {
    for (let misses = 0; !ended; ) {
      const opened = await readDown().catch(() => false)
      misses = opened ? 0 : misses + 1
      if (misses >= DOWN_TRIES) return connection.close('the line down closed')
      if (!ended) await sleep(retryMs)
    }
  }

  ticker = setInterval(() => connection.tick(), TICK_MS)
  void listen()

  return {
    connection,
    close() {
      if (ended) return
      connection.goaway('closing')
      // A moment for the goodbye to leave; the far end lets go of a quiet session by itself.
      setTimeout(() => connection.close('closed here'), retryMs)
    }
  }
}
