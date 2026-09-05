import http from 'node:http'
import https from 'node:https'
import { decodeFrame, encodeFrame, type RelayFrame, type StreamId } from '../shared/relay-frame'
import type { CallerTransport } from './relay-caller'

/**
 * REACHING A DOOR THROUGH THE RELAY.
 *
 * One HTTP request per exchange: the sealed body goes up, the frames come
 * streaming back. A caller needs no long-lived connection at all — hanging up
 * is aborting the request, which is what a closed card, a lost network and a
 * killed app all look like from the other end.
 *
 * This is a TRANSPORT for relay-caller, which owns the seal and the protocol.
 * Nothing here can read what it carries either, and it holds no key: the same
 * frames would travel over a socket, a pipe, or a test with no network.
 */

export interface RelayReachOptions {
  /** Where the relay lives, e.g. https://cookrew.dev */
  origin: string
  /** The door's published name, `@handle/team`. */
  name: string
  log?: (message: string) => void
}

/** A CallerTransport that speaks the relay's HTTP shape. */
export function reachOverHttp(options: RelayReachOptions): CallerTransport {
  const log = options.log ?? ((): void => undefined)
  const base = new URL(options.origin)
  const agent = base.protocol === 'https:' ? https : http
  const listeners: ((data: string) => void)[] = []
  const closers: (() => void)[] = []
  const exchanges = new Map<StreamId, http.ClientRequest>()
  let closed = false

  const deliver = (line: string): void => listeners.forEach((l) => l(line))
  const fail = (id: StreamId, reason: string): void =>
    deliver(encodeFrame({ t: 'abort', id, reason }))

  const [, handle, team] = /^@([^/]+)\/(.+)$/.exec(options.name) ?? []
  /** Exchanges whose body frame arrived, so `start` must not end them early. */
  const bodied = new Set<StreamId>()

  const start = (frame: Extract<RelayFrame, { t: 'open' }>): void => {
    if (!handle || !team) {
      fail(frame.id, 'that is not a door name')
      return
    }
    const path = `/v1/relay/call/${encodeURIComponent(`@${handle}`)}/${encodeURIComponent(team)}`
    const op = Buffer.from(
      // The caller's own label travels with the request, so the frames come
      // back under it. Without it the relay would answer under an id of its
      // own choosing and the caller would not recognise its own exchange.
      JSON.stringify({
        id: frame.id,
        method: frame.method,
        path: frame.path,
        headers: frame.headers
      }),
      'utf8'
    ).toString('base64url')

    const request = agent.request(
      `${base.origin}${path}`,
      { method: 'POST', headers: { 'x-relay-op': op, 'content-type': 'application/octet-stream' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          // A status is all a caller gets here. The door's own refusals — the
          // 401, the 402 — arrive as frames; a status at THIS layer means the
          // relay could not reach the door at all.
          fail(frame.id, res.statusCode === 404 ? 'not-serving' : `relay-${res.statusCode ?? 0}`)
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
            // Retired BEFORE delivering, so the response ending behind a
            // terminal frame reads as a finished exchange rather than as the
            // relay having dropped one.
            const frame = decodeFrame(line)
            if (frame && (frame.t === 'end' || frame.t === 'abort')) {
              exchanges.delete(frame.id)
              bodied.delete(frame.id)
            }
            deliver(line)
          }
        })
        res.on('end', () => {
          // The stream ending without an `end` frame is the relay or the
          // network giving up, and a caller waiting on a line must be told.
          if (exchanges.delete(frame.id)) fail(frame.id, 'the relay closed the exchange')
        })
        res.on('error', (error) => {
          log(`relay: exchange ${frame.id} failed: ${String(error)}`)
          if (exchanges.delete(frame.id)) fail(frame.id, 'the relay closed the exchange')
        })
      }
    )
    request.on('error', (error) => {
      log(`relay: could not reach ${base.host}: ${String(error)}`)
      if (exchanges.delete(frame.id)) fail(frame.id, 'the relay could not be reached')
    })
    exchanges.set(frame.id, request)
    // The body, if there is one, arrives in the very next frame — synchronously
    // from relay-caller. Ending on the next tick lets it land without making
    // every body-less request wait for a timer.
    process.nextTick(() => {
      if (!request.writableEnded && !bodied.has(frame.id)) request.end()
    })
  }

  return {
    send: (data) => {
      if (closed) return
      const frame = decodeFrame(data)
      if (!frame) return
      switch (frame.t) {
        case 'open':
          start(frame)
          return
        case 'body': {
          const request = exchanges.get(frame.id)
          if (!request) return
          bodied.add(frame.id)
          request.write(frame.data)
          if (frame.done) request.end()
          return
        }
        case 'end':
        case 'abort': {
          // The caller hung up. Aborting the request is what tells the relay,
          // which tells the door to stop producing.
          const request = exchanges.get(frame.id)
          exchanges.delete(frame.id)
          bodied.delete(frame.id)
          request?.destroy()
          return
        }
        default:
          return
      }
    },
    close: () => {
      closed = true
      for (const request of exchanges.values()) request.destroy()
      exchanges.clear()
      closers.forEach((c) => c())
    },
    onMessage: (listener) => listeners.push(listener),
    onClose: (listener) => closers.push(listener)
  }
}
