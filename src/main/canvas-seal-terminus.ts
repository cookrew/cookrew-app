import type http from 'node:http'
import { acceptHandshake, type AcceptedHandshake, type SealHello, type SealSession, proveReplaced } from '../shared/canvas-seal'
import { createInbox, createRecordReader, decodeFrame, encodeFrame, encodeRecord, SEAL_DATA_MAX, type InboxAnswer, type SealFrame } from '../shared/canvas-seal-wire'
import { FixedWindowLimiter } from '../shared/fixed-window-limiter'
import { BRIDGE_BODY_MAX, loggedPath, RELAY_MARKER, type BridgeCall, type BridgeDialer, type BridgeResponse } from './canvas-bridge'
import { relayedRequest } from './host-gate'
import { bodiless } from './http-compress'
import { RELAY_DEVICE_HEADER, RELAY_DEVICE_NAME_HEADER } from './relay-device'
import { DOOR_MARKER } from '../shared/remote-unlock'
import { acceptCodeHandshake, acceptDeviceHandshake, offersSeal2, type AcceptedSeal2, type DeviceKey, type DeviceSigner, type DeviceVerifier, deviceIdOf, isDeviceKey } from '../shared/seal2/handshake'
import { HTTP_KIND, readRequest } from '../shared/seal2/http'
import { ABORT } from '../shared/seal2/spec'
import type { Seal2Stream } from '../shared/seal2/stream'
import { openSeal2Live } from './seal2-live'
import { proveSuccessor } from '../shared/seal2/successor'
import { RELAY_LINE_MARKER, SEALED_PEER_HEADER } from './seal-proof'
import { RELAY_SESSION_HEADER } from '../shared/machine-relay'
import { serveHttpStream } from './seal2-serve-http'

/**
 * THE MAC'S END OF THE SEALED SESSION (shared/canvas-seal.ts).
 *
 *   POST /~seal/hello          { v, id, e } -> { session, accept }
 *   POST /~seal/finish         { session, proof }: the phone proved the code
 *   GET  /~seal/down?s&from    one long stream of records, Mac to phone
 *   POST /~seal/up?s           records, phone to Mac
 *
 * Everything else travels inside those: each exchange the page makes is a stream
 * of frames, and each one becomes a request to this Mac's own companion, the way
 * the bridge makes one. The relay needs no change, because all it sees is an
 * ordinary GET and ordinary POSTs under the prefix it already forwards, and the
 * GET is the same shape as the event streams it has always carried.
 *
 * NOTHING HERE IS AUTHORITY. A session proves a connection, not a person: inside
 * it the pairing token is still what the companion asks for.
 *
 * What came from the relay is believed exactly as far as it is on a plain relayed
 * request: the device and its name, read once from the hello. What arrives inside a
 * record can name neither.
 */

export const SEAL_HANDSHAKES_PER_MINUTE = 30
/** The device name comes from the relay, so a relay can vary it: this one it cannot. */
export const SEAL_HANDSHAKES_ALL_PER_MINUTE = 120
/** How long a request may take to finish arriving. An answer may run as long as it likes. */
export const SEAL_BODY_MS = 120_000
export const SEAL_MAX_SESSIONS = 32
export const SEAL_MAX_STREAMS = 64
/** Under the relay's 120 s idle deadline, and how soon a phone can tell the line died. */
export const SEAL_PING_MS = 20_000
/** A session with nobody listening for this long is over. The phone shakes hands again. */
export const SEAL_DOWN_GRACE_MS = 120_000
/** A phone pings well inside this. Anyone can hold a stream open; only a phone can seal. */
export const SEAL_SILENT_MS = 300_000
/** Past this, answers wait for the phone to catch up. */
export const SEAL_OUTBOX_HIGH = 8 * 1024 * 1024
/** Past this the session ends: something ignored the wait. */
export const SEAL_OUTBOX_HARD = 32 * 1024 * 1024
const SEAL_PENDING_MAX = 8
const SEAL_PENDING_MS = 30_000
const SEAL_TICK_MS = 5_000
const SMALL_BODY = 4096
/** What a page asks. CONNECT and TRACE would each mean something else on this socket. */
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

