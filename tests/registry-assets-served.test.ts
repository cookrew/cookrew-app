import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ServerResponse } from 'node:http'
import { ASSETS } from '../registry/src/assets-bundle'
import { serveAsset } from '../registry/src/assets'

/**
 * WHAT TRAVELS IN THE BUNDLE IS SERVED AS ITSELF.
 *
 * A font is base64 inside the bundle, and what a browser receives is the
 * original file byte for byte; a script is text, its comments cut. (The
 * vendored terminal, the one asset that travelled gzipped, went with the web
 * line in 0.6.0.)
 */

function served(name: string): { status: number; headers: Record<string, string>; body: Buffer } {
  let status = 0
  let headers: Record<string, string> = {}
  let body = Buffer.alloc(0)
  const response = {
    writeHead: (code: number, h: Record<string, string>) => {
      status = code
      headers = h
    },
    end: (payload?: Uint8Array) => {
      body = Buffer.from(payload ?? new Uint8Array())
    }
  } as unknown as ServerResponse
  expect(serveAsset(response, name)).toBe(true)
  return { status, headers, body }
}

describe('a bundled asset', () => {
  it('a font is stored as base64 and served as the original bytes', () => {
    expect(ASSETS['inter.woff2'].encoding).toBe('base64')
    const original = readFileSync(path.join(__dirname, '..', 'registry', 'assets', 'fonts', 'inter.woff2'))
    const answer = served('inter.woff2')
    expect(answer.status).toBe(200)
    expect(answer.headers['content-type']).toBe('font/woff2')
    expect(answer.headers['content-length']).toBe(String(original.byteLength))
    expect(answer.body.equals(original)).toBe(true)
    // Twice, from the decoded copy.
    expect(served('inter.woff2').body.equals(original)).toBe(true)
  })

  it('leaves the site scripts as text, their comments cut', () => {
    expect(ASSETS['site.js'].encoding).toBeUndefined()
    expect(ASSETS['auth.js'].encoding).toBeUndefined()
    expect(served('site.js').body.toString('utf8')).toBe(ASSETS['site.js'].body)
  })
})
