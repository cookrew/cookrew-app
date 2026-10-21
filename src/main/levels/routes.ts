// THE LEVELS ROUTES on the companion server (src/shared/strata.ts):
//
//   GET /api/levels               LevelsSnapshot, ETag'd by content hash
//   GET /api/levels/stream        text/event-stream: a snapshot, then deltas;
//                                 a ':' line every LEVELS_HEARTBEAT_MS
//   GET /api/levels/agents/<id>   LevelsAgentDetail
//
// PAIRING scope only. The companion's /api GET gate already ran (mobile-api ·
// C1) and lets the read-only wall token through; that token must not read
// note bodies and full addresses, so these routes ask for the pairing (or an
// admitted phone's own) token again. EventSource sends no headers: ?token= is
// accepted, as on every companion stream. Unslugged on purpose — none of this
// needs multi-instance.

import type http from 'node:http'
import { createGzip, constants as zlibConstants } from 'node:zlib'
import type { LevelsEvent } from '../../shared/strata'
import { acceptsGzip, etagMatches, sendBody } from '../http-compress'
import { respondJson } from '../mobile-http'
import type { LevelsService } from './service'

/** The relay drops a stream silent for 120 s; the contract promises a ':' line every 15 s. */
export const LEVELS_HEARTBEAT_MS = 15_000

export interface LevelsRouteDeps {
  /** Asked only for a levels path. Null = the routes answer 503 (the board's sources are not wired). */
  service: () => LevelsService | null
  /** Does this request carry the pairing scope? */
  paired: (request: http.IncomingMessage, url: URL) => boolean
  heartbeatMs?: number
}

const LEVELS_PATH = /^\/api\/levels(?:\/(stream)|\/agents\/([^/]+))?\/?$/

/** True when the request was a levels route and has been answered. */
export function handleLevelsRoutes(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  deps: LevelsRouteDeps
): boolean {
  const match = LEVELS_PATH.exec(url.pathname)
  if (!match) return false
  if (request.method !== 'GET') {
    respondJson(response, 405, { error: 'GET only' })
    return true
  }
  if (!deps.paired(request, url)) {
    respondJson(response, 401, { error: 'Unauthorized — the levels need this desktop’s pairing token.' })
    return true
  }
  const service = deps.service()
  if (!service) {
    respondJson(response, 503, { error: 'levels not wired' })
    return true
  }
  try {
    if (match[1]) openStream(request, response, service, deps.heartbeatMs ?? LEVELS_HEARTBEAT_MS)
    else if (match[2]) answerDetail(response, service, decodeURIComponent(match[2]))
    else answerSnapshot(request, response, service)
  } catch (error) {
    console.error('Levels route failed:', error)
    if (!response.headersSent) respondJson(response, 500, { error: 'levels failed' })
  }
  return true
}

function answerSnapshot(request: http.IncomingMessage, response: http.ServerResponse, service: LevelsService): void {
  const { body, etag } = service.current()
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-cache', etag: `"${etag}"` }
  if (etagMatches(request.headers['if-none-match'], etag)) {
    response.writeHead(304, { etag: headers.etag, 'cache-control': headers['cache-control'], vary: 'accept-encoding, origin' })
    response.end()
    return
  }
  // Content-addressed: the compressed copy is kept under the hash, so a
  // dozen phones reloading one unchanged fleet compress it once.
  sendBody(response, 200, headers, body, request.headers['accept-encoding'], { cacheKey: `levels:${etag}` })
}

function answerDetail(response: http.ServerResponse, service: LevelsService, agentId: string): void {
  const detail = service.detail(agentId)
  if (!detail) {
    respondJson(response, 404, { error: 'no such agent' })
    return
  }
  // Note bodies and full addresses: never kept by a cache on the way.
  response.setHeader('cache-control', 'no-store')
  respondJson(response, 200, detail)
}

/** Unnamed `data:` frames (the default 'message' event), gzip when asked, a ':' line on a timer. */
function openStream(request: http.IncomingMessage, response: http.ServerResponse, service: LevelsService, heartbeatMs: number): void {
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
  const send = (event: LevelsEvent): void => write(`data: ${JSON.stringify(event)}\n\n`)
  let unsubscribe: () => void
  try {
    unsubscribe = service.subscribe(send)
  } catch (error) {
    // The head is out, so a status cannot say it: end the stream, and the
    // client's reconnect asks again.
    console.error('Levels stream could not open:', error)
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
