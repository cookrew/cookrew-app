import type http from 'node:http'
import { timingSafeEqual, createHash } from 'node:crypto'
import { createGzip, constants as zlibConstants } from 'node:zlib'
import { acceptsGzip, sendBody } from './http-compress'

/** Small HTTP helpers shared by the mobile server's route modules. */

/**
 * What the client will accept, taken from the response's own request.
 *
 * Reading it here rather than threading it through means 88 call sites did
 * not have to change to get compression — and none of them can forget to.
 */
function acceptEncodingOf(response: http.ServerResponse): string | string[] | undefined {
  return response.req?.headers['accept-encoding']
}

export function respondJson(
  response: http.ServerResponse,
  status: number,
  body: unknown
): void {
  // No access-control-allow-origin (C2): the phone UI is served same-origin
  // by this very server, so CORS is unneeded — and a wildcard let any web
  // page in any browser read transcripts and drive mutating routes.
  //
  // Compressed because these are not small: /api/state measured 230 KB and
  // /api/agents 149 KB on a working canvas, and both give up three quarters
  // of themselves. Over a relayed tailnet that is the difference between a
  // canvas that appears and one that is still arriving.
  sendBody(
    response,
    status,
    { 'content-type': 'application/json' },
    Buffer.from(JSON.stringify(body ?? null)),
    acceptEncodingOf(response)
  )
}

/**
 * Pairing-token check for mutating mobile routes (C1): the desktop surfaces
 * the token once (as `?token=` on the pairing URL) and clients send it back
 * as `Authorization: Bearer <token>` — or as `?token=` for clients that
 * cannot set headers. Compared constant-time; a missing/short candidate
 * never matches.
 */
export function pairingAuthorized(
  request: Pick<http.IncomingMessage, 'headers'>,
  url: URL,
  token: string
): boolean {
  const header = request.headers.authorization
  const bearer = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice('Bearer '.length)
    : null
  const candidate = bearer ?? url.searchParams.get('token')
  if (!candidate) return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function readBody(request: http.IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    request.on('data', (chunk) => {
      data += chunk
      if (data.length > limit) {
        reject(new Error('Body too large'))
        // Rejecting alone left the request streaming into a string that was
        // already over the limit — the caller had given up but the memory
        // kept growing.
        request.destroy()
      }
    })
    request.on('end', () => resolve(data))
    request.on('error', reject)
  })
}

/**
 * Read a request body as BYTES.
 *
 * Uploads used to arrive as base64 inside JSON, which meant a 20 MB photo was
 * built up as a 27 MB JavaScript string one chunk at a time and then handed to
 * JSON.parse — on the Electron MAIN process, so the whole app stopped until it
 * finished. Collecting buffers costs neither the 33% inflation nor the parse.
 *
 * The cap is counted in real bytes and enforced as they arrive, so an
 * oversized upload is cut off mid-flight rather than after it has all landed.
 */
export function readBytes(request: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('Body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

export async function readJson<T>(request: http.IncomingMessage, limit?: number): Promise<T> {
  const raw = await readBody(request, limit)
  return JSON.parse(raw || '{}') as T
}

export type SseSend = (event: string, data: unknown) => void

/**
 * Events whose payload is a WHOLE snapshot of some state, so an identical
 * consecutive one carries no information at all.
 *
 * Measured over 30 s on a working canvas: 44 `board` pushes, 2 distinct —
 * 140 KB spent re-sending a board that had not changed. `activity` is
 * deliberately absent; those are per-terminal notifications and every one of
 * the 102 observed differed.
 */
const SNAPSHOT_EVENTS = new Set(['board', 'workspace', 'workspaces'])

/**
 * Switch a response into a Server-Sent-Events stream. Returns the emitter;
 * register cleanup via `request.on('close', ...)` at the call site.
 *
 * The stream is gzipped when the client allows it. That matters more here
 * than anywhere else: a compressor's window remembers what it already sent,
 * and this stream re-sends whole snapshots — including agent prompt text that
 * never changes between pushes. 557 KB of 30 s traffic became 87 KB without
 * changing a single payload. Every event is flushed with Z_SYNC_FLUSH, which
 * ends a deflate block so the phone can decode it the moment it lands; without
 * that the events would sit in the compressor and the UI would look frozen.
 */
/**
 * Idle keepalive. Long enough to be nearly free, short enough to beat the
 * intermediaries that drop a silent connection — iOS is the aggressive one.
 */
const SSE_HEARTBEAT_MS = 25_000

export function startSse(response: http.ServerResponse): SseSend {
  const compressed = acceptsGzip(response.req?.headers['accept-encoding'])
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    ...(compressed ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {})
  })

  const gzip = compressed ? createGzip() : null
  if (gzip) {
    gzip.pipe(response)
    // The response outliving its compressor, or the reverse, leaks one per
    // phone that backgrounds the page. iOS reaps those connections often.
    response.on('close', () => gzip.destroy())
    gzip.on('error', () => response.destroy())
  }
  const write = (frame: string): void => {
    if (!gzip) {
      response.write(frame)
      return
    }
    gzip.write(frame)
    gzip.flush(zlibConstants.Z_SYNC_FLUSH)
  }

  write(':ok\n\n')

  // The heartbeat lives HERE, not at the call sites.
  //
  // It used to be `setInterval(() => response.write(':hb\n\n'), 25000)` next to
  // each stream. Once the stream is compressed, `response` is the compressor's
  // OUTPUT — so that wrote plaintext into the middle of a gzip byte stream and
  // the phone's decoder gave up. Measured: a terminal stream delivered 4096
  // bytes, then nothing, and no heartbeat ever arrived. The transcript looked
  // frozen until EventSource noticed, reconnected, and died again 25 s later.
  //
  // A call site cannot make that mistake if it never touches the response.
  const heartbeat = setInterval(() => write(':hb\n\n'), SSE_HEARTBEAT_MS)
  heartbeat.unref()
  response.on('close', () => clearInterval(heartbeat))

  /** Digest of the last payload per snapshot event, to drop exact repeats. */
  const lastSnapshot = new Map<string, string>()
  return (event, data) => {
    const payload = JSON.stringify(data)
    if (SNAPSHOT_EVENTS.has(event)) {
      const digest = createHash('sha1').update(payload).digest('base64')
      if (lastSnapshot.get(event) === digest) return
      lastSnapshot.set(event, digest)
    }
    write(`event: ${event}\ndata: ${payload}\n\n`)
  }
}

/**
 * Hold keep-alive sockets open long enough to span a reader's pause.
 *
 * Node's 5s default is tuned for servers behind a fronting proxy; this one
 * has none, and its client TYPES INTERMITTENTLY. Every pause longer than the
 * window closed the connection, so the next keystroke paid a fresh TCP+TLS
 * handshake — over a relayed tailnet (round trips 300ms–2.5s) that is the
 * difference between an echo and a stall, and it read as "the terminal is
 * laggy" when the pty itself answered instantly. headersTimeout stays above
 * keepAliveTimeout: Node documents an ECONNRESET race for reused sockets
 * torn down between those two clocks.
 */
export function holdSocketsOpen(server: http.Server): void {
  server.keepAliveTimeout = 75_000
  server.headersTimeout = 80_000
}
