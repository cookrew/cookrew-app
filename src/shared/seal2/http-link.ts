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

/** The session, carried: a down stream kept open and an up queue sent in order. */
export function runSeal2Link(deps: HttpLinkDeps, session: Seal2Session, options: LinkOptions = {}): Seal2Link {
  const fetchFn = fetcher(deps)
  const retryMs = deps.retryMs ?? RETRY_MS
  const stop = new AbortController()
  const outgoing: Uint8Array[] = []
  let outgoingBytes = 0
  let posting = false
  let ended = false
  let ticker: ReturnType<typeof setInterval> | null = null

  const end = (): void => {
    if (ended) return
    ended = true
    stop.abort()
    if (ticker !== null) clearInterval(ticker)
  }

  const connection = createSeal2Connection({
    ...options,
    session,
    role: 'initiator',
    send: (wire) => {
      outgoing.push(wire)
      outgoingBytes += wire.length
      void flush()
    },
    backlog: () => outgoingBytes,
    onClose: (why, clean) => {
      end()
      options.onClose?.(why, clean)
    }
  })
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

  const takeBatch = (): { count: number; body: Uint8Array } => {
    let count = 0
    let size = 0
    while (count < outgoing.length && (count === 0 || size + outgoing[count].length <= UP_BATCH)) size += outgoing[count++].length
    const body = new Uint8Array(size)
    outgoing.slice(0, count).reduce((offset, wire) => (body.set(wire, offset), offset + wire.length), 0)
    return { count, body }
  }

  /** In order, one POST at a time; a failed one goes again as the same bytes. */
  async function flush(): Promise<void> {
    if (posting) return
    posting = true
    try {
      for (let tries = 0; outgoing.length > 0 && !ended; ) {
        const { count, body } = takeBatch()
        const status = await postBatch(body)
        if (status >= 200 && status < 300) {
          outgoing.splice(0, count)
          outgoingBytes -= body.length
          tries = 0
          connection.drained()
          continue
        }
        if (status === 404) return connection.close('the far end has no such session')
        if (status === 400 || status === 413) return connection.close(`the far end refused a record (${status})`)
        // 409: ahead of what it can hold. 0, 5xx: the line. Both: the same bytes, a little later.
        tries = status === 409 ? 0 : tries + 1
        if (tries > UP_TRIES) return connection.close('the line up stopped answering')
        await sleep(retryMs * Math.min(tries + 1, 5))
      }
    } finally {
      posting = false
    }
  }

  /** One down stream to its end. True when it opened. */
  const readDown = async (): Promise<boolean> => {
    const down = await fetchFn(at(`/~seal/down?from=${connection.expecting()}`), { signal: stop.signal })
    if (down.status === 404) {
      connection.close('the far end has no such session')
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
