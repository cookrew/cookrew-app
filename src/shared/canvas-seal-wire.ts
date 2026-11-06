import { concat, SEAL_RECORD_MAX, type SealRecord, type SealSession } from './canvas-seal'

/**
 * THE SEAL ON THE WIRE: records in and out of a byte stream, an inbox that puts
 * them in order, and the frames that carry HTTP exchanges inside them.
 *
 * WHAT THE TRANSPORT MUST DO, because nothing here can do it:
 *
 *   ACK WITH A SEALED `ack` FRAME, from inbox.next(). An HTTP status crossed the
 *   relay and can be forged.
 *   RESEND THE SAME BYTES. A resealed record has a new number, and the old one
 *   stays a gap the inbox waits on for ever.
 *   KEEP IN-FLIGHT RECORDS UNDER THE WINDOW, and treat `ahead` as slow down.
 *   SEND A SEALED `ping` on a clock, both ways. Silence is otherwise all a truncation
 *   looks like, and a phone that only reads is ended for going quiet.
 *   NEVER REPLAY a non-idempotent request by itself after a new handshake.
 *   CAP STREAMS, AND RATE LIMIT HANDSHAKES before keeping anything for one.
 */

/** How far ahead of the next expected record the inbox will hold. */
export const SEAL_WINDOW = 1024
/** How much opened data it will hold waiting for a gap. Past this it says `ahead`. */
export const SEAL_INBOX_BYTES = 16 * 1024 * 1024

const LENGTH_BYTES = 4
const SEQ_BYTES = 8
const TAG_BYTES = 16
const FRAME_HEAD_BYTES = 5
/** The most a `data` frame carries, so one fits one record. */
export const SEAL_DATA_MAX = SEAL_RECORD_MAX - FRAME_HEAD_BYTES

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** One record as it goes on the wire. */
export function encodeRecord(record: SealRecord): Uint8Array<ArrayBuffer> {
  const head = new Uint8Array(LENGTH_BYTES + SEQ_BYTES)
  const view = new DataView(head.buffer)
  view.setUint32(0, SEQ_BYTES + record.box.length)
  view.setUint32(LENGTH_BYTES, Math.floor(record.seq / 0x100000000))
  view.setUint32(LENGTH_BYTES + 4, record.seq % 0x100000000)
  return concat(head, record.box)
}

export interface RecordReader {
  /**
   * Whole records so far: HTTP keeps no chunk boundaries. Throws on a length no
   * record has, and from then on: nothing after a bad length can be read.
   */
  push(chunk: Uint8Array): readonly SealRecord[]
}

export function createRecordReader(): RecordReader {
  const largest = SEQ_BYTES + SEAL_RECORD_MAX + TAG_BYTES
  let store = new Uint8Array(4096)
  let start = 0
  let end = 0
  let dead = false

  /** Room doubles and live bytes move to the front, so a byte is copied a bounded number of times. */
  const append = (chunk: Uint8Array): void => {
    const live = end - start
    if (end + chunk.length > store.length) {
      const next = live + chunk.length > store.length ? new Uint8Array(Math.max(store.length * 2, live + chunk.length)) : store
      if (next === store) next.copyWithin(0, start, end)
      else next.set(store.subarray(start, end), 0)
      store = next
      start = 0
      end = live
    }
    store.set(chunk, end)
    end += chunk.length
  }

  const fail = (): never => {
    dead = true
    store = new Uint8Array(0)
    start = 0
    end = 0
    throw new Error('This record is too large, or too small to be one')
  }

  return {
    push(chunk) {
      if (dead) throw new Error('This stream already failed')
      append(chunk)
      const records: SealRecord[] = []
      const view = new DataView(store.buffer)
      while (end - start >= LENGTH_BYTES) {
        const length = view.getUint32(start)
        if (length > largest || length < SEQ_BYTES + TAG_BYTES) fail()
        if (end - start < LENGTH_BYTES + length) break
        const seq = view.getUint32(start + LENGTH_BYTES) * 0x100000000 + view.getUint32(start + LENGTH_BYTES + 4)
        records.push({ seq, box: store.slice(start + LENGTH_BYTES + SEQ_BYTES, start + LENGTH_BYTES + length) })
        start += LENGTH_BYTES + length
      }
      if (start === end) {
        start = 0
        end = 0
      }
      return records
    }
  }
}

/**
 * taken      opened, and delivered or held
 * duplicate  already seen: not proof of anything, it was never opened
 * ahead      not now: past the window or the budget. Send it again later.
 * forged     did not open
 */
export type InboxAnswer = 'taken' | 'duplicate' | 'ahead' | 'forged'

export interface Inbox {
  accept(record: SealRecord): Promise<InboxAnswer>
  /** The sequence number delivery is waiting for: what an `ack` says. */
  next(): number
}

const haveInbox = new WeakSet<SealSession>()

/**
 * Records in sequence, each once. Parallel requests land out of order and a
 * resend lands twice, and a keystroke must still be typed once. Only a record
 * that opened is held, so a relay cannot fill this with junk.
 *
 * A session gets one, because replay protection lives here: a second would
 * start again from zero and deliver what the first already had. Calls run one at
 * a time whoever makes them. A handler that throws loses its own record only.
 */
