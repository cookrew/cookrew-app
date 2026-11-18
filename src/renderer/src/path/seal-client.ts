import { checkReplaced, concat, type SealRecord, type SealSession } from '../../../shared/canvas-seal'
import { createInbox, createRecordReader, decodeFrame, encodeFrame, encodeRecord, type Inbox, type SealFrame } from '../../../shared/canvas-seal-wire'
import { startCodeHandshake } from '../../../shared/seal2/handshake'
import { readBody, sealedFetch } from '../../../shared/seal2/http'
import { runSeal2Link, Seal2RefusedError, shakeHandsOverHttp, type Seal2Link } from '../../../shared/seal2/http-link'
import type { Seal2Session } from '../../../shared/seal2/records'

/**
 * THE PHONE'S END OF THE SEALED SESSION (main/canvas-seal-terminus.ts).
 *
 * One handshake on the connect code, then HTTP exchanges inside records: a long
 * GET down, POSTs up, because the relay carries no WebSocket. The relay sees
 * ciphertext and sizes. It has never seen the code, so it cannot finish the
 * handshake as either end, and nothing is sent until the Mac has proved it holds
 * the code too.
 *
 * cookrew-seal/2 FIRST (shared/seal2/): the hello offers v2 in v1's own shape, so
 * a Mac from before v2 answers v1 and this still works with it. Once a code's Mac
 * has answered v2, `pin` remembers it and a v1 answer for that code is refused:
 * a carrier that strips the offer gets an error, never a quieter session.
 */

/** Well inside the Mac's SEAL_SILENT_MS: a phone that only reads is taken for gone. */
const PING_MS = 60_000
/** Typing a password into a lock screen takes seconds, and a line can be slow. */
const REQUEST_MS = 60_000
const RETRY_MS = 1_000
/** A POST that hangs would hold every record behind it. */
const UP_MS = 20_000
/** A down stream that keeps refusing is a session that has ended. */
const DOWN_TRIES = 8

export type SealRefusal = 'code' | 'replaced' | 'proof'

/** What this page remembers of a code's Mac: that it speaks v2 (path/seal-pin.ts). */
export interface SealVersionPin {
  v2(): boolean
  sawV2(): void
  /** The Mac proved it replaced this code: the pin goes with it. */
  forget(): void
}

/**
 * The Mac answered v1, and then said inside that sealed session that it speaks v2:
 * the offer was taken off the hello on its way. The pin is set now, so the next
 * try refuses v1; nothing went in the clear.
 */
export class SealDowngradedError extends Error {
  constructor() {
    super('The sealed session was downgraded on its way to the Mac. Try again.')
  }
}

/** Where a v2 Mac answers, inside a session: an old Mac has no such route and says 404. */
export const SEAL_VERSION_PATH = '/~seal/version'
const VERSION_ASK_MS = 15_000

const REFUSED: Record<SealRefusal, string> = {
  code: 'This Mac no longer knows that connect code.',
  // Said only when the Mac PROVED it with the old code (canvas-seal.ts · checkReplaced): its word, not a relay's.
  replaced: 'That machine’s connect code was changed. Scan the code on its screen again.',
  proof: 'The other end could not prove the connect code.'
}

/** The code is wrong, old or replaced, or the far end could not prove it. Nothing was sent. */
export class SealRefusedError extends Seal2RefusedError {
  constructor(override readonly why: SealRefusal) {
    super(why, REFUSED[why])
  }
}

export interface SealRequest {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
}

export interface SealAnswer {
  readonly status: number
  readonly body: Uint8Array
}

export interface SealClient {
  request(input: SealRequest): Promise<SealAnswer>
  close(): void
}

export interface SealClientDeps {
  /** Where a seal path lives: the relay's prefix on a relayed page. */
  readonly url: (path: string) => string
  /** The connect code, base64url. */
  readonly code: string
  readonly fetchFn?: typeof fetch
  readonly retryMs?: number
  readonly requestMs?: number
  readonly upMs?: number
  /** Absent: v1 is always allowed, and nothing is remembered. */
  readonly pin?: SealVersionPin
}

