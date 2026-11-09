import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ServerResponse } from 'node:http'
import { ASSETS } from '../registry/src/assets-bundle'
import { serveAsset } from '../registry/src/assets'

/**
 * THE VENDORED TERMINAL TRAVELS GZIPPED AND IS SERVED AS ITSELF.
 *
 * It is over a quarter of a ConfigMap that cannot pass 1 MiB; inside the
 * bundle it is gzip in base64, and what a browser receives is the original
 * file byte for byte.
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

describe('a gzipped asset', () => {
  it('is stored compressed and served as the original bytes', () => {
    expect(ASSETS['xterm.js'].encoding).toBe('gzip')
    const original = readFileSync(path.join(__dirname, '..', 'registry', 'assets', 'vendor', 'xterm.js.txt'))
    expect(ASSETS['xterm.js'].body.length).toBeLessThan(original.byteLength / 2)
    const answer = served('xterm.js')
    expect(answer.status).toBe(200)
    expect(answer.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(answer.headers['content-length']).toBe(String(original.byteLength))
    expect(answer.body.equals(original)).toBe(true)
    // Twice, from the decoded copy.
    expect(served('xterm.js').body.equals(original)).toBe(true)
  })

  it('leaves the site scripts as text, their comments cut', () => {
    expect(ASSETS['site.js'].encoding).toBeUndefined()
    expect(ASSETS['auth.js'].encoding).toBeUndefined()
    expect(served('site.js').body.toString('utf8')).toBe(ASSETS['site.js'].body)
  })
})
