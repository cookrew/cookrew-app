import { describe, expect, it } from 'vitest'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import type http from 'node:http'
import {
  acceptsGzip,
  compressible,
  contentTag,
  dynamicCompressionStats,
  etagMatches,
  MIN_COMPRESS_BYTES,
  negotiateEncoding,
  sendBody
} from '../src/main/http-compress'

/**
 * Measured cause of "works on Wi-Fi, not on cellular": the companion sent
 * every payload uncompressed. On the LAN that is 0.3 s. Over a tailnet with no
 * direct path — DERP relay, 293 ms to 2.5 s round trip, 2 of 5 probes lost —
 * megabytes of uncompressed JavaScript never finish arriving.
 */

interface Captured {
  status: number
  headers: Record<string, string>
  chunks: Buffer[]
}

function stubResponse(): { response: http.ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, chunks: [] }
  const response = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status
      captured.headers = headers
      return this
    },
    end(body?: Buffer) {
      if (body) captured.chunks.push(Buffer.from(body))
    }
  } as unknown as http.ServerResponse
  return { response, captured }
}

const BIG_JS = Buffer.from('export const value = 1;\n'.repeat(500))

describe('acceptsGzip', () => {
  it('accepts the forms browsers actually send', () => {
    expect(acceptsGzip('gzip, deflate, br')).toBe(true)
    expect(acceptsGzip('gzip;q=1.0, identity;q=0.5')).toBe(true)
    expect(acceptsGzip('*')).toBe(true)
  })

  it('honours a refusal and a missing header', () => {
    // `gzip;q=0` means "do not", not "yes". Reading it as an offer would send
    // a body the client has told us it cannot decode.
    expect(acceptsGzip('gzip;q=0')).toBe(false)
    expect(acceptsGzip('deflate, br')).toBe(false)
    expect(acceptsGzip(undefined)).toBe(false)
    expect(acceptsGzip('')).toBe(false)
  })
})

describe('compressible', () => {
  it('says yes to the renderer payloads and no to already-packed bytes', () => {
    expect(compressible('text/javascript')).toBe(true)
    expect(compressible('text/html; charset=utf-8')).toBe(true)
    expect(compressible('text/css')).toBe(true)
    expect(compressible('application/json')).toBe(true)
    expect(compressible('image/svg+xml')).toBe(true)
    // Spending CPU to make these bigger is the only possible outcome.
    expect(compressible('image/png')).toBe(false)
    expect(compressible('font/woff2')).toBe(false)
    expect(compressible('image/jpeg')).toBe(false)
  })
})