export function createInbox(session: SealSession, deliver: (plain: Uint8Array) => void, onError: (error: unknown) => void = () => undefined): Inbox {
  if (haveInbox.has(session)) throw new Error('A session has one inbox')
  haveInbox.add(session)
  const held = new Map<number, Uint8Array>()
  let heldBytes = 0
  let next = 0
  let queue: Promise<unknown> = Promise.resolve()

  const drain = (): void => {
    for (let ready = held.get(next); ready !== undefined; ready = held.get(next)) {
      held.delete(next)
      heldBytes -= ready.length
      next += 1
      try {
        deliver(ready)
      } catch (error) {
        onError(error)
      }
    }
  }

  const take = async (record: SealRecord): Promise<InboxAnswer> => {
    if (record.seq < next || held.has(record.seq)) return 'duplicate'
    if (record.seq >= next + SEAL_WINDOW) return 'ahead'
    // The record delivery waits for is always room: without it nothing ever drains.
    if (record.seq !== next && heldBytes + record.box.length > SEAL_INBOX_BYTES) return 'ahead'
    const plain = await session.open(record)
    if (plain === null) return 'forged'
    held.set(record.seq, plain)
    heldBytes += plain.length
    drain()
    return 'taken'
  }

  return {
    accept(record) {
      const answer = queue.then(() => take(record))
      queue = answer.catch(() => undefined)
      return answer
    },
    next: () => next
  }
}

/** What travels inside a record: HTTP exchanges as streams of frames, and the session's own two. */
export type SealFrame =
  | { readonly kind: 'open'; readonly stream: number; readonly method: string; readonly path: string; readonly headers: Readonly<Record<string, string>> }
  | { readonly kind: 'head'; readonly stream: number; readonly status: number; readonly headers: Readonly<Record<string, string>> }
  | { readonly kind: 'data'; readonly stream: number; readonly data: Uint8Array }
  | { readonly kind: 'end'; readonly stream: number }
  | { readonly kind: 'abort'; readonly stream: number; readonly reason: string }
  /** Every record below `next` arrived. */
  | { readonly kind: 'ack'; readonly stream: 0; readonly next: number }
  | { readonly kind: 'ping'; readonly stream: 0 }

const KINDS = ['open', 'head', 'data', 'end', 'abort', 'ack', 'ping'] as const

const payloadOf = (frame: SealFrame): Uint8Array => {
  switch (frame.kind) {
    case 'open':
      return encoder.encode(JSON.stringify({ method: frame.method, path: frame.path, headers: frame.headers }))
    case 'head':
      return encoder.encode(JSON.stringify({ status: frame.status, headers: frame.headers }))
    case 'data':
      return frame.data
    case 'abort':
      return encoder.encode(frame.reason)
    case 'ack':
      return encoder.encode(JSON.stringify({ next: frame.next }))
    case 'end':
    case 'ping':
      return new Uint8Array(0)
  }
}

export function encodeFrame(frame: SealFrame): Uint8Array<ArrayBuffer> {
  const head = new Uint8Array(FRAME_HEAD_BYTES)
  head[0] = KINDS.indexOf(frame.kind) + 1
  new DataView(head.buffer).setUint32(1, frame.stream)
  return concat(head, payloadOf(frame))
}

const readJson = (payload: Uint8Array): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(decoder.decode(payload))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** An answer may join several Set-Cookie with a newline, as the bridge does. A request never has one. */
const readHeaders = (value: unknown, kind: 'open' | 'head'): Readonly<Record<string, string>> | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const plain = (name: string, item: string): string => (kind === 'head' && name.toLowerCase() === 'set-cookie' ? item.replace(/\n/g, '') : item)
  const fine = Object.entries(value).every(([name, item]) => TOKEN.test(name) && typeof item === 'string' && !CONTROL.test(plain(name, item)))
  return fine ? (value as Record<string, string>) : null
}

/** A path on this server: never a scheme, never `//host`, nothing that could end the request line. */
const isLocalPath = (path: unknown): path is string =>
  typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') && !CONTROL.test(path) && !path.includes(' ')

const isStatus = (status: unknown): status is number => typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599

function readExchange(kind: 'open' | 'head', stream: number, payload: Uint8Array): SealFrame | null {
  const json = readJson(payload)
  const headers = readHeaders(json?.headers, kind)
  if (json === null || headers === null) return null
  if (kind === 'head') return isStatus(json.status) ? { kind, stream, status: json.status, headers } : null
  const { method, path } = json
  return typeof method === 'string' && TOKEN.test(method) && isLocalPath(path) ? { kind, stream, method, path, headers } : null
}

/** Null for anything that is not a frame. A peer holding the code is still not trusted to write one. */
export function decodeFrame(raw: Uint8Array): SealFrame | null {
  if (raw.length < FRAME_HEAD_BYTES) return null
  const kind = KINDS[raw[0] - 1]
  const stream = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(1)
  const payload = raw.subarray(FRAME_HEAD_BYTES)
  switch (kind) {
    case 'open':
    case 'head':
      return readExchange(kind, stream, payload)
    case 'data':
      return { kind, stream, data: payload.slice() }
    case 'abort':
      return { kind, stream, reason: decoder.decode(payload) }
    case 'end':
      return payload.length === 0 ? { kind, stream } : null
    case 'ping':
      return stream === 0 && payload.length === 0 ? { kind, stream } : null
    case 'ack': {
      const next = readJson(payload)?.next
      return stream === 0 && Number.isSafeInteger(next) && (next as number) >= 0 ? { kind, stream, next: next as number } : null
    }
    default:
      return null
  }
}
