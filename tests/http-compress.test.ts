import { describe, expect, it } from 'vitest'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import type http from 'node:http'
import {
  acceptsGzip,
  compressible,
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
    expect(captured.headers.vary).toBe('accept-encoding')
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
