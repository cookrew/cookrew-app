import http from 'node:http'
import type { LiveValues } from '../../shared/launch-settings'
import { MAGPIE_REMOTE_KIND, magpieHeaders, modelRoute } from '../../shared/remote-magpie'
import type { Fields } from '../../shared/seal2/frames'
import { plainHeaders, requestFields } from '../../shared/seal2/http'
import { ABORT } from '../../shared/seal2/spec'
import type { Seal2Stream } from '../../shared/seal2/stream'
import { remoteSwitchedOn } from './switches'
import { SWITCH_POLL_MS } from './serve'

/**
 * THIS COMPUTER'S WAY TO ANOTHER ONE'S MAGPIE: A FORWARDER ONTO THE SEAL.
 *
 * Magpie's Remote magpie provider wants a URL. Here that URL is this forwarder,
 * on loopback: `http://127.0.0.1:<port>/peer/<device id>` (and `/v1` under it).
 * Each request this computer's Magpie sends there becomes one `magpie` stream of
 * the cookrew-seal/2 session to that desktop (seal-peers.ts · openStream), so
 * between the two computers there is only the relay's ciphertext: no tunnel onto
 * the other computer's loopback, no plain http across a network.
 *
 * Checked on EVERY request, before any byte leaves: both switches on HERE
 * (unreadable = off), the desktop is one this computer was connected to, and the
 * request looks like this computer's Magpie (no browser Origin, our own Host, a
 * model path). This is where a Magpie group or fallback that reaches the other
 * computer is stopped at dispatch time too: whatever Magpie picks, its request
 * comes through here.
 *
 * THE KEY. This computer's Magpie holds a placeholder (SEALED_PLACEHOLDER_KEY).
 * The key the other computer gave this one is kept in main (remotes.ts) and put
 * on each request here, in whichever credential header the request used. A
 * program that took this port while Cookrew is not running would be handed the
 * placeholder and the request, never the key (the residual: it does see the
 * prompt). A served seat cannot take or reach the port (sandbox-deny.ts,
 * route/service.ts · gatewayPorts).
 */

export interface ForwardDeps {
  /** This computer's switches, read now; null = unreadable = off. */
  switches(): LiveValues | null
  /** The key the desktop gave this computer, or null when this computer is not connected to it. */
  keyFor(peer: string): string | null
  openStream(peer: string, kind: string, fields: Fields): Promise<Seal2Stream>
  /** Is the process that opened this connection allowed to use the forwarder (caller.ts)? Asked once per connection. */
  callerAllowed(request: http.IncomingMessage): Promise<boolean>
  /** Asked on every request: false or a throw refuses (the served-seat gate). */
  open(): Promise<boolean>
  log(line: string): void
  /** Tests shorten it; defaults to SWITCH_POLL_MS (serve.ts). */
  readonly switchPollMs?: number
}

const PEER_PATH = /^\/peer\/([A-Za-z0-9_-]{8,128})(\/.*)$/
/** How long a whole answer waits for its stream to close by itself before it is let go. */
const SETTLE_MS = 1_000

function refuse(response: http.ServerResponse, status: number, message: string): void {
  if (response.headersSent) return void response.destroy()
  const body = JSON.stringify({ error: { type: 'cookrew_sealed', message } })
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

/** The request's headers for the far Magpie: the allowed ones and the real key (remote-magpie.ts · magpieHeaders). */
export function sealedHeaders(raw: http.IncomingHttpHeaders, key: string): Record<string, string> {
  const flat = Object.fromEntries(Object.entries(raw).flatMap(([name, value]) => (value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]])))
  return magpieHeaders(flat, key)
}

/** An answer's headers for Node: several Set-Cookie arrive joined by a newline, which Node refuses in one value. */
function answerHeaders(headers: Record<string, string>): http.OutgoingHttpHeaders {
  const { 'content-length': _length, 'transfer-encoding': _te, connection: _c, ...kept } = headers
  return Object.fromEntries(Object.entries(kept).map(([name, value]) => [name, name === 'set-cookie' ? value.split('\n') : value]))
}