/** What the relay said about this reader, on the request that opened the session. */
export interface SealOuter {
  readonly device?: string
  readonly deviceName?: string
}

/** Who is at the other end of a v2 session, as the handshake proved it. */
export type SealPeer = { readonly mode: 'code' } | { readonly mode: 'device'; readonly deviceId: string }

/** A stream kind another part of the app answers (lane Magpie: model traffic). "http" is the companion's. */
export type SealStreamHandler = (stream: Seal2Stream, peer: SealPeer, outer: SealOuter) => void

/** Desktop to desktop on one account (shared/seal2/handshake.ts, device mode). */
export interface SealDeviceDeps {
  /** This desktop's account device key; null with no account, and then no device hello is answered. */
  self(): DeviceSigner | null
  readonly verify: DeviceVerifier
  /** Is this device one of this account's machines, allowed to dial this one? Unknown means no. */
  trusted(deviceId: string): Promise<boolean>
  /**
   * Is it still let in by what this Mac knows now, asking nobody (a desktop the owner blocked since its hello is
   * not)? Asked again as its session is confirmed: the hello's `trusted` may have waited on cookrew.dev meanwhile.
   */
  admits?(deviceId: string): boolean
  /** The one key held for a device whose id is not made from its key (a watch whose words the owner confirmed). */
  keyOf?(deviceId: string): Promise<DeviceKey | null>
}

/** A v2 session was confirmed: from here that caller is expected to send nothing in the clear. */
export interface SealedNotice {
  readonly peer: SealPeer
  readonly outer: SealOuter
  readonly codeId?: string
}

export interface SealTerminusDeps {
  /** The connect code with this id; null when there is none. */
  codeFor(id: string): Uint8Array | null
  /** For a code this Mac replaced: the key that proves so (connect-code.ts). Absent = it only ever says no. */
  replacedKeyFor?(id: string): Uint8Array | null
  /** This Mac's current code's id: a replaced code's refusal names its successor with it (seal2/successor.ts). */
  currentCodeId?(): Promise<string>
  readonly dial: BridgeDialer
  readonly handshakesPerMinute?: number
  /** Stream kinds besides "http", each a lane's own (lane Magpie: "magpie"). */
  readonly kinds?: Readonly<Record<string, SealStreamHandler>>
  /**
   * Which of this Mac's routes a DEVICE-mode peer may reach as kind "http" (owner 2026-11-19: off by default).
   * Absent, or false for a route: refused. A phone or the console on the connect code is not this: its
   * "http" streams go to the companion as before, where the pairing token is what is asked for.
   */
  deviceHttp?(deviceId: string, method: string, path: string): boolean
  /** Absent: device hellos are refused. */
  readonly device?: SealDeviceDeps
  onSealed?(notice: SealedNotice): void
  /**
   * Bytes on their way to the phone and not gone yet. Must include the relay line's
   * own socket: the bridge reads the down stream eagerly, so loopback alone sees nothing.
   */
  socketBacklog?: (socket: http.ServerResponse | null) => number
  now?: () => number
  log?: (message: string) => void
}

export interface SealTerminus {
  handle(request: http.IncomingMessage, response: http.ServerResponse, outer: SealOuter): Promise<void>
  tick(): void
  /** Everyone on an old code is out, and the terminus stays up for the new one. */
  endSessions(why: string): void
  /** Only that desktop's sessions end (the owner said its words did not match). */
  endPeer(deviceId: string, why: string): void
  close(): void
  stats(): { sessions: number; pending: number; listening: number; retained: number; held: number }
}

const SEAL_PREFIX = '/~seal/'

export const isSealPath = (pathname: string): boolean => pathname.startsWith(SEAL_PREFIX)

const stringOf = (value: string | string[] | undefined): string | undefined => (typeof value === 'string' ? value : undefined)

/** Only what the bridge carried: this is a way in from the relay, not a route on the LAN. */
export async function routeSeal(request: http.IncomingMessage, response: http.ServerResponse, terminus: SealTerminus | undefined): Promise<void> {
  if (terminus === undefined || !relayedRequest(request)) {
    response.writeHead(404)
    response.end()
    return
  }
  const { headers } = request
  await terminus.handle(request, response, {
    device: stringOf(headers[RELAY_DEVICE_HEADER]),
    deviceName: stringOf(headers[RELAY_DEVICE_NAME_HEADER])
  })
}

