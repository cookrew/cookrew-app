// Compression for the companion's own payloads.
//
// WHY THIS EXISTS
// ---------------
// Everything the phone loads was sent uncompressed. On the LAN that is
// invisible — megabytes at gigabit are milliseconds. Over a tailnet that could
// not hole-punch, the same bytes cross a DERP relay measured here at 293 ms to
// 2.5 s round trip with two of five probes lost, and every byte is felt.
//
// Measured on this workspace, uncompressed and now compressed:
//
//   renderer bundle    1.61 MB  →  318 KB   (br q5)
//   /api/state          230 KB  →   87 KB
//   /api/agents         149 KB  →   23 KB
//   30 s of SSE         557 KB  →   87 KB
//
// The SSE number is the interesting one: the stream re-sends whole snapshots
// including agent prompt text that never changes, and a compressor's window
// remembers what it already sent — so redundancy that would need a delta
// protocol to remove costs nearly nothing once the stream is compressed.
//
// SCOPE — encoding only. No routing, no auth, no caching policy.

import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import type http from 'node:http'

/**
 * Below this, framing and the compressor's own header cost more than the
 * saving, and on a high-latency link an extra packet is worse than a few
 * hundred bytes.
 */
export const MIN_COMPRESS_BYTES = 1024

/**
 * Brotli quality. 5 buys 9–10% over gzip on the real payloads for ~25 ms on
 * the 1.6 MB bundle; 11 would spend seconds of main-process time for a few
 * more percent, which on an Electron main thread is a UI freeze.
 */
const BROTLI_QUALITY = 5

export type Encoding = 'br' | 'gzip'

/** Parse one Accept-Encoding entry into a name and whether it was refused. */
function offers(header: string | string[] | undefined): Set<string> {
  const raw = Array.isArray(header) ? header.join(',') : header
  const accepted = new Set<string>()
  for (const part of (raw ?? '').toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map((piece) => piece.trim())
    if (!name) continue
    // `gzip;q=0` is a refusal, not an offer.
    if (params.some((param) => /^q=0(\.0+)?$/.test(param))) continue
    accepted.add(name)
  }
  return accepted
}

/** True when the client offered gzip. Identity is always acceptable. */
export function acceptsGzip(acceptEncoding: string | string[] | undefined): boolean {
  const accepted = offers(acceptEncoding)
  return accepted.has('gzip') || accepted.has('*')
}

/**
 * Best encoding the client will take, or null for none. Brotli first: it is
 * meaningfully smaller on text and every browser that can reach this server
 * supports it.
 */
export function negotiateEncoding(
  acceptEncoding: string | string[] | undefined
): Encoding | null {
  const accepted = offers(acceptEncoding)
  if (accepted.has('br')) return 'br'
  if (accepted.has('gzip') || accepted.has('*')) return 'gzip'
  return null
}

/**
 * Whether a content type is worth compressing. Images, fonts and video are
 * already compressed; running them through brotli spends CPU to add bytes.
 */
export function compressible(contentType: string): boolean {
  const type = contentType.split(';')[0].trim().toLowerCase()
  if (type.startsWith('text/')) return true
  if (type === 'image/svg+xml') return true
  return /^application\/(javascript|json|xml|wasm|manifest\+json)$/.test(type)
}

function pack(body: Buffer, encoding: Encoding): Buffer {
  if (encoding === 'gzip') return gzipSync(body)
  return brotliCompressSync(body, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: body.length
    }
  })
}

/**
 * Compressed copies of immutable bodies, so the 25 ms brotli pass on the
 * renderer bundle happens once per app run rather than once per phone that
 * reloads. Only content-addressed callers supply a key — anything whose bytes
 * could change under the same key must not be here.
 */
const packed = new Map<string, Buffer>()
const PACKED_CACHE_LIMIT = 24

function packCached(key: string, body: Buffer, encoding: Encoding): Buffer {
  const id = `${encoding}:${key}`
  const hit = packed.get(id)
  if (hit) return hit
  const result = pack(body, encoding)
  // Crude eviction: this holds a handful of bundle assets, not a workload.
  if (packed.size >= PACKED_CACHE_LIMIT) packed.clear()
  packed.set(id, result)
  return result
}

export interface SendOptions {
  /**
   * Content-addressed identity of `body` — a hashed asset path. Supplying it
   * caches the compressed bytes; omitting it compresses every time.
   */
  cacheKey?: string
}

/**
 * Send a body, compressed when that helps and the client asked for it.
 *
 * `vary: accept-encoding` is not optional: without it a cache that saw one
 * client's brotli copy will hand it to a client that cannot decode it.
 */
export function sendBody(
  response: http.ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: Buffer,
  acceptEncoding: string | string[] | undefined,
  options: SendOptions = {}
): void {
  const contentType = headers['content-type'] ?? ''
  const worth = body.length >= MIN_COMPRESS_BYTES && compressible(contentType)
  const encoding = worth ? negotiateEncoding(acceptEncoding) : null
  if (!encoding) {
    response.writeHead(status, { ...headers, 'content-length': String(body.length) })
    response.end(body)
    return
  }
  const out = options.cacheKey
    ? packCached(options.cacheKey, body, encoding)
    : pack(body, encoding)
  response.writeHead(status, {
    ...headers,
    'content-encoding': encoding,
    vary: 'accept-encoding',
    'content-length': String(out.length)
  })
  response.end(out)
}
