import { concat, startHandshake, type SealRecord, type SealSession } from '../../../shared/canvas-seal'
import { createInbox, createRecordReader, decodeFrame, encodeFrame, encodeRecord, type Inbox, type SealFrame } from '../../../shared/canvas-seal-wire'

/**
 * THE PHONE'S END OF THE SEALED SESSION (main/canvas-seal-terminus.ts).
 *
 * One handshake on the connect code, then HTTP exchanges as frames inside records:
 * a long GET down, POSTs up, because the relay carries no WebSocket. The relay sees
 * ciphertext and sizes. It has never seen the code, so it cannot finish the handshake
 * as either end, and nothing is sent until the Mac has proved it holds the code too.
 */

/** Well inside the Mac's SEAL_SILENT_MS: a phone that only reads is taken for gone. */
const PING_MS = 60_000
/** Typing a password into a lock screen takes seconds, and a line can be slow. */
const REQUEST_MS = 60_000
const RETRY_MS = 1_000
/** A down stream that keeps refusing is a session that has ended. */
const DOWN_TRIES = 8

export type SealRefusal = 'code' | 'proof'

/** The code is wrong or old, or the far end could not prove it. Nothing was sent. */
export class SealRefusedError extends Error {
  constructor(readonly why: SealRefusal) {
    super(why === 'code' ? 'This Mac no longer knows that connect code.' : 'The other end could not prove the connect code.')
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

async function shakeHands(deps: SealClientDeps, fetchFn: typeof fetch): Promise<SealSession> {
  const post = (path: string, body: unknown): Promise<Response> => fetchFn(deps.url(path), { method: 'POST', body: JSON.stringify(body) })
  const started = await startHandshake(codeBytes(deps.code))
  const hello = await post('/~seal/hello', started.hello)
  if (hello.status === 403) throw new SealRefusedError('code')
  if (!hello.ok) throw new Error(`The sealed session did not open (${hello.status}).`)
  const answer = (await hello.json()) as { session: string; accept: { e: string; proof: string } }
  const done = await started.finish(answer.accept).catch(() => null)
  if (done === null) throw new SealRefusedError('proof')
  const finish = await post('/~seal/finish', { session: answer.session, ...done.finish })
  if (!finish.ok) throw new SealRefusedError('proof')
  return done.session
}

export async function openSeal(deps: SealClientDeps): Promise<SealClient> {
  const fetchFn = deps.fetchFn ?? ((input, init) => fetch(input, init))
  const session = await shakeHands(deps, fetchFn)
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
      const up = await fetchFn(deps.url(`/~seal/up?s=${session.id}`), { method: 'POST', body: concat(...records.map(encodeRecord)) as BodyInit, signal: stop.signal })
      if (up.status === 404) end('The sealed session has ended.')
    })
    tail = sent.catch(() => undefined)
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
      for (const record of reader.push(value)) await inbox.accept(record)
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