/** Hop by hop, and everything only the bridge may say. The dialer writes host and the marker itself. */
const NOT_FROM_INSIDE = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'content-length', 'expect',
  'x-real-ip', RELAY_MARKER, RELAY_DEVICE_HEADER, RELAY_DEVICE_NAME_HEADER, DOOR_MARKER, RELAY_LINE_MARKER, SEALED_PEER_HEADER,
  // The account's session is the relay's: a machine never holds it.
  RELAY_SESSION_HEADER
])

/** `sealedPeer`: the device a device-mode handshake proved (seal-proof.ts · SEALED_PEER_HEADER); none in code mode. */
export function innerHeaders(asked: Readonly<Record<string, string>>, outer: SealOuter, sealedPeer?: string): Record<string, string> {
  const kept = Object.entries(asked)
    .map(([name, value]): [string, string] => [name.toLowerCase(), value])
    .filter(([name]) => !NOT_FROM_INSIDE.has(name) && !name.startsWith('x-forwarded-'))
  return {
    ...Object.fromEntries(kept),
    ...(outer.device === undefined ? {} : { [RELAY_DEVICE_HEADER]: outer.device }),
    ...(outer.deviceName === undefined ? {} : { [RELAY_DEVICE_NAME_HEADER]: outer.deviceName }),
    ...(sealedPeer === undefined ? {} : { [SEALED_PEER_HEADER]: sealedPeer })
  }
}

interface Stream {
  call: BridgeCall | null
  response: BridgeResponse | null
  bytes: number
  openedAt: number
  requestDone: boolean
  done: boolean
}

interface LiveSession {
  readonly confirm: (finish: { proof: string }) => Promise<boolean>
  /** The status the POST answers with. */
  up(body: Uint8Array): Promise<number>
  listen(response: http.ServerResponse, from: number): void
  tick(at: number): void
  close(why: string): void
  listening(): boolean
  retained(): number
  /** Bytes in the outbox, by what it really holds. */
  held(): number
  /** The last time something sealed arrived. */
  lastHeard(): number
}

interface SessionDeps {
  readonly sealed: SealSession
  readonly confirm: AcceptedHandshake['confirm']
  readonly outer: SealOuter
  readonly dial: BridgeDialer
  now(): number
  log(message: string): void
  onClosed(): void
  socketBacklog(socket: http.ServerResponse | null): number
}

