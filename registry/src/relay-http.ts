import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readJsonBody } from './http'
import { RelayHub, type HubSocket } from './relay-hub'
import { decodeFrame, encodeFrame, MAX_FRAME_BYTES } from '../../src/shared/relay-frame'
import type { IdentityService } from './identity'

/**
 * THE RELAY, OVER PLAIN HTTP.
 *
 * WHY NOT WEBSOCKETS, which this obviously wants to be. The door runs inside
 * Electron on Node 20, which has no WebSocket client, and adding `ws` puts a
 * native-ish dependency into the app to carry frames a POST already carries.
 * More importantly the far end is meant to be able to live behind a CDN, and
 * ordinary HTTP is the shape that survives that move. The frame protocol is
 * unchanged either way — this is a transport, and swapping it later touches
 * only this file and its two clients.
 *
 * THREE CONNECTIONS, and the asymmetry is deliberate:
 *
 *   the DOOR holds a long downlink (GET, NDJSON) because it cannot be dialled;
 *   the DOOR pushes on a long chunked POST, because terminal output is the
 *     high-volume direction and a POST per burst would be absurd;
 *   a CALLER gets ONE HTTP REQUEST PER EXCHANGE — body up, frames streaming
 *     down. No duplex, no long-lived caller socket, and hanging up is just
 *     aborting the request, which every network already knows how to do.
 *
 * WHAT THIS FILE MAY NOT BECOME. It moves opaque bytes. It holds no key of
 * either side, and it must never grow a branch that reads a payload — every
 * question of who may call is answered at the door, on the author's machine.
 */

/**
 * How often a quiet stream says something.
 *
 * Well under the minute-or-two an idle connection typically survives at a CDN,
 * and far too rare to be a cost: one byte.
 */
const HEARTBEAT_MS = 25_000
/** How long a ticket stands between being minted and being used. */
const TICKET_TTL_MS = 60_000
/** A caller's whole request body. The gate takes small JSON posts. */
const MAX_BODY = 256 * 1024