interface Waiting {
  status: number | null
  readonly parts: Uint8Array[]
  readonly done: (answer: SealAnswer) => void
  readonly failed: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

const codeBytes = (encoded: string): Uint8Array => {
  const standard = encoded.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(standard), (letter) => letter.charCodeAt(0))
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** v2 if the Mac speaks it, v1 if it is a Mac from before (and the pin allows), and nothing else. */
async function shakeHands(deps: SealClientDeps, fetchFn: typeof fetch) {
  const code = codeBytes(deps.code)
  const started = await startCodeHandshake(code, { allowV1: !(deps.pin?.v2() ?? false) })
  const http = { url: deps.url, fetchFn, retryMs: deps.retryMs, upMs: deps.upMs }
  const done = await shakeHandsOverHttp(http, started, async (said) => {
    const replaced = said !== null && (await checkReplaced(code, started.hello, said.replaced).catch(() => false))
    return new SealRefusedError(replaced ? 'replaced' : 'code')
  }).catch((error: unknown) => {
    throw error instanceof Seal2RefusedError && !(error instanceof SealRefusedError) ? new SealRefusedError('proof') : error
  })
  if (done.version === 2) deps.pin?.sawV2()
  return done
}

/** The same client, on a v2 session: each request one stream. */
function seal2Client(deps: SealClientDeps, link: Seal2Link): SealClient {
  return {
    async request(input) {
      if (link.connection.closed) throw new Error('The sealed session has ended.')
      const stop = new AbortController()
      const timer = setTimeout(() => stop.abort(), deps.requestMs ?? REQUEST_MS)
      try {
        const answer = await sealedFetch(link.connection, { method: input.method, path: input.path, headers: input.headers, body: input.body, signal: stop.signal })
        return { status: answer.status, body: await readBody(answer.body) }
      } catch (error) {
        throw stop.signal.aborted ? new Error('No answer from the Mac.') : error instanceof Error ? error : new Error(String(error))
      } finally {
        clearTimeout(timer)
      }
    },
    close: () => link.close()
  }
}

export type OpenedSeal =
  | { readonly version: 2; readonly link: Seal2Link }
  /** `mac`: what the Mac itself said inside this session about v2. 'unknown' when its answer did not come. */
  | { readonly version: 1; readonly client: SealClient; readonly mac: 'no-v2' | 'unknown' }

/** Asked inside a sealed v1 session, so only the Mac can answer: a carrier can drop it, not forge it. */
async function macSpeaksV2(client: SealClient): Promise<'yes' | 'no' | 'unknown'> {
  try {
    const answer = await Promise.race([
      client.request({ method: 'GET', path: SEAL_VERSION_PATH, headers: {} }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('no answer')), VERSION_ASK_MS))
    ])
    if (answer.status === 404) return 'no'
    const said = JSON.parse(new TextDecoder().decode(answer.body)) as { versions?: unknown }
    return Array.isArray(said.versions) && said.versions.includes(2) ? 'yes' : 'no'
  } catch {
    return 'unknown'
  }
}

/**
 * The session on this code: v2, or v1 with a Mac that said, sealed, that it has no
 * v2. A v1 answer from a Mac that does speak v2 is a downgrade: pinned, refused.
 */
export async function openSealSession(deps: SealClientDeps): Promise<OpenedSeal> {
  const fetchFn = deps.fetchFn ?? ((input, init) => fetch(input, init))
  const done = await shakeHands(deps, fetchFn)
  if (done.version === 2) return { version: 2, link: runSeal2Link({ url: deps.url, fetchFn, retryMs: deps.retryMs, upMs: deps.upMs }, done.session as Seal2Session) }
  const client = seal1Client(deps, fetchFn, done.session)
  const said = await macSpeaksV2(client)
  if (said === 'yes') {
    deps.pin?.sawV2()
    client.close()
    throw new SealDowngradedError()
  }
  return { version: 1, client, mac: said === 'no' ? 'no-v2' : 'unknown' }
}

export async function openSeal(deps: SealClientDeps): Promise<SealClient> {
  const opened = await openSealSession(deps)
  return opened.version === 2 ? seal2Client(deps, opened.link) : opened.client
}