function openSession(deps: SessionDeps): LiveSession {
  const { sealed, outer, dial, now, log } = deps
  const streams = new Map<number, Stream>()
  let outbox: Array<{ readonly seq: number; wire: Uint8Array | null }> = []
  /** Where the unacknowledged records start: dropping from the front must not cost the whole array. */
  let head = 0
  let acked = 0
  let retained = 0
  /** Handed to the cipher, not on the outbox yet. */
  let queued = 0
  /** Records sealed so far: an ack cannot name more. */
  let sealedCount = 0
  let tail: Promise<void> = Promise.resolve()
  let down: http.ServerResponse | null = null
  let lastHeard = now()
  let downGone = now()
  let lastPing = now()
  let waiting = false
  let closed = false

  /** What is held for this phone, by whichever count is larger: an ack is no proof it read anything. */
  const pressure = (): number => Math.max(retained, deps.socketBacklog(down)) + queued

  const release = (): void => {
    if (!waiting || pressure() >= SEAL_OUTBOX_HIGH / 2) return
    waiting = false
    for (const stream of streams.values()) stream.response?.resume?.()
  }

  const close = (why: string): void => {
    if (closed) return
    closed = true
    for (const stream of streams.values()) stream.call?.destroy()
    streams.clear()
    down?.end()
    down = null
    outbox = []
    head = 0
    retained = 0
    log(`canvas seal: session ended, ${why}`)
    deps.onClosed()
  }

  const put = async (plain: Uint8Array): Promise<void> => {
    const record = await sealed.seal(plain)
    queued -= plain.length
    if (closed) return
    const wire = encodeRecord(record)
    outbox.push({ seq: record.seq, wire })
    retained += wire.length
    sealedCount = record.seq + 1
    down?.write(wire)
  }

  /** One at a time: the cipher is asynchronous, and the wire must stay in sequence. */
  const send = (frame: SealFrame): void => {
    if (closed) return
    const plain = encodeFrame(frame)
    queued += plain.length
    // Only this session's own bytes: the line is shared, and a big plain download on it is not this phone's fault.
    if (retained + queued > SEAL_OUTBOX_HARD) return close('the phone fell too far behind')
    tail = tail.then(() => put(plain)).catch((error: unknown) => close(`sealing failed: ${String(error)}`))
    if (!waiting && pressure() > SEAL_OUTBOX_HIGH) {
      waiting = true
      for (const stream of streams.values()) stream.response?.pause?.()
    }
  }

  const settle = (id: number, stream: Stream): void => {
    stream.done = true
    if (streams.get(id) === stream) streams.delete(id)
  }

  const answered = (id: number, stream: Stream, response: BridgeResponse): void => {
    if (stream.done) return
    stream.response = response
    send({ kind: 'head', stream: id, status: response.status, headers: response.headers })
    if (bodiless(response.status)) {
      send({ kind: 'end', stream: id })
      settle(id, stream)
      stream.call?.destroy()
      return
    }
    if (waiting) response.pause?.()
    response.onData((chunk) => {
      for (let at = 0; at < chunk.byteLength && !closed; at += SEAL_DATA_MAX) send({ kind: 'data', stream: id, data: chunk.subarray(at, at + SEAL_DATA_MAX) })
    })
    response.onEnd(() => {
      if (stream.done) return
      send({ kind: 'end', stream: id })
      settle(id, stream)
      if (!stream.requestDone) stream.call?.destroy()
    })
  }

  const start = (frame: Extract<SealFrame, { kind: 'open' }>): void => {
    const id = frame.stream
    if (closed) return
    if (!METHODS.has(frame.method)) return send({ kind: 'abort', stream: id, reason: 'bad-method' })
    if (id === 0 || streams.has(id)) return send({ kind: 'abort', stream: id, reason: 'in-use' })
    if (streams.size >= SEAL_MAX_STREAMS) return send({ kind: 'abort', stream: id, reason: 'busy' })
    const stream: Stream = { call: null, response: null, bytes: 0, openedAt: now(), requestDone: false, done: false }
    streams.set(id, stream)
    const failed = (error: Error): void => {
      if (stream.done) return
      log(`canvas seal: ${frame.method} ${loggedPath(frame.path)} failed: ${error.message}`)
      send({ kind: 'abort', stream: id, reason: 'companion-failed' })
      settle(id, stream)
    }
    try {
      stream.call = dial({ method: frame.method, path: frame.path, headers: innerHeaders(frame.headers, outer) }, (response) => answered(id, stream, response), failed)
    } catch (error) {
      // Node refuses to build some requests outright: a path or a value past latin1.
      failed(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (stream.done) stream.call.destroy()
  }

  const body = (frame: Extract<SealFrame, { kind: 'data' }>, stream: Stream): void => {
    stream.bytes += frame.data.length
    if (stream.bytes > BRIDGE_BODY_MAX) {
      send({ kind: 'abort', stream: frame.stream, reason: 'body-too-large' })
      stream.call?.destroy()
      settle(frame.stream, stream)
      return
    }
    stream.call?.write(Buffer.from(frame.data))
  }

  const acknowledged = (next: number): void => {
    if (next > sealedCount || next <= acked) return
    acked = next
    while (head < outbox.length && outbox[head].seq < next) {
      retained -= outbox[head].wire?.length ?? 0
      // Now, not at the next compaction: a slot's bytes are the whole cost of keeping it.
      outbox[head].wire = null
      head += 1
    }
    if (head > 1024) {
      outbox = outbox.slice(head)
      head = 0
    }
    release()
  }

  const receive = (frame: SealFrame): void => {
    const stream = streams.get(frame.stream)
    switch (frame.kind) {
      case 'open':
        return start(frame)
      case 'data':
        if (stream) body(frame, stream)
        return
      case 'end':
        if (stream) {
          stream.requestDone = true
          stream.call?.end()
        }
        return
      case 'abort':
        if (stream) {
          stream.call?.destroy()
          settle(frame.stream, stream)
        }
        return
      case 'ack':
        return acknowledged(frame.next)
      default:
        return
    }
  }

  const inbox = createInbox(
    sealed,
    (plain) => {
      const frame = decodeFrame(plain)
      if (frame === null) log('canvas seal: dropped a frame it could not read')
      else receive(frame)
    },
    (error) => log(`canvas seal: a frame failed: ${String(error)}`)
  )

  const statusOf = (answers: readonly InboxAnswer[]): number => {
    if (answers.includes('forged')) return 400
    return answers.includes('ahead') ? 409 : 204
  }

  return {
    confirm: deps.confirm,
    async up(raw) {
      let records
      try {
        records = createRecordReader().push(raw)
      } catch {
        return 400
      }
      const answers: InboxAnswer[] = []
      for (const record of records) {
        if (closed) break
        const answer = await inbox.accept(record)
        answers.push(answer)
        if (answer === 'taken') lastHeard = now()
        // One failed open per POST: a relay with no code must not buy more than that.
        if (answer === 'forged') break
      }
      if (answers.some((answer) => answer === 'taken' || answer === 'duplicate')) send({ kind: 'ack', stream: 0, next: inbox.next() })
      return statusOf(answers)
    },
    listen(response, from) {
      // Every listen writes out all that is unacked, and the relay can see this id: a
      // line that has not drained the last one waits, or repeated GETs fill this Mac's memory.
      if (retained > 0 && deps.socketBacklog(down) > SEAL_OUTBOX_HIGH) return reply(response, 503, { error: 'the line is still full' })
      down?.end()
      down = response
      lastPing = now()
      // text/event-stream for the path it takes, not for what it holds: every proxy
      // between here and the phone already streams this type without holding it back.
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' })
      response.flushHeaders()
      for (const { seq, wire } of outbox.slice(head)) if (seq >= from && wire !== null) response.write(wire)
      // The relay holds a head back until the first bytes behind it, so an idle
      // stream would never open at the phone. It also says this line is live.
      send({ kind: 'ping', stream: 0 })
      response.on('drain', release)
      response.on('close', () => {
        if (down !== response) return
        down = null
        downGone = now()
      })
    },
    tick(at) {
      if (at - lastHeard > SEAL_SILENT_MS) return close('the phone went silent')
      if (down === null) {
        if (at - Math.max(lastHeard, downGone) > SEAL_DOWN_GRACE_MS) close('nobody was listening')
        return
      }
      release()
      for (const [id, stream] of [...streams]) {
        if (stream.requestDone || at - stream.openedAt <= SEAL_BODY_MS) continue
        send({ kind: 'abort', stream: id, reason: 'body-timed-out' })
        stream.call?.destroy()
        settle(id, stream)
      }
      if (at - lastPing < SEAL_PING_MS) return
      lastPing = at
      send({ kind: 'ping', stream: 0 })
    },
    close,
    lastHeard: () => lastHeard,
    listening: () => down !== null,
    retained: () => retained,
    held: () => outbox.reduce((total, { wire }) => total + (wire?.length ?? 0), 0)
  }
}

const reply = (response: http.ServerResponse, status: number, body?: unknown): void => {
  if (body === undefined) {
    response.writeHead(status, { 'cache-control': 'no-store' })
    response.end()
    return
  }
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

/** Null when it is larger than `limit`. */
async function readBytes(request: http.IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  // Read to the end whatever the size: leaving the loop early destroys the request,
  // and its answer with it. The relay already caps what can arrive.
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size <= limit) chunks.push(chunk)
  }
  return size > limit ? null : Buffer.concat(chunks)
}

async function readSmallJson(request: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  const raw = await readBytes(request, SMALL_BODY)
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw.toString('utf8'))
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

type Pending =
  | { readonly v: 1; readonly accepted: AcceptedHandshake; readonly outer: SealOuter; readonly until: number }
  | { readonly v: 2; readonly accepted: AcceptedSeal2; readonly peer: SealPeer; readonly codeId?: string; readonly outer: SealOuter; readonly until: number }

export function createSealTerminus(deps: SealTerminusDeps): SealTerminus {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((): void => undefined)
  const socketBacklog = deps.socketBacklog ?? ((socket: http.ServerResponse | null): number => socket?.writableLength ?? 0)
  const limiter = new FixedWindowLimiter(deps.handshakesPerMinute ?? SEAL_HANDSHAKES_PER_MINUTE, 60_000, now)
  const ceiling = new FixedWindowLimiter(SEAL_HANDSHAKES_ALL_PER_MINUTE, 60_000, now)
  const pending = new Map<string, Pending>()
  const sessions = new Map<string, LiveSession>()
  /** Which device each device-mode session is with. */
  const sessionPeers = new Map<string, string>()

  const hello = async (request: http.IncomingMessage, response: http.ServerResponse, outer: SealOuter): Promise<void> => {
    const body = await readSmallJson(request)
    if (body === null) return reply(response, 400, { error: 'not a hello' })
    // Per device first: a device over its own limit spends nothing of everyone's.
    const allowed = limiter.take(outer.device ?? 'no-device') && ceiling.take('all')
    if (!allowed) return reply(response, 429, { error: 'too many handshakes' })
    if (body.mode === 'device') return deviceHello(body, response, outer)
    const code = typeof body.id === 'string' ? deps.codeFor(body.id) : null
    if (code === null) {
      // A code this Mac replaced is told so, with a proof its holder can check: "the code was changed, pair
      // again" is then the Mac's word and not a relay's. Any other code is told no and nothing more.
      // Over a hello that could have been one: its key is 32 bytes, spelled the one way.
      const asked = typeof body.id === 'string' && typeof body.e === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.e)
      const was = asked ? (deps.replacedKeyFor?.(body.id as string) ?? null) : null
      if (was === null) return reply(response, 403, { error: 'no such code' })
      const replaced = await proveReplaced(was, { id: body.id as string, e: body.e as string })
      const current = (await deps.currentCodeId?.().catch(() => null)) ?? null
      const successor = current === null ? {} : { successor: await proveSuccessor(was, body.id as string, current, body.e as string) }
      return reply(response, 403, { error: 'code replaced', replaced, ...successor })
    }
    const v2 = offersSeal2(body)
    const accepted = v2 ? await acceptCodeHandshake(code, body) : await acceptHandshake(code, body as unknown as SealHello)
    if (accepted === null) return reply(response, 400, { error: 'not a hello' })
    // A rotation during that await has already cleared `pending`, so this hello would outlive it.
    if (deps.codeFor(body.id as string) === null) return reply(response, 403, { error: 'no such code' })
    const until = now() + SEAL_PENDING_MS
    const entry: Pending = v2
      ? { v: 2, accepted: accepted as AcceptedSeal2, peer: { mode: 'code' }, codeId: body.id as string, outer, until }
      : { v: 1, accepted: accepted as AcceptedHandshake, outer, until }
    hold(accepted.session.id, entry)
    reply(response, 200, { session: accepted.session.id, accept: accepted.accept })
  }

  const hold = (id: string, entry: Pending): void => {
    if (pending.size >= SEAL_PENDING_MAX) pending.delete(pending.keys().next().value as string)
    pending.set(id, entry)
  }

  /** Another desktop of this account. Its key is its id's own; whether that id may come in is the account's word. */
  const deviceHello = async (body: Record<string, unknown>, response: http.ServerResponse, outer: SealOuter): Promise<void> => {
    const self = deps.device?.self() ?? null
    if (deps.device === undefined || self === null) return reply(response, 403, { error: 'no device seal here' })
    const accepted = await acceptDeviceHandshake(body, { self, verify: deps.device.verify, ...(deps.device.keyOf ? { keyOf: deps.device.keyOf } : {}) })
    if (accepted === null) {
      // A well-formed hello to this Mac whose key it does not hold for that id (a watch whose words the owner has
      // not confirmed yet) is a refusal the watch can read: it keeps its old way and asks again later.
      const toHere = body.to === self.deviceId
      // Only for an id that is not its key's own (a watch's): a desktop's malformed hello stays a malformed one.
      const watchLike = typeof body.from === 'string' && isDeviceKey(body.jwk) && (await deviceIdOf(body.jwk)) !== body.from.toLowerCase()
      const held = toHere && watchLike ? ((await deps.device.keyOf?.(body.from as string).catch(() => null)) ?? null) : null
      // No key held for that id, or another one than this hello's (a watch paired again with a new key): not let in.
      const unheld = toHere && watchLike && (held === null || held.x !== (body.jwk as DeviceKey).x)
      if (!toHere) return reply(response, 403, { error: 'not this machine' })
      return unheld ? reply(response, 403, { error: 'not let in' }) : reply(response, 400, { error: 'not a hello' })
    }
    const { deviceId } = accepted.peer
    // The relay names who sent this; a hello in another device's name is not believed.
    if (outer.device !== undefined && outer.device !== deviceId) return reply(response, 403, { error: 'not that device' })
    if (!(await deps.device.trusted(deviceId).catch(() => false))) return reply(response, 403, { error: 'not a machine of this account' })
    hold(accepted.session.id, { v: 2, accepted, peer: { mode: 'device', deviceId }, outer, until: now() + SEAL_PENDING_MS })
    reply(response, 200, { session: accepted.session.id, accept: accepted.accept })
  }

  const streamHandler = (peer: SealPeer, said: SealOuter) => (stream: Seal2Stream): void => {
    // In device mode the handshake proved who dialled: that, not the relay's word, names the device inside.
    const outer: SealOuter = peer.mode === 'device' ? { ...said, device: peer.deviceId } : said
    if (stream.kind === HTTP_KIND) {
      if (peer.mode === 'device') {
        const asked = readRequest(stream.fields)
        // Judged on the path as the companion will read it: no dot segment, nothing encoded that could become one.
        const plainPath = asked !== null && !/(^|\/)\.{1,2}(\/|\?|$)|%2e|%2f|%5c/i.test(asked.path.split('?')[0])
        const allowed = asked !== null && plainPath && deps.deviceHttp?.(peer.deviceId, asked.method, asked.path) === true
        if (!allowed) return stream.abort(ABORT.refused, 'not a route for this device')
      }
      const sealedPeer = peer.mode === 'device' ? peer.deviceId : undefined
      return serveHttpStream(stream, { dial: deps.dial, headersFor: (asked) => innerHeaders(asked, outer, sealedPeer), log })
    }
    // Own entries only: a kind named for something every object has ("constructor") is no handler.
    const kinds = deps.kinds ?? {}
    const handler = Object.prototype.hasOwnProperty.call(kinds, stream.kind) ? kinds[stream.kind] : undefined
    if (typeof handler !== 'function') return stream.abort(ABORT.unknownKind, 'no such kind')
    handler(stream, peer, outer)
  }

  const dropQuietest = (): void => {
    const rank = (live: LiveSession): [boolean, number] => [live.listening(), live.lastHeard()]
    const [quietest] = [...sessions.entries()].reduce((held, entry) => {
      const [a, b] = [rank(entry[1]), rank(held[1])]
      return a[0] !== b[0] ? (a[0] ? held : entry) : a[1] < b[1] ? entry : held
    })
    sessions.get(quietest)?.close('too many sessions')
  }

  const promote = (id: string, entry: Pending): void => {
    pending.delete(id)
    if (sessions.size >= SEAL_MAX_SESSIONS) dropQuietest()
    const onClosed = (): void => {
      sessions.delete(id)
      sessionPeers.delete(id)
    }
    if (entry.v === 1) {
      const { accepted, outer } = entry
      sessions.set(id, openSession({ sealed: accepted.session, confirm: accepted.confirm, outer, dial: deps.dial, now, log, socketBacklog, onClosed }))
      return
    }
    const live = openSeal2Live({ session: entry.accepted.session, serve: streamHandler(entry.peer, entry.outer), now, log, onClosed, socketBacklog })
    sessions.set(id, { ...live, confirm: entry.accepted.confirm })
    if (entry.peer.mode === 'device') sessionPeers.set(id, entry.peer.deviceId)
    try {
      deps.onSealed?.({ peer: entry.peer, outer: entry.outer, ...(entry.codeId === undefined ? {} : { codeId: entry.codeId }) })
    } catch (error) {
      log(`canvas seal: marking a sealed caller failed: ${String(error)}`)
    }
  }

  const finish = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    const body = await readSmallJson(request)
    const id = typeof body?.session === 'string' ? body.session : ''
    const proof = { proof: String(body?.proof), ...(typeof body?.sig === 'string' ? { sig: body.sig } : {}) }
    // Asked twice is fine: a phone whose answer was lost asks again, and may only continue.
    const live = sessions.get(id)
    if (live) return reply(response, (await live.confirm(proof)) ? 200 : 403, {})
    const waiting = pending.get(id)
    if (!waiting) return reply(response, 404, { error: 'no such session' })
    if (!(await waiting.accepted.confirm(proof))) return reply(response, 403, { error: 'that proves nothing' })
    // Dropped while it proved itself (endPeer: the owner said NOT THE SAME): no session. Promoted by the same
    // finish asked twice: the session stands.
    if (pending.get(id) !== waiting) return sessions.has(id) ? reply(response, 200, {}) : reply(response, 403, { error: 'not let in' })
    if (waiting.v === 2 && waiting.peer.mode === 'device' && deps.device?.admits?.(waiting.peer.deviceId) === false) {
      pending.delete(id)
      return reply(response, 403, { error: 'not let in' })
    }
    promote(id, waiting)
    reply(response, 200, {})
  }

  const up = async (request: http.IncomingMessage, response: http.ServerResponse, live: LiveSession): Promise<void> => {
    const raw = await readBytes(request, BRIDGE_BODY_MAX)
    if (raw === null) return reply(response, 413)
    reply(response, await live.up(raw))
  }

  const route = async (request: http.IncomingMessage, response: http.ServerResponse, outer: SealOuter): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://seal')
    const verb = url.pathname.slice(SEAL_PREFIX.length)
    const method = request.method ?? 'GET'
    if (!['hello', 'finish', 'up', 'down', 'version'].includes(verb)) return reply(response, 404, { error: 'not found' })
    if (method !== (verb === 'down' || verb === 'version' ? 'GET' : 'POST')) return reply(response, 405, { error: 'wrong method' })
    // What this Mac speaks. Believed only when asked inside a sealed session (seal-client.ts · openSealSession):
    // there a carrier that took v2's offer off the hello cannot also hide that this Mac has it.
    if (verb === 'version') return reply(response, 200, { versions: [2, 1] })
    if (verb === 'hello') return hello(request, response, outer)
    if (verb === 'finish') return finish(request, response)
    const live = sessions.get(url.searchParams.get('s') ?? '')
    if (!live) return reply(response, 404, { error: 'no such session' })
    if (verb === 'up') return up(request, response, live)
    const from = Number(url.searchParams.get('from') ?? '0')
    live.listen(response, Number.isSafeInteger(from) && from >= 0 ? from : 0)
  }

  const tick = (): void => {
    const at = now()
    for (const [id, waiting] of pending) if (at > waiting.until) pending.delete(id)
    for (const live of [...sessions.values()]) live.tick(at)
  }

  const endPeer = (deviceId: string, why: string): void => {
    for (const [id, peer] of [...sessionPeers]) {
      if (peer !== deviceId) continue
      sessionPeers.delete(id)
      sessions.get(id)?.close(why)
    }
    for (const [id, waiting] of [...pending]) if (waiting.v === 2 && waiting.peer.mode === 'device' && waiting.peer.deviceId === deviceId) pending.delete(id)
  }

  const endSessions = (why: string): void => {
    pending.clear()
    for (const live of [...sessions.values()]) live.close(why)
  }

  const timer = setInterval(tick, SEAL_TICK_MS)
  timer.unref?.()

  return {
    async handle(request, response, outer) {
      try {
        await route(request, response, outer)
      } catch (error) {
        log(`canvas seal: a request failed: ${String(error)}`)
        if (!response.headersSent) reply(response, 500, { error: 'failed' })
      }
    },
    tick,
    endSessions,
    endPeer,
    close() {
      clearInterval(timer)
      endSessions('the app is closing')
    },
    stats: () => ({
      sessions: sessions.size,
      pending: pending.size,
      listening: [...sessions.values()].filter((live) => live.listening()).length,
      retained: [...sessions.values()].reduce((total, live) => total + live.retained(), 0),
      held: [...sessions.values()].reduce((total, live) => total + live.held(), 0)
    })
  }
}