const NAME =
  /^@([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/

export interface RelayHttp {
  hub: RelayHub
  /** Answered it? Returns false when the path is not the relay's. */
  handle(request: IncomingMessage, response: ServerResponse, parts: string[], url: URL): boolean
  /** For the health page. */
  stats(): { doors: number; streams: number; tickets: number }
}

interface Ticket {
  name: string
  expiresAt: number
}

export function createRelayHttp(deps: {
  identity?: IdentityService
  now?: () => number
  log?: (message: string) => void
}): RelayHttp {
  const now = deps.now ?? ((): number => Date.now())
  const log = deps.log ?? ((): void => undefined)
  const hub = new RelayHub(log)
  const tickets = new Map<string, Ticket>()
  /** Which door name each live downlink serves, so an uplink can find it. */
  const live = new Map<string, HubSocket>()

  const sweep = (): void => {
    const at = now()
    for (const [key, ticket] of tickets) if (ticket.expiresAt <= at) tickets.delete(key)
  }

  /**
   * A ticket, and why it exists at all.
   *
   * A door proves who it is ONCE, with the same assertion the directory already
   * takes, and the two long-lived streams then present the ticket instead. The
   * alternative — proving identity on a GET — would mean putting a credential
   * in a URL, which is the one place credentials reliably end up in logs.
   */
  const mintTicket = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    if (!deps.identity) {
      json(response, 503, { error: 'identity_unavailable' })
      return
    }
    const body = await readJsonBody(request, 16 * 1024)
    if (!body.ok) {
      json(response, 400, { error: 'malformed' })
      return
    }
    const input = body.value as { assertion?: unknown; name?: unknown }
    const name = typeof input.name === 'string' ? input.name : ''
    const parsed = NAME.exec(name)
    if (!parsed) {
      json(response, 400, { error: 'bad_name' })
      return
    }
    // No assertion → a challenge, which is the same ladder every other gated
    // route here climbs. A separate challenge endpoint would be a second way
    // to start a ceremony, and two ways is how one of them drifts.
    if (input.assertion === undefined) {
      json(response, 401, { error: 'unidentified', challenge: deps.identity.challenge() })
      return
    }
    const asserted = deps.identity.assert(input.assertion as never, 'download')
    if (!asserted.ok) {
      json(response, 401, { error: 'unidentified' })
      return
    }
    // The handle comes from the ASSERTION. A door naming its own owner would
    // let anyone park on someone else's name and take their callers offline,
    // since the hub refuses a second claim on a name already held.
    if (asserted.sub !== parsed[1]) {
      json(response, 403, { error: 'not_yours' })
      return
    }
    sweep()
    const ticket = randomBytes(32).toString('base64url')
    tickets.set(ticket, { name, expiresAt: now() + TICKET_TTL_MS })
    json(response, 200, { ticket, name, expiresIn: TICKET_TTL_MS })
  }

  /** Look a ticket up in constant time, so it cannot be probed byte by byte. */
  const redeem = (offered: string | null): Ticket | null => {
    if (!offered) return null
    sweep()
    let found: Ticket | null = null
    for (const [key, ticket] of tickets) {
      const a = Buffer.from(key)
      const b = Buffer.from(offered)
      if (a.length === b.length && timingSafeEqual(a, b)) found = ticket
    }
    return found
  }

  /** A stream of frames, one JSON object per line. */
  const openNdjson = (response: ServerResponse): ((line: string) => void) => {
    response.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx and friends buffer a response until it ends unless told not to,
      // which would hold a terminal's output until the session was over.
      'x-accel-buffering': 'no'
    })
    /**
     * A HEARTBEAT, because the streams here are quiet for long stretches.
     *
     * An agent that is thinking says nothing, and a door with no callers says
     * nothing at all — while every CDN and load balancer between here and them
     * drops an idle connection after a minute or two. That drop would read as
     * the team having gone away, moments after someone paid to reach it.
     *
     * An empty line, because the parsers on both ends already skip one: the
     * heartbeat needs no place in the protocol.
     */
    const beat = setInterval(() => {
      if (!response.writableEnded) response.write('\n')
    }, HEARTBEAT_MS)
    beat.unref?.()
    response.on('close', () => clearInterval(beat))
    return (line) => {
      if (!response.writableEnded) response.write(`${line}\n`)
    }
  }

  /** THE DOOR'S DOWNLINK — held open for the life of the door. */
  const doorDownlink = (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ): void => {
    const ticket = redeem(url.searchParams.get('ticket'))
    if (!ticket) {
      json(response, 401, { error: 'no_ticket' })
      return
    }
    const write = openNdjson(response)
    const socket: HubSocket = {
      send: write,
      close: () => {
        if (!response.writableEnded) response.end()
      }
    }
    const opened = hub.openDoor(ticket.name, socket)
    if (!opened.ok) {
      // A name already held. Said plainly in the stream rather than as a status,
      // because the head is already out.
      write(encodeFrame({ t: 'abort', id: 'x', reason: opened.reason }))
      response.end()
      return
    }
    live.set(ticket.name, socket)
    // THE RESPONSE, not the request. A GET's request stream completes the
    // moment its (empty) body has arrived, so listening there would drop the
    // door immediately — see the same trap, and the same fix, in `call`.
    response.on('close', () => {
      if (live.get(ticket.name) === socket) {
        live.delete(ticket.name)
        hub.closeDoor(ticket.name)
      }
    })
    void request
  }

  /**
   * THE DOOR'S UPLINK — one long chunked POST carrying frames as they happen.
   *
   * Read line by line and never accumulated: a door streaming a terminal for an
   * hour must not grow this process by an hour of output.
   */
  const doorUplink = (request: IncomingMessage, response: ServerResponse, url: URL): void => {
    const ticket = redeem(url.searchParams.get('ticket'))
    if (!ticket || !live.has(ticket.name)) {
      json(response, 401, { error: 'no_ticket' })
      return
    }
    const name = ticket.name
    /** The downlink this uplink belongs to, so ending one ends the pair. */
    const socket = live.get(name)
    let buffer = ''
    request.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let at = buffer.indexOf('\n')
      while (at >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        if (line.length > 0) hub.fromDoor(name, line)
        at = buffer.indexOf('\n')
      }
      // A line that never ends is not a frame, it is someone making us
      // allocate. The connection is the right thing to lose here.
      if (buffer.length > MAX_FRAME_BYTES) {
        buffer = ''
        request.destroy()
      }
    })
    /**
     * NO UPLINK MEANS NOT SERVING, and the door must stop being listed as
     * though it were.
     *
     * The downlink is what claims the name, so a door whose uplink died kept
     * the claim while being unable to answer a single call. It received every
     * request and replied to none; the directory said "live"; a caller was
     * told the address was unreachable. Ending the uplink now ends the door,
     * which is the only version of this that is true.
     */
    const gone = (): void => {
      if (live.get(name) === socket) {
        live.delete(name)
        hub.closeDoor(name)
        log(`relay: ${name} lost its uplink`)
      }
    }
    request.on('end', () => {
      gone()
      if (!response.writableEnded) json(response, 200, { ok: true })
    })
    request.on('close', gone)
    request.on('error', gone)
  }

  /**
   * A CALLER'S EXCHANGE — one HTTP request, start to finish.
   *
   * The request body is the sealed request body; the response is the frames
   * coming back. Hanging up is aborting the request, which is what a closed
   * card, a lost network and a killed app all look like from here.
   */
  const call = (
    request: IncomingMessage,
    response: ServerResponse,
    name: string,
    url: URL
  ): void => {
    const op = readOp(request.headers['x-relay-op'])
    if (!op) {
      json(response, 400, { error: 'malformed' })
      return
    }
    void url
    let body = ''
    let tooBig = false
    request.on('data', (chunk: Buffer) => {
      if (tooBig) return
      body += chunk.toString('utf8')
      if (body.length > MAX_BODY) {
        tooBig = true
        body = ''
        request.resume()
      }
    })
    request.on('end', () => {
      if (tooBig) {
        json(response, 413, { error: 'too_large' })
        return
      }
      let write: ((line: string) => void) | null = null
      const finish = (): void => {
        if (!response.writableEnded) response.end()
      }
      const socket: HubSocket = {
        send: (line) => {
          write?.(line)
          // An exchange that is over closes its HTTP request too. Without this
          // a finished call would hold a connection open on both machines for
          // as long as the caller stayed running.
          const frame = decodeFrame(line)
          if (frame && (frame.t === 'end' || frame.t === 'abort')) finish()
        },
        close: finish
      }
      const opened = hub.openStream(name, socket, op, op.id)
      if (!opened.ok) {
        // A door nobody is serving answers like a name that never existed, so
        // the relay cannot be used to find out who is online.
        json(response, 404, { error: 'not_found' })
        return
      }
      write = openNdjson(response)
      // The hub told the door about this exchange the moment it opened; the
      // body follows as its own frame, exactly as the frame protocol says.
      if (body.length > 0) {
        // Addressed with the CALLER'S label, which is the only id a caller is
        // ever allowed to speak about; the hub rewrites it on the way to the door.
        hub.fromCaller(op.id, socket, encodeFrame({ t: 'body', id: op.id, data: body, done: true }))
      }
      /**
       * THE CALLER HUNG UP — and the only honest signal for it.
       *
       * `request.on('close')` fires when the request BODY is complete, which
       * for every exchange here is immediately. Listening there tore down each
       * stream the instant it opened, and the door answered perfectly into
       * nothing. The response closing while we still had more to write is the
       * real thing: a closed card, a dropped network, a killed app.
       */
      response.on('close', () => {
        if (!response.writableEnded) hub.closeCaller(opened.id)
      })
    })
  }

  return {
    hub,
    stats: () => ({ ...hub.stats(), tickets: tickets.size }),
    handle(request, response, parts, url) {
      if (parts[0] !== 'v1' || parts[1] !== 'relay') return false
      const method = request.method ?? 'GET'
      if (method === 'POST' && parts.length === 3 && parts[2] === 'ticket') {
        void mintTicket(request, response)
        return true
      }
      if (method === 'GET' && parts.length === 3 && parts[2] === 'door') {
        doorDownlink(request, response, url)
        return true
      }
      if (method === 'POST' && parts.length === 3 && parts[2] === 'uplink') {
        doorUplink(request, response, url)
        return true
      }
      if (method === 'POST' && parts.length === 5 && parts[2] === 'call') {
        const name = `${decodeURIComponent(parts[3])}/${decodeURIComponent(parts[4])}`
        if (!NAME.test(name)) {
          json(response, 400, { error: 'bad_name' })
          return true
        }
        call(request, response, name, url)
        return true
      }
      json(response, 404, { error: 'not_found' })
      return true
    }
  }
}

/**
 * The caller's method, path and sealed headers, carried in one header.
 *
 * A header rather than a first body line because the request body IS the
 * sealed payload, and giving it a second job would mean the transport had to
 * parse something it is supposed to move blindly.
 */
function readOp(
  raw: string | string[] | undefined
): { id: string; method: string; path: string; headers: Record<string, string> } | null {
  if (typeof raw !== 'string' || raw.length > 8192) return null
  try {
    const decoded: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    // Reuse the wire's own validation rather than a second, looser copy of it.
    // `id` is the CALLER'S OWN label, and it is validated here like any other
    // field a stranger chose: the hub answers under it, and it never reaches
    // the door, which sees only an id the hub assigned.
    const frame = decodeFrame(JSON.stringify({ ...(decoded as Record<string, unknown>), t: 'open' }))
    if (!frame || frame.t !== 'open') return null
    return { id: frame.id, method: frame.method, path: frame.path, headers: frame.headers }
  } catch {
    return null
  }
}
