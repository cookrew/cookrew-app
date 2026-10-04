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

import { createHash } from 'node:crypto'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import type http from 'node:http'

/**
 * Below this, framing and the compressor's own header cost more than the
 * saving, and on a high-latency link an extra packet is worse than a few
 * hundred bytes.
 */
export const MIN_COMPRESS_BYTES = 1024

/**
 * Brotli quality for IMMUTABLE bodies (the renderer bundle): compressed once
 * per app run, so the quality is spent once. 5 buys 9–10% over gzip for ~25 ms
 * on the 1.6 MB bundle; 11 would spend seconds for a few more percent.
 */
const BROTLI_QUALITY = 5
/**
 * THE DYNAMIC BODIES ARE THE TAIL. /api/workspace and /api/state are 750 KB
 * on the Cookrew Dev canvas (590 KB of it note bodies) and were compressed
 * from scratch on every poll, on the main thread: gzip at the default level
 * measured 35 ms idle and 183 ms p50 / 520 ms p95 under the machine's usual
 * load, against 10 / 24 ms uncompressed — the compressor was the latency.
 *
 * Two things fix it. The LEVELS: on that payload brotli q4 takes 12.7 ms for
 * 277 KB and gzip level 3 takes 17 ms for 309 KB, against 35 ms / 287 KB for
 * gzip-6 — cheaper AND smaller, or cheaper for 7% more bytes. And the CACHE
 * below: a canvas that nobody is editing answers the same bytes poll after
 * poll, so the compressed copy is kept under the body's own hash and the
 * second poll costs a hash (0.9 ms), not a pass.
 */
const DYNAMIC_BROTLI_QUALITY = 4
const DYNAMIC_GZIP_LEVEL = 3

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

function pack(body: Buffer, encoding: Encoding, quality: 'once' | 'dynamic' = 'once'): Buffer {
  if (encoding === 'gzip') return gzipSync(body, quality === 'once' ? {} : { level: DYNAMIC_GZIP_LEVEL })
  return brotliCompressSync(body, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: quality === 'once' ? BROTLI_QUALITY : DYNAMIC_BROTLI_QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: body.length
    }
  })
}

/**
 * A body's own name: the hash of its bytes, as the ETag and as the key the
 * compressed copy is kept under. SHA-1 because it is the fastest digest Node
 * ships that is wide enough for a cache key — 0.9 ms on 750 KB — and nothing
 * here is a security claim.
 */
export function contentTag(body: Buffer): string {
  return createHash('sha1').update(body).digest('base64url')
}

/**
 * Compressed copies of DYNAMIC bodies, keyed by their content, kept while the
 * content keeps coming back. Bounded by count and by bytes: a handful of
 * canvases at a few hundred KB each, never a store. Insertion order is the
 * eviction order, and a hit is moved to the end so the live polls stay.
 */
interface Dynamic {
  out: Buffer
  bytes: number
}
const dynamic = new Map<string, Dynamic>()
const DYNAMIC_CACHE_LIMIT = 32
const DYNAMIC_CACHE_BYTES = 8 * 1024 * 1024
let dynamicBytes = 0
const stats = { hits: 0, misses: 0 }

function packDynamic(tag: string, body: Buffer, encoding: Encoding): Buffer {
  const id = `${encoding}:${tag}`
  const hit = dynamic.get(id)
  if (hit) {
    dynamic.delete(id)
    dynamic.set(id, hit)
    stats.hits += 1
    return hit.out
  }
  stats.misses += 1
  const out = pack(body, encoding, 'dynamic')
  dynamic.set(id, { out, bytes: out.length })
  dynamicBytes += out.length
  while (dynamic.size > DYNAMIC_CACHE_LIMIT || dynamicBytes > DYNAMIC_CACHE_BYTES) {
    const oldest = dynamic.keys().next().value
    if (oldest === undefined) break
    dynamicBytes -= dynamic.get(oldest)?.bytes ?? 0
    dynamic.delete(oldest)
  }
  return out
}

/** What the dynamic cache has done — for tests and the health page. */
export function dynamicCompressionStats(): { hits: number; misses: number; entries: number; bytes: number } {
  return { hits: stats.hits, misses: stats.misses, entries: dynamic.size, bytes: dynamicBytes }
}