describe('sendBody', () => {
  it('gzips a large script for a client that asked, and it round-trips', () => {
    const { response, captured } = stubResponse()
    sendBody(response, 200, { 'content-type': 'text/javascript' }, BIG_JS, 'gzip, deflate')
    expect(captured.headers['content-encoding']).toBe('gzip')
    const sent = Buffer.concat(captured.chunks)
    expect(gunzipSync(sent).equals(BIG_JS)).toBe(true)
    // The actual point of the exercise.
    expect(sent.length).toBeLessThan(BIG_JS.length / 4)
  })

  it('declares vary so a cache cannot hand gzip to a client without it', () => {
    const { response, captured } = stubResponse()
    sendBody(response, 200, { 'content-type': 'text/javascript' }, BIG_JS, 'gzip')
    // `origin` rides with it since reach v2.1: `writeHead` REPLACES a header
    // that `setHeader` put there, so a bare `accept-encoding` here would drop
    // the CORS gate's own `vary` and a cache could hand one origin's
    // `access-control-allow-origin` to another.
    expect(captured.headers.vary).toBe('accept-encoding, origin')
  })

  it('sends plain bytes when the client did not offer gzip', () => {
    const { response, captured } = stubResponse()
    sendBody(response, 200, { 'content-type': 'text/javascript' }, BIG_JS, undefined)
    expect(captured.headers['content-encoding']).toBeUndefined()
    expect(Buffer.concat(captured.chunks).equals(BIG_JS)).toBe(true)
  })

  it('leaves a small body alone — an extra packet costs more than it saves', () => {
    const small = Buffer.from('x'.repeat(MIN_COMPRESS_BYTES - 1))
    const { response, captured } = stubResponse()
    sendBody(response, 200, { 'content-type': 'text/javascript' }, small, 'gzip')
    expect(captured.headers['content-encoding']).toBeUndefined()
  })

  it('leaves already-compressed types alone even when large', () => {
    const png = Buffer.alloc(MIN_COMPRESS_BYTES * 4, 7)
    const { response, captured } = stubResponse()
    sendBody(response, 200, { 'content-type': 'image/png' }, png, 'gzip')
    expect(captured.headers['content-encoding']).toBeUndefined()
    expect(Buffer.concat(captured.chunks).equals(png)).toBe(true)
  })

  it('always states a content-length that matches what it wrote', () => {
    for (const encoding of [undefined, 'gzip']) {
      const { response, captured } = stubResponse()
      sendBody(response, 200, { 'content-type': 'text/javascript' }, BIG_JS, encoding)
      expect(Number(captured.headers['content-length'])).toBe(
        Buffer.concat(captured.chunks).length
      )
    }
  })

  /**
   * MEASURED on the relay, 2026-09-08: a 204 that said `content-length: 2`
   * left Electron's Node 20 http client waiting for two bytes that never come,
   * so every phone beacon held a relay exchange until the 120 s idle deadline,
   * sixteen of them filled the per-desktop cap, and the companion shell died
   * with `too_many_exchanges`. A bodiless status carries no body headers.
   */
  it('sends a 204 with no body, no content-length and no content-type', () => {
    for (const status of [204, 304]) {
      const { response, captured } = stubResponse()
      sendBody(response, status, { 'content-type': 'application/json' }, Buffer.from('{}'), 'gzip')
      expect(captured.status).toBe(status)
      expect(captured.chunks).toEqual([])
      expect(captured.headers['content-length']).toBeUndefined()
      expect(captured.headers['content-type']).toBeUndefined()
      expect(captured.headers['content-encoding']).toBeUndefined()
    }
  })

  it('keeps the caller’s other headers on a bodiless answer', () => {
    const { response, captured } = stubResponse()
    sendBody(response, 204, { 'content-type': 'application/json', vary: 'origin' }, Buffer.alloc(0), undefined)
    expect(captured.headers.vary).toBe('origin')
  })

  it('preserves the caller’s status and headers', () => {
    const { response, captured } = stubResponse()
    sendBody(
      response,
      200,
      { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=31536000, immutable' },
      BIG_JS,
      'gzip'
    )
    expect(captured.status).toBe(200)
    expect(captured.headers['cache-control']).toBe('public, max-age=31536000, immutable')
  })
})

describe('negotiateEncoding — brotli is 9–10% smaller on the real payloads', () => {
  it('prefers brotli when the browser offers it', () => {
    expect(negotiateEncoding('gzip, deflate, br')).toBe('br')
    expect(negotiateEncoding('br')).toBe('br')
  })

  it('falls back to gzip, then to nothing', () => {
    expect(negotiateEncoding('gzip, deflate')).toBe('gzip')
    expect(negotiateEncoding('*')).toBe('gzip')
    expect(negotiateEncoding('deflate')).toBeNull()
    expect(negotiateEncoding(undefined)).toBeNull()
  })

  it('treats br;q=0 as a refusal and drops to gzip', () => {
    expect(negotiateEncoding('br;q=0, gzip')).toBe('gzip')
  })
})

describe('sendBody with brotli', () => {
  it('brotli-encodes and round-trips', () => {
    const { response, captured } = stubResponse()
    sendBody(response, 200, { 'content-type': 'text/javascript' }, BIG_JS, 'br, gzip')
    expect(captured.headers['content-encoding']).toBe('br')
    expect(brotliDecompressSync(Buffer.concat(captured.chunks)).equals(BIG_JS)).toBe(true)
  })

  it('reuses the compressed copy for a content-hashed asset', () => {
    // The name IS the content hash, so the bytes cannot change under it.
    // Without this, brotli on the 1.6 MB bundle burns 25 ms of main-process
    // time on every phone reload — a visible stall in an Electron main.
    const key = '/assets/index-deadbeef.js'
    const first = stubResponse()
    sendBody(first.response, 200, { 'content-type': 'text/javascript' }, BIG_JS, 'br', {
      cacheKey: key
    })
    const second = stubResponse()
    const started = process.hrtime.bigint()
    sendBody(second.response, 200, { 'content-type': 'text/javascript' }, BIG_JS, 'br', {
      cacheKey: key
    })
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    expect(Buffer.concat(second.captured.chunks).equals(Buffer.concat(first.captured.chunks))).toBe(
      true
    )
    expect(elapsedMs).toBeLessThan(5)
  })
})

/**
 * THE DYNAMIC BODIES ARE THE TAIL. /api/workspace is 750 KB on a real canvas
 * and was compressed from scratch on every poll on the main thread — 183 ms
 * p50 / 520 ms p95 under load against 10 / 24 ms uncompressed. A canvas that
 * nobody is editing answers the same bytes poll after poll, so the compressed
 * copy is kept under the body's own hash, the client is told that hash as an
 * ETag, and a poll that names it back is answered with no bytes at all.
 */
describe('a dynamic body is compressed once while its bytes keep coming back', () => {
  const canvas = (seed: string): Buffer =>
    Buffer.from(JSON.stringify({ nodes: Array.from({ length: 400 }, (_, i) => ({ id: `${seed}-${i}`, content: `note ${seed} `.repeat(40) })) }))
  const json = { 'content-type': 'application/json' }

  it('answers the second poll from the cache, and the body still decodes to the same bytes', () => {
    const body = canvas('alpha')
    const before = dynamicCompressionStats()
    const first = stubResponse()
    sendBody(first.response, 200, json, body, 'gzip')
    const second = stubResponse()
    sendBody(second.response, 200, json, body, 'gzip')
    const after = dynamicCompressionStats()
    expect(after.misses - before.misses).toBe(1)
    expect(after.hits - before.hits).toBe(1)
    expect(gunzipSync(Buffer.concat(second.captured.chunks)).equals(body)).toBe(true)
    expect(first.captured.headers.etag).toBe(`W/"${contentTag(body)}"`)
    expect(second.captured.headers.etag).toBe(first.captured.headers.etag)
  })

  it('a body that changed is a new tag and a new pass', () => {
    const before = dynamicCompressionStats()
    const a = stubResponse()
    sendBody(a.response, 200, json, canvas('one'), 'br')
    const b = stubResponse()
    sendBody(b.response, 200, json, canvas('two'), 'br')
    expect(dynamicCompressionStats().misses - before.misses).toBe(2)
    expect(a.captured.headers.etag).not.toBe(b.captured.headers.etag)
    expect(brotliDecompressSync(Buffer.concat(b.captured.chunks)).equals(canvas('two'))).toBe(true)
  })

  it('answers 304 with no body to a client that names the tag it last saw', () => {
    const body = canvas('same')
    const seen = stubResponse()
    sendBody(seen.response, 200, json, body, 'gzip')
    const tag = seen.captured.headers.etag
    const again = stubResponse()
    sendBody(again.response, 200, json, body, 'gzip', { ifNoneMatch: tag })
    expect(again.captured.status).toBe(304)
    expect(again.captured.chunks).toEqual([])
    expect(again.captured.headers['content-length']).toBeUndefined()
    expect(again.captured.headers['content-encoding']).toBeUndefined()
    expect(again.captured.headers.etag).toBe(tag)
    // A stale tag is a full answer; so is a client that sent none.
    const stale = stubResponse()
    sendBody(stale.response, 200, json, body, 'gzip', { ifNoneMatch: 'W/"somethingelse"' })
    expect(stale.captured.status).toBe(200)
    expect(stale.captured.chunks.length).toBe(1)
  })

  it('names the body even for a client that takes no compression, so it can revalidate too', () => {
    const body = canvas('plain')
    const out = stubResponse()
    sendBody(out.response, 200, json, body, 'identity')
    expect(out.captured.headers.etag).toBe(`W/"${contentTag(body)}"`)
    expect(out.captured.headers['content-encoding']).toBeUndefined()
    const not = stubResponse()
    sendBody(not.response, 200, json, body, 'identity', { ifNoneMatch: out.captured.headers.etag })
    expect(not.captured.status).toBe(304)
  })

  it('does not name an error body or a small one, and never serves a 304 for them', () => {
    const error = stubResponse()
    sendBody(error.response, 500, json, canvas('err'), 'gzip', { ifNoneMatch: '*' })
    expect(error.captured.status).toBe(500)
    expect(error.captured.headers.etag).toBeUndefined()
    const small = stubResponse()
    sendBody(small.response, 200, json, Buffer.from('{"ok":true}'), 'gzip', { ifNoneMatch: '*' })
    expect(small.captured.status).toBe(200)
    expect(small.captured.headers.etag).toBeUndefined()
  })

  it('keeps a bounded number of copies — the oldest goes, the live ones stay', () => {
    for (let i = 0; i < 40; i += 1) sendBody(stubResponse().response, 200, json, canvas(`many-${i}`), 'gzip')
    const stats = dynamicCompressionStats()
    expect(stats.entries).toBeLessThanOrEqual(32)
    expect(stats.bytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    // The most recent is still a hit; the first has been evicted.
    const before = dynamicCompressionStats()
    sendBody(stubResponse().response, 200, json, canvas('many-39'), 'gzip')
    expect(dynamicCompressionStats().hits - before.hits).toBe(1)
    sendBody(stubResponse().response, 200, json, canvas('many-0'), 'gzip')
    expect(dynamicCompressionStats().misses - before.misses).toBe(1)
  })

  it('reads If-None-Match the way clients write it', () => {
    expect(etagMatches('W/"abc"', 'abc')).toBe(true)
    expect(etagMatches('"abc"', 'abc')).toBe(true)
    expect(etagMatches('"x", W/"abc"', 'abc')).toBe(true)
    expect(etagMatches('*', 'abc')).toBe(true)
    expect(etagMatches('W/"abd"', 'abc')).toBe(false)
    expect(etagMatches(undefined, 'abc')).toBe(false)
  })
})