/** A Mac from before v2: canvas-seal.ts records, JSON frames, one session-wide window. */
function seal1Client(deps: SealClientDeps, fetchFn: typeof fetch, session: SealSession): SealClient {
  const waiting = new Map<number, Waiting>()
  const stop = new AbortController()
  let closed = false
  let nextStream = 1
  let tail: Promise<unknown> = Promise.resolve()

  const settle = (stream: number): Waiting | null => {
    const held = waiting.get(stream)
    if (!held) return null
    clearTimeout(held.timer)
    waiting.delete(stream)
    return held
  }

  const end = (why: string): void => {
    if (closed) return
    closed = true
    stop.abort()
    clearInterval(pinger)
    for (const stream of [...waiting.keys()]) settle(stream)?.failed(new Error(why))
  }

  const send = (frames: readonly SealFrame[]): Promise<void> => {
    // In order: the records are numbered as they are sealed.
    const sent = tail.then(async () => {
      if (closed) throw new Error('The sealed session has ended.')
      const records: SealRecord[] = []
      for (const frame of frames) records.push(await session.seal(encodeFrame(frame)))
      const hung = new AbortController()
      const timer = setTimeout(() => hung.abort(), deps.upMs ?? UP_MS)
      const release = (): void => hung.abort()
      stop.signal.addEventListener('abort', release, { once: true })
      const up = await fetchFn(deps.url(`/~seal/up?s=${session.id}`), { method: 'POST', body: concat(...records.map(encodeRecord)) as BodyInit, signal: hung.signal }).finally(() => {
        clearTimeout(timer)
        stop.signal.removeEventListener('abort', release)
      })
      if (!up.ok) throw new Error('The sealed session has ended.')
    })
    // Numbered records with a gap are never read past it, so a lost POST ends the session.
    tail = sent.catch(() => end('The sealed session has ended.'))
    return sent
  }

  const heard = (frame: SealFrame): void => {
    if (frame.kind === 'ping' || frame.kind === 'ack' || frame.kind === 'open') return
    const held = waiting.get(frame.stream)
    if (!held) return
    if (frame.kind === 'head') held.status = frame.status
    else if (frame.kind === 'data') held.parts.push(frame.data)
    else if (frame.kind === 'abort') settle(frame.stream)?.failed(new Error(`The Mac could not answer (${frame.reason}).`))
    else if (frame.kind === 'end') {
      settle(frame.stream)?.done({ status: held.status ?? 502, body: concat(...held.parts) })
      void send([{ kind: 'ack', stream: 0, next: inbox.next() }]).catch(() => undefined)
    }
  }

  const inbox: Inbox = createInbox(session, (plain) => {
    const frame = decodeFrame(plain)
    if (frame) heard(frame)
  })

  /** Reads one down stream to its end. True when it opened. */
  const readDown = async (): Promise<boolean> => {
    const down = await fetchFn(deps.url(`/~seal/down?s=${session.id}&from=${inbox.next()}`), { signal: stop.signal })
    if (down.status === 404) {
      end('The sealed session has ended.')
      return false
    }
    if (!down.ok || !down.body) return false
    const reader = createRecordReader()
    const stream = down.body.getReader()
    for (;;) {
      const { done, value } = await stream.read()
      if (done) return true
      for (const record of reader.push(value)) {
        if ((await inbox.accept(record)) === 'forged') {
          end('The sealed session has ended: a record was tampered with.')
          return false
        }
      }
    }
  }

  /** The relay ends a long stream when it likes, and a full line answers 503 for a while. */
  const listen = async (opened: () => void): Promise<void> => {
    let misses = 0
    while (!closed) {
      opened()
      const held = await readDown().catch(() => false)
      misses = held ? 0 : misses + 1
      if (misses >= DOWN_TRIES) return end('The line to the Mac closed.')
      if (!closed) await sleep(deps.retryMs ?? RETRY_MS)
    }
  }

  const pinger = setInterval(() => void send([{ kind: 'ping', stream: 0 }]).catch(() => undefined), PING_MS)
  void listen(() => undefined)

  return {
    request(input) {
      if (closed) return Promise.reject(new Error('The sealed session has ended.'))
      const stream = nextStream
      nextStream += 1
      const answer = new Promise<SealAnswer>((done, failed) => {
        const timer = setTimeout(() => settle(stream)?.failed(new Error('No answer from the Mac.')), deps.requestMs ?? REQUEST_MS)
        waiting.set(stream, { status: null, parts: [], done, failed, timer })
      })
      const body: readonly SealFrame[] = input.body === undefined ? [] : [{ kind: 'data', stream, data: new TextEncoder().encode(input.body) }]
      void send([{ kind: 'open', stream, method: input.method, path: input.path, headers: input.headers }, ...body, { kind: 'end', stream }]).catch((error: unknown) => {
        settle(stream)?.failed(error instanceof Error ? error : new Error(String(error)))
      })
      return answer
    },
    close: () => end('The sealed session was closed.')
  }
}