/** Does an If-None-Match header name this tag? Weak comparison, `*` matches. */
export function etagMatches(ifNoneMatch: string | string[] | undefined, tag: string): boolean {
  const raw = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(',') : ifNoneMatch
  if (!raw) return false
  return raw.split(',').some((part) => {
    const candidate = part.trim().replace(/^W\//, '')
    return candidate === '*' || candidate === `"${tag}"`
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
   * caches the compressed bytes under that key, at the once-per-run quality.
   * Without it a body of any size is named by its own hash (contentTag) and
   * the compressed copy is kept while the same bytes keep being answered.
   */
  cacheKey?: string
  /**
   * The request's If-None-Match. A body whose tag it names is answered 304
   * with no bytes at all — the cheapest answer there is, and the companion's
   * fetch sends the header on its own once it has seen the ETag.
   */
  ifNoneMatch?: string | string[]
}

/**
 * A status that carries no body by definition: 1xx, 204 and 304 (RFC 9110
 * §6.4.1). Exported so the relay bridge can apply the same rule to an answer
 * it forwards.
 */
export const bodiless = (status: number): boolean => status < 200 || status === 204 || status === 304

/**
 * The headers a bodiless answer may NOT carry.
 *
 * MEASURED on the relay, 2026-09-08: a 204 that said `content-length: 2` left
 * Electron's Node 20 http client waiting for two bytes that never come, so
 * every phone beacon held a relay exchange until the 120 s idle deadline,
 * sixteen of them filled the per-desktop cap, and the companion shell died
 * with `too_many_exchanges`. Newer Node skips the body of a 204 whatever the
 * headers say; the fix is not to depend on which one is reading.
 */
const withoutBodyHeaders = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !['content-length', 'content-type', 'content-encoding'].includes(name.toLowerCase())
    )
  )

/**
 * Send a body, compressed when that helps and the client asked for it.
 *
 * A bodiless status (see `bodiless`) is sent with no body and no body headers,
 * whatever `body` the caller passed — `respondJson(response, 204, {})` is a
 * 204, not two bytes of JSON.
 *
 * `vary: accept-encoding` is not optional: without it a cache that saw one
 * client's brotli copy will hand it to a client that cannot decode it. `origin`
 * rides with it for the same reason and one level up: the CORS gate
 * (companion-cors.ts) writes an `access-control-allow-origin` that differs per
 * caller, and `writeHead` REPLACES a header that `setHeader` put there — so a
 * bare `vary: accept-encoding` here would silently drop the gate's half.
 */
export function sendBody(
  response: http.ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: Buffer,
  acceptEncoding: string | string[] | undefined,
  options: SendOptions = {}
): void {
  if (bodiless(status)) {
    response.writeHead(status, withoutBodyHeaders(headers))
    response.end()
    return
  }
  const contentType = headers['content-type'] ?? ''
  const worth = body.length >= MIN_COMPRESS_BYTES && compressible(contentType)
  // A dynamic body big enough to be worth compressing is worth naming too:
  // the tag is the cache key below and the ETag the client can send back.
  // Only a 200 is revalidatable — an error body is not "the resource".
  const tag = worth && !options.cacheKey && status === 200 ? contentTag(body) : null
  const named = tag === null ? headers : { ...headers, etag: `W/"${tag}"` }
  if (tag !== null && etagMatches(options.ifNoneMatch, tag)) {
    response.writeHead(304, { ...withoutBodyHeaders(named), vary: 'accept-encoding, origin' })
    response.end()
    return
  }
  const encoding = worth ? negotiateEncoding(acceptEncoding) : null
  if (!encoding) {
    response.writeHead(status, { ...named, 'content-length': String(body.length) })
    response.end(body)
    return
  }
  const out = options.cacheKey
    ? packCached(options.cacheKey, body, encoding)
    : tag !== null
      ? packDynamic(tag, body, encoding)
      : pack(body, encoding, 'dynamic')
  response.writeHead(status, {
    ...named,
    'content-encoding': encoding,
    vary: 'accept-encoding, origin',
    'content-length': String(out.length)
  })
  response.end(out)
}
