// A BODY MUST NOT OUTLIVE ITS REQUEST. Node sends no chunked framing for GET, DELETE
// and OPTIONS by default, so bytes written after such a head would reach the keep-alive
// socket raw, and the server would read them as a second request: one with no relay
// marker, on loopback, which this Mac reads as itself.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { loopbackDialer, type BridgeResponse } from '../src/main/canvas-bridge'

const SMUGGLED = 'POST /smuggled HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\n\r\n'

let server: Server | null = null
afterEach(async () => {
  server?.closeAllConnections()
  await new Promise((resolve) => server?.close(resolve))
})

async function companion(): Promise<{ port: number; seen: Array<{ url?: string; marker?: string; body: string }> }> {
  const seen: Array<{ url?: string; marker?: string; body: string }> = []
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      seen.push({ url: request.url, marker: request.headers['x-cookrew-relay'] as string | undefined, body: Buffer.concat(chunks).toString() })
      response.writeHead(200)
      response.end('ok')
    })
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, seen }
}

const call = (port: number, method: string, headers: Record<string, string>, body: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const dialed = loopbackDialer(port)(
      { method, path: '/first', headers },
      (response: BridgeResponse) => {
        response.onData(() => undefined)
        response.onEnd(resolve)
      },
      reject
    )
    for (const piece of body) dialed.write(Buffer.from(piece))
    dialed.end()
  })

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 80))

describe('the bridge’s local request', () => {
  it.each(['GET', 'DELETE', 'OPTIONS', 'HEAD'])('%s: a body stays inside its request', async (method) => {
    const { port, seen } = await companion()
    await call(port, method, {}, [SMUGGLED])
    await settled()
    expect(seen.map((request) => request.url)).toEqual(['/first'])
    expect(seen[0].marker).toBe('1')
  })

  it('a lying content-length cannot end the request early', async () => {
    const { port, seen } = await companion()
    await call(port, 'POST', { 'content-length': '0' }, [SMUGGLED])
    await settled()
    expect(seen.map((request) => request.url)).toEqual(['/first'])
    expect(seen[0].body).toBe(SMUGGLED)
  })

  it('a transfer-encoding from outside changes nothing', async () => {
    const { port, seen } = await companion()
    await call(port, 'POST', { 'transfer-encoding': 'identity' }, [SMUGGLED])
    await settled()
    expect(seen.map((request) => request.url)).toEqual(['/first'])
  })

  it('a POST in pieces arrives whole, and one with no body stays empty', async () => {
    const { port, seen } = await companion()
    await call(port, 'POST', {}, ['one', 'two'])
    await call(port, 'POST', {}, [])
    await call(port, 'GET', {}, [])
    await settled()
    expect(seen.map((request) => request.body)).toEqual(['onetwo', '', ''])
  })
})
