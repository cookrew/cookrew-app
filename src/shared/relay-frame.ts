/**
 * THE RELAY WIRE — what travels between a served door and cookrew.dev.
 *
 * A door on someone's laptop cannot be dialled from outside, so the app dials
 * OUT and holds the connection open; a caller's request then travels down it
 * backwards. That is the whole trick, and everything here exists to make many
 * callers share one such connection without learning about each other.
 *
 * WHAT TRAVELS IS THE SAME REQUEST. The relay is a transport, not a second
 * protocol: a frame carries the method, path, headers and body the caller
 * already sends today, and the door feeds them into the same handler that
 * answers on the LAN. Nothing about the gate — the sign-in, the 402, the
 * session, the sandbox — knows a relay exists, which is the property that
 * makes this addable rather than a rewrite.
 *
 * WHY STREAMS AND NOT REQUESTS. The line (`GET /line`) is an SSE stream that
 * stays open for the life of a session and carries the agent's terminal. A
 * request/response shape could not express it, so every exchange here is a
 * STREAM: opened, headed, chunked, ended. An ordinary POST is just a stream
 * that ends immediately.
 *
 * NOT YET SEALED. These frames are plaintext, so a relay operator could read
 * them. That is acceptable in the door's own process and NOT acceptable on
 * cookrew.dev — the copy already promises "Cookrew never sends your
 * conversation anywhere else". `RelayFrame.data` is therefore the exact seam
 * the sealed channel goes through: slice 2 encrypts the payload between the
 * caller and the door, both of which are Cookrew, so the relay keeps working
 * unchanged while moving bytes it cannot read. Until that lands this transport
 * must not be advertised as public — see the guard in relay-client.ts.
 */

/** A stream id. Assigned by the RELAY, so two callers can never collide. */
export type StreamId = string

export type RelayFrame =
  /** The relay is ready and this door is bound to a name. */
  | { t: 'ready'; name: string }
  /** A caller opened a request. Headers are lowercased, as on the wire. */
  | { t: 'open'; id: StreamId; method: string; path: string; headers: Record<string, string> }
  /** Request body, for the small JSON posts the gate takes. */
  | { t: 'body'; id: StreamId; data: string; done?: boolean }
  /** The door's answer, headers first — an SSE stream stops here and chunks. */
  | { t: 'head'; id: StreamId; status: number; headers: Record<string, string> }
  /** Response body or stream payload. */
  | { t: 'chunk'; id: StreamId; data: string }
  /** This exchange is finished, by either side. */
  | { t: 'end'; id: StreamId }
  /** Given up on. `reason` is for logs; it never reaches a rendered sheet. */
  | { t: 'abort'; id: StreamId; reason: string }
  /**
   * THE PULSE. Relay → door on the downlink every heartbeat; door → relay on
   * the uplink in answer. A door's two halves are long-lived streams through
   * proxies that drop one side without telling the other: a downlink that
   * still delivers requests to an uplink nobody is reading is a door that
   * receives every call and answers none, and NEITHER end can see it — every
   * socket looks open. The pong is the only proof that both halves carry
   * bytes end to end, and a missed one is what closes the door.
   */
  | { t: 'ping'; at: number }
  | { t: 'pong'; at: number }

/**
 * The biggest frame either side will accept.
 *
 * A door is someone's laptop and a relay is shared, so neither may be made to
 * buffer without bound by the other. Terminal output arrives in small bursts;
 * a megabyte is far above anything the line produces and far below anything
 * that hurts.
 */
export const MAX_FRAME_BYTES = 1024 * 1024

/** Encode one frame for the socket. */
export function encodeFrame(frame: RelayFrame): string {
  return JSON.stringify(frame)
}

/**
 * Decode one frame, or null.
 *
 * Null rather than throwing, and null for anything unrecognised: this parses
 * data from the other side of a network, where the only safe posture is that
 * an unknown shape is not a frame. A relay that threw on a malformed message
 * would let anyone drop every door it carries.
 */
export function decodeFrame(raw: string): RelayFrame | null {
  if (raw.length > MAX_FRAME_BYTES) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const frame = value as Record<string, unknown>
  const id = typeof frame.id === 'string' && frame.id.length > 0 && frame.id.length <= 64
  switch (frame.t) {
    case 'ready':
      return typeof frame.name === 'string' ? { t: 'ready', name: frame.name } : null
    case 'open':
      if (!id || typeof frame.method !== 'string' || typeof frame.path !== 'string') return null
      if (!validHeaders(frame.headers)) return null
      return {
        t: 'open',
        id: frame.id as string,
        // Normalised here so the door's dispatch never has to care which side
        // of the wire spelled a method or a header differently.
        method: frame.method.toUpperCase(),
        path: frame.path,
        headers: lowercaseKeys(frame.headers as Record<string, string>)
      }
    case 'body':
      if (!id || typeof frame.data !== 'string') return null
      return {
        t: 'body',
        id: frame.id as string,
        data: frame.data,
        ...(frame.done === true ? { done: true } : {})
      }
    case 'head':
      if (!id || typeof frame.status !== 'number' || !validHeaders(frame.headers)) return null
      if (!Number.isInteger(frame.status) || frame.status < 100 || frame.status > 599) return null
      return {
        t: 'head',
        id: frame.id as string,
        status: frame.status,
        headers: lowercaseKeys(frame.headers as Record<string, string>)
      }
    case 'chunk':
      return id && typeof frame.data === 'string'
        ? { t: 'chunk', id: frame.id as string, data: frame.data }
        : null
    case 'end':
      return id ? { t: 'end', id: frame.id as string } : null
    case 'abort':
      return id && typeof frame.reason === 'string'
        ? { t: 'abort', id: frame.id as string, reason: frame.reason.slice(0, 200) }
        : null
    case 'ping':
      return typeof frame.at === 'number' && Number.isFinite(frame.at) ? { t: 'ping', at: frame.at } : null
    case 'pong':
      return typeof frame.at === 'number' && Number.isFinite(frame.at) ? { t: 'pong', at: frame.at } : null
    default:
      return null
  }
}

function validHeaders(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entries = Object.entries(value as Record<string, unknown>)
  // A header map is small. An enormous one is not a request, it is an attempt
  // to make the door allocate.
  if (entries.length > 64) return false
  return entries.every(([key, val]) => typeof key === 'string' && typeof val === 'string')
}

function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value
  return out
}

/**
 * The paths a relayed request may address.
 *
 * The relay carries calls to a SERVED DOOR and nothing else. Without this a
 * connection meant to expose one team would expose the whole mobile API —
 * every terminal, every workspace, the pairing routes — to anyone who could
 * reach the relay. The door's own slug is prepended by the door side, so a
 * caller cannot name a different team either.
 */
const DOOR_PATHS = new Set([
  '/',
  '/crew',
  '/api/call/challenge',
  '/api/call/assert',
  '/api/call/pay',
  '/ask',
  '/turns',
  '/trace',
  '/trace/index',
  '/trace/markers',
  '/line',
  '/line/raw',
  '/line/resize',
  // The caller ending their own session (served-endpoints). Caller-scoped
  // behind the bearer like the transcript; the one destructive verb a door
  // exposes, and it destroys only the caller's own seat.
  '/session/end'
])

export function isDoorPath(path: string): boolean {
  const [bare] = path.split('?')
  return DOOR_PATHS.has(bare)
}
