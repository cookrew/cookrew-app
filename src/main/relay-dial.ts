import http from 'node:http'
import https from 'node:https'
import { decodeFrame } from '../shared/relay-frame'
import type { RelaySocket } from './relay-client'

/**
 * DIALLING OUT TO THE RELAY, from a laptop nobody can dial into.
 *
 * Two HTTP requests that never finish: a GET whose response streams the
 * requests arriving for this door, and a POST whose body streams the answers
 * going back. Between them they are a socket, which is the only thing
 * relay-client needs them to be.
 *
 * The downlink is opened FIRST and waited on. The relay will not accept an
 * uplink for a door it is not already holding, so an uplink that raced ahead
 * would be refused for a reason that reads like a credential problem.
 */

export interface RelayDial {
  socket: RelaySocket
  /** The name the relay confirmed. Resolves when the door is live. */
  ready: Promise<string>
  close(): void
}

export class RelayDialFailed extends Error {}

export interface RelayDialOptions {
  /** Where the relay lives, e.g. https://cookrew.dev */
  origin: string
  /** From POST /v1/relay/ticket. Short-lived, and never put in a log line. */
  ticket: string
  log?: (message: string) => void
}

export function dialRelay(options: RelayDialOptions): RelayDial {
  const log = options.log ?? ((): void => undefined)
  const base = new URL(options.origin)
  const agent = base.protocol === 'https:' ? https : http
  const listeners: ((data: string) => void)[] = []
  const closers: (() => void)[] = []
  let uplink: http.ClientRequest | null = null
  let closed = false
  /** Frames produced before the uplink exists, in order. */
  const queued: string[] = []

  let settle: (name: string) => void = () => undefined
  let refuse: (error: Error) => void = () => undefined
  const ready = new Promise<string>((resolve, reject) => {
    settle = resolve
    refuse = reject
  })
  // Nothing may await this before the uplink is attached, and an unobserved
  // rejection would take the process down rather than the connection.
  ready.catch(() => undefined)

  const shutDown = (why: string): void => {
    if (closed) return
    closed = true
    log(`relay: the line to ${base.host} ended (${why})`)
    uplink?.end()
    uplink = null
    refuse(new RelayDialFailed(why))
    closers.forEach((c) => c())
  }

  const url = (path: string): string =>
    `${base.origin}${path}?ticket=${encodeURIComponent(options.ticket)}`

  // ── the downlink: requests arriving for this door ──────────────────────
  const down = agent.request(url('/v1/relay/door'), { method: 'GET' }, (res) => {
    if (res.statusCode !== 200) {
      res.resume()
      shutDown(`the relay refused the door (${res.statusCode ?? 0})`)
      return
    }
    let buffer = ''
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => {
      buffer += chunk
      let at = buffer.indexOf('\n')
      while (at >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        at = buffer.indexOf('\n')
        if (line.length === 0) continue
        const frame = decodeFrame(line)
        // `ready` is the relay confirming the name; it is answered here rather
        // than handed on, because relay-client has no use for it.
        if (frame?.t === 'ready') {
          openUplink()
          settle(frame.name)
          continue
        }
        if (frame?.t === 'abort' && frame.id === 'x') {
          shutDown(`the relay would not serve this name (${frame.reason})`)
          continue
        }
        listeners.forEach((l) => l(line))
      }
    })
    res.on('end', () => shutDown('the relay closed the line'))
    res.on('error', (error) => shutDown(String(error)))
  })
  down.on('error', (error) => shutDown(String(error)))
  down.end()

  // ── the uplink: answers going back ────────────────────────────────────
  function openUplink(): void {
    if (uplink || closed) return
    // No content-length and no transfer-encoding of our own: this body ends
    // when the door does, and declaring chunked by hand makes Node announce a
    // framing it then does not apply — the frames arrive as an unparseable
    // body and the door looks silent while answering perfectly.
    const request = agent.request(
      url('/v1/relay/uplink'),
      { method: 'POST', headers: { 'content-type': 'application/x-ndjson' } },
      (res) => {
        res.resume()
        if (res.statusCode !== 200) shutDown(`the relay refused the uplink (${res.statusCode ?? 0})`)
      }
    )
    request.on('error', (error) => shutDown(String(error)))
    uplink = request
    for (const line of queued) request.write(`${line}\n`)
    queued.length = 0
  }

  const socket: RelaySocket = {
    send: (data) => {
      if (closed) return
      // Answers can be ready before the uplink is, on the very first request.
      if (!uplink) queued.push(data)
      else uplink.write(`${data}\n`)
    },
    close: () => shutDown('the door withdrew'),
    onMessage: (listener) => listeners.push(listener),
    onClose: (listener) => closers.push(listener)
  }

  return {
    socket,
    ready,
    close: () => {
      shutDown('the door withdrew')
      down.destroy()
    }
  }
}

/**
 * Ask the relay for a ticket. One authenticated call; the two long streams
 * then present the ticket instead of a credential, so nothing durable ends up
 * in a URL that a proxy might log.
 */
export async function relayTicket(
  origin: string,
  name: string,
  assertion: unknown
): Promise<{ ok: true; ticket: string } | { ok: false; status: number }> {
  const response = await fetch(new URL('/v1/relay/ticket', origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, assertion })
  })
  if (!response.ok) return { ok: false, status: response.status }
  const body = (await response.json()) as { ticket?: unknown }
  return typeof body.ticket === 'string'
    ? { ok: true, ticket: body.ticket }
    : { ok: false, status: response.status }
}
