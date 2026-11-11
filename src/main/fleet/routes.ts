// THE FLEET ROUTES on the companion server (src/shared/fleet.ts):
//
//   GET /api/fleet               FleetSnapshot, ETag'd by content hash
//   GET /api/fleet/stream        text/event-stream: a snapshot, then deltas;
//                                 a ':' line every FLEET_HEARTBEAT_MS
//   GET /api/fleet/gauges        MachineGauges (gauges-route.ts)
//
// PAIRING scope only. The companion's /api GET gate already ran (mobile-api ·
// C1) and lets the read-only wall token through; that token must not read
// note bodies and full addresses, so these routes ask for the pairing (or an
// admitted phone's own) token again. EventSource sends no headers: ?token= is
// accepted, as on every companion stream. Unslugged on purpose — none of this
// needs multi-instance.

import type http from 'node:http'
import { createGzip, constants as zlibConstants } from 'node:zlib'
import type { FleetEvent } from '../../shared/fleet'
import { acceptsGzip, etagMatches, sendBody, validatorOf } from '../http-compress'
import { respondJson } from '../mobile-http'
import type { GaugeReader } from '../machine-gauges'
import { handleGaugeRoute } from './gauges-route'
import type { FleetService } from './service'

/** The relay drops a stream silent for 120 s; the contract promises a ':' line every 15 s. */
export const FLEET_HEARTBEAT_MS = 15_000

export interface FleetRouteDeps {
  /** Asked only for a fleet path. Null = the routes answer 503 (the board's sources are not wired). */
  service: () => FleetService | null
  /** Does this request carry the pairing scope? */
  paired: (request: http.IncomingMessage, url: URL) => boolean
  heartbeatMs?: number
  /** The machine's gauges; the process's shared watch when absent. */
  gauges?: GaugeReader
}

const FLEET_PATH = /^\/api\/fleet(?:\/(stream))?\/?$/

/** True when the request was a fleet route and has been answered. */
export function handleFleetRoutes(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  deps: FleetRouteDeps
): boolean {
  // Before the service check: a machine's load needs no board.
  if (handleGaugeRoute(request, response, url, deps)) return true
  const match = FLEET_PATH.exec(url.pathname)
  if (!match) return false
  if (request.method !== 'GET') {
    respondJson(response, 405, { error: 'GET only' })
    return true
  }
  if (!deps.paired(request, url)) {
    respondJson(response, 401, { error: 'Unauthorized — the fleet feed needs this desktop’s pairing token.' })
    return true
  }
  const service = deps.service()
  if (!service) {
    respondJson(response, 503, { error: 'fleet not wired' })
    return true
  }
  try {
    if (match[1]) openStream(request, response, service, deps.heartbeatMs ?? FLEET_HEARTBEAT_MS)
    else answerSnapshot(request, response, service)
  } catch (error) {
    console.error('Fleet route failed:', error)
    if (!response.headersSent) respondJson(response, 500, { error: 'fleet failed' })
  }
  return true
}

function answerSnapshot(request: http.IncomingMessage, response: http.ServerResponse, service: FleetService): void {
  const { body, etag } = service.current()
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-cache', etag: `"${etag}"` }
  // The tag the reader holds, in a header or in the address (http-compress.ts · validatorOf).
  if (etagMatches(validatorOf(request), etag)) {
    response.writeHead(304, { etag: headers.etag, 'cache-control': headers['cache-control'], vary: 'accept-encoding, origin' })
    response.end()
    return
  }
  // Content-addressed: the compressed copy is kept under the hash, so a
  // dozen phones reloading one unchanged fleet compress it once.
  sendBody(response, 200, headers, body, request.headers['accept-encoding'], { cacheKey: `fleet:${etag}` })
}

/** Unnamed `data:` frames (the default 'message' event), gzip when asked, a ':' line on a timer. */
function openStream(request: http.IncomingMessage, response: http.ServerResponse, service: FleetService, heartbeatMs: number): void {
  const compressed = acceptsGzip(request.headers['accept-encoding'])
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...(compressed ? { 'content-encoding': 'gzip', vary: 'accept-encoding, origin' } : {})
  })
  const gzip = compressed ? createGzip() : null
  if (gzip) {
    gzip.pipe(response)
    gzip.on('error', () => response.destroy())
  }
  let open = true
  const write = (frame: string): void => {
    if (!open || response.writableEnded || response.destroyed) return
    if (!gzip) {
      response.write(frame)
      return
    }
    gzip.write(frame)
    gzip.flush(zlibConstants.Z_SYNC_FLUSH)
  }
  const send = (event: FleetEvent): void => write(`data: ${JSON.stringify(event)}\n\n`)
  let unsubscribe: () => void
  try {
    unsubscribe = service.subscribe(send)
  } catch (error) {
    // The head is out, so a status cannot say it: end the stream, and the
    // client's reconnect asks again.
    console.error('Fleet stream could not open:', error)
    open = false
    if (gzip) gzip.end()
    else response.end()
    return
  }
  const heartbeat = setInterval(() => write(':\n\n'), heartbeatMs)
  heartbeat.unref?.()
  response.on('close', () => {
    open = false
    clearInterval(heartbeat)
    unsubscribe()
    gzip?.destroy()
  })
}