function hostIsOurs(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}

export function createMagpieForwarder(deps: ForwardDeps): {
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void
  listen(port: number): Promise<number>
  close(): Promise<void>
  port(): number | null
  /** The switches may have changed: when either is off (or unreadable), every answer still streaming through here is cut. */
  switchesChanged(): void
} {
  let server: http.Server | null = null
  /**
   * Answers streaming through here now (relay verification L1): switching off on THIS computer cuts them,
   * as it does on the other one (serve.ts), and not only the requests that come after.
   */
  const inFlight = new Set<{ readonly stream: Seal2Stream; readonly response: http.ServerResponse }>()
  let poll: ReturnType<typeof setInterval> | null = null
  const switchesChanged = (): void => {
    if (switchedOn()) return
    for (const live of inFlight) {
      try {
        live.stream.abort(ABORT.refused, 'Magpie remote switched off')
        live.response.destroy()
      } catch {
        // Already gone: nothing streams on it.
      }
    }
    inFlight.clear()
  }
  const watchSwitches = (): void => {
    if (poll !== null) return
    poll = setInterval(() => {
      switchesChanged()
      if (inFlight.size === 0 && poll !== null) {
        clearInterval(poll)
        poll = null
      }
    }, deps.switchPollMs ?? SWITCH_POLL_MS)
    poll.unref?.()
  }
  let bound: number | null = null

  const switchedOn = (): boolean => remoteSwitchedOn(() => deps.switches())
  /** One answer per connection: a keep-alive connection is one caller. */
  const callers = new WeakMap<object, Promise<boolean>>()
  const callerOk = (request: http.IncomingMessage): Promise<boolean> => {
    const known = callers.get(request.socket)
    if (known !== undefined) return known
    const asked = deps.callerAllowed(request).catch(() => false)
    callers.set(request.socket, asked)
    return asked
  }

  const handle = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    const port = bound ?? request.socket.localPort ?? 0
    // A browser page aimed at loopback (DNS rebinding, a malicious site) is not this computer's Magpie.
    if (request.headers.origin !== undefined || !hostIsOurs(request.headers.host, port)) return refuse(response, 403, 'Not a request from this computer’s Magpie.')
    const m = PEER_PATH.exec(request.url ?? '')
    if (m === null) return refuse(response, 404, 'No such computer.')
    const [, peer, path] = m
    if (!modelRoute(request.method ?? 'GET', path)) return refuse(response, 404, 'Only model requests go to another computer.')
    if (!switchedOn()) return refuse(response, 403, 'Magpie remote is switched off in Launch settings on this computer.')
    if (!(await callerOk(request))) return refuse(response, 403, 'Only this computer’s Magpie may use this.')
    if (!(await deps.open().catch(() => false))) return refuse(response, 403, 'A served session runs under an older sandbox: other computers’ Magpies are shut until it is restarted.')
    // Asked again after the slow checks above (caller, gate): a switch turned off while they ran is honoured here.
    if (!switchedOn()) return refuse(response, 403, 'Magpie remote is switched off in Launch settings on this computer.')
    let key: string | null
    try {
      key = deps.keyFor(peer)
    } catch {
      key = null
    }
    if (key === null) return refuse(response, 403, 'This computer is not connected to that one’s Magpie.')
    let fields: Fields
    try {
      fields = requestFields(request.method ?? 'GET', path, sealedHeaders(request.headers, key))
    } catch {
      return refuse(response, 400, 'Not a request the seal carries.')
    }
    // Listened for before the handshake: a caller that leaves while the session is opening is seen.
    let stream: Seal2Stream | null = null
    let gone = false
    response.once('close', () => {
      if (response.writableFinished) return
      gone = true
      stream?.abort(ABORT.cancel, 'the caller went away')
    })
    try {
      stream = await deps.openStream(peer, MAGPIE_REMOTE_KIND, fields)
    } catch (error) {
      deps.log(`magpie remote: no sealed way to ${peer.slice(0, 8)}…: ${error instanceof Error ? error.message : 'unknown'}`)
      return refuse(response, 502, 'The other computer could not be reached over the sealed relay.')
    }
    if (gone) return stream.abort(ABORT.cancel, 'the caller went away')
    const open = stream
    let closed = false
    void open.closed.then(() => void (closed = true), () => void (closed = true))
    const live = { stream: open, response }
    inFlight.add(live)
    watchSwitches()
    // Once more now it is listed (relay acceptance 1): switched off while the stream opened, nothing is carried;
    // switched off from here on, the registry cuts it.
    if (!switchedOn()) {
      inFlight.delete(live)
      open.abort(ABORT.refused, 'Magpie remote switched off')
      return refuse(response, 403, 'Magpie remote is switched off in Launch settings on this computer.')
    }
    try {
      await carry(request, response, open)
      // The answer is whole; a request body the far end never read (a refusal) would hold the stream open
      // on both ends for good, each of them a slot of the session's few. Let it go.
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([open.closed.catch(() => undefined), new Promise<void>((r) => (timer = setTimeout(r, SETTLE_MS)))])
      clearTimeout(timer)
    } finally {
      inFlight.delete(live)
      // Whatever ended this (a throw included), the stream is not left holding a slot at either end.
      if (!closed) open.abort(ABORT.cancel, 'answered')
    }
  }

  /** The request body up, the answer down. */
  const carry = async (request: http.IncomingMessage, response: http.ServerResponse, stream: Seal2Stream): Promise<void> => {
    void pumpBody(request, stream).catch(() => stream.abort(ABORT.cancel, 'the request body stopped'))
    let head: Awaited<Seal2Stream['head']>
    try {
      head = await stream.head
    } catch {
      return refuse(response, 502, 'The other computer stopped answering.')
    }
    const headers = plainHeaders(head.fields, true)
    if (headers === null) return refuse(response, 502, 'The other computer answered with headers that cannot be read.')
    response.writeHead(head.status, answerHeaders(headers))
    await pumpAnswer(stream, response)
  }

  return {
    switchesChanged,
    handler: (request, response) => {
      void handle(request, response).catch(() => refuse(response, 500, 'The forwarder failed.'))
    },
    listen: (port) =>
      new Promise((resolve, reject) => {
        const s = http.createServer((request, response) => void handle(request, response).catch(() => refuse(response, 500, 'The forwarder failed.')))
        s.once('error', reject)
        s.listen(port, '127.0.0.1', () => {
          server = s
          bound = (s.address() as { port: number }).port
          resolve(bound)
        })
      }),
    close: () =>
      new Promise((resolve) => {
        const s = server
        server = null
        bound = null
        if (s === null) return resolve()
        s.close(() => resolve())
        s.closeAllConnections?.()
      }),
    port: () => bound
  }
}

/** The request body into the stream, at the pace the stream's credit allows. */
async function pumpBody(request: http.IncomingMessage, stream: Seal2Stream): Promise<void> {
  const writer = stream.writable.getWriter()
  for await (const chunk of request) {
    await writer.ready
    await writer.write(new Uint8Array(chunk as Buffer))
  }
  await writer.close()
}

/** The answer back to this computer's Magpie, holding the stream while the socket is behind. */
async function pumpAnswer(stream: Seal2Stream, response: http.ServerResponse): Promise<void> {
  const reader = stream.readable.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!response.write(value)) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            response.off('drain', done)
            response.off('close', done)
            resolve()
          }
          response.on('drain', done)
          response.on('close', done)
        })
      }
      if (response.destroyed) throw new Error('the caller went away')
    }
    response.end()
  } catch {
    // The stream was cut: the answer is not complete, so it must not look complete.
    response.destroy()
  }
}
