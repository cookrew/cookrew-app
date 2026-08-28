// The phone's HMR socket reaches the dev server instead of dying half-open.
//
// The bug this pins is not "HMR does not work on the phone". It is that a
// DROPPED HMR socket makes Vite's client reload the page — and since the
// companion origin always answers HTTP, its restart ping always succeeds, so it
// reloads again, and again. iOS Safari reports the result as "a problem
// repeatedly occurred", with no crash report to explain it, because nothing
// crashed. Measured on the owner's device: close code 1006, wasClean false.
//
// So the assertion that matters is that the upgrade COMPLETES a handshake. A
// test that only checked "we called connect" would pass against a proxy that
// forwards a mangled head and still leaves the client reloading.

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { isViteHmrUpgrade, proxyViteHmrUpgrade } from '../src/main/hmr-proxy'

const servers: http.Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

const listen = async (server: http.Server): Promise<number> => {
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return (server.address() as AddressInfo).port
}

/** Stands in for Vite: completes any websocket upgrade it is offered. */
const fakeVite = async (
  onUpgrade?: (req: http.IncomingMessage) => void
): Promise<number> => {
  const server = http.createServer()
  server.on('upgrade', (req, socket) => {
    onUpgrade?.(req)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  })
  return listen(server)
}

/** A companion server with the fix wired the way mobile-server wires it. */
const companion = async (devUrl: string | undefined, onProduct: () => void): Promise<number> => {
  const server = http.createServer()
  server.on('upgrade', (req, socket, head) => {
    if (isViteHmrUpgrade(req) && proxyViteHmrUpgrade(devUrl, req, socket, head)) return
    onProduct()
    socket.destroy()
  })
  return listen(server)
}

/** Raw upgrade request; resolves with the first line the server sends back. */
const upgrade = (port: number, protocol: string | null, path = '/'): Promise<string> =>
  new Promise((resolve) => {
    const req = http.request({
      port,
      host: '127.0.0.1',
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...(protocol ? { 'Sec-WebSocket-Protocol': protocol } : {})
      }
    })
    req.on('upgrade', (res) => resolve(`101:${res.statusCode ?? 101}`))
    req.on('error', () => resolve('destroyed'))
    req.on('response', (res) => resolve(`response:${res.statusCode}`))
    req.end()
  })

describe('isViteHmrUpgrade — matched on subprotocol, not path', () => {
  const req = (headers: Record<string, string>): http.IncomingMessage =>
    ({ headers }) as unknown as http.IncomingMessage

  it('claims the vite-hmr subprotocol', () => {
    expect(isViteHmrUpgrade(req({ 'sec-websocket-protocol': 'vite-hmr' }))).toBe(true)
  })

  it('claims it when offered alongside others', () => {
    expect(isViteHmrUpgrade(req({ 'sec-websocket-protocol': 'foo, vite-hmr' }))).toBe(true)
  })

  it('does NOT claim an upgrade with no subprotocol', () => {
    // The interactive-browser stream. Claiming it would break live browsers —
    // and Vite dials "/" which is far too generic to route on.
    expect(isViteHmrUpgrade(req({}))).toBe(false)
  })

  it('does not claim a lookalike subprotocol', () => {
    expect(isViteHmrUpgrade(req({ 'sec-websocket-protocol': 'vite-hmr-ish' }))).toBe(false)
  })
})

describe('the phone\'s HMR socket completes a handshake', () => {
  it('proxies the upgrade through to the dev server', async () => {
    // The regression in one assertion: before the fix this socket was
    // destroyed, and a destroyed HMR socket is what reloads the page forever.
    const vitePort = await fakeVite()
    const port = await companion(`http://127.0.0.1:${vitePort}`, () => undefined)

    expect(await upgrade(port, 'vite-hmr')).toMatch(/^101/)
  })

  it('forwards the ORIGINAL path and subprotocol, not a rewritten one', async () => {
    let seen: { url?: string; proto?: string } = {}
    const vitePort = await fakeVite((req) => {
      seen = {
        url: req.url,
        proto: req.headers['sec-websocket-protocol'] as string | undefined
      }
    })
    const port = await companion(`http://127.0.0.1:${vitePort}`, () => undefined)
    await upgrade(port, 'vite-hmr', '/?token=abc')

    expect(seen.url).toBe('/?token=abc')
    expect(seen.proto).toBe('vite-hmr')
  })

  it('rewrites Host to the dev server, or Vite refuses it as cross-origin', async () => {
    let host: string | undefined
    const vitePort = await fakeVite((req) => void (host = req.headers.host))
    const port = await companion(`http://127.0.0.1:${vitePort}`, () => undefined)
    await upgrade(port, 'vite-hmr')

    expect(host).toBe(`127.0.0.1:${vitePort}`)
  })
})

describe('it declines rather than swallowing', () => {
  it('leaves a NON-hmr upgrade to the product handler', async () => {
    // The interactive-browser stream must still reach its own handler.
    let productSaw = false
    const vitePort = await fakeVite()
    const port = await companion(`http://127.0.0.1:${vitePort}`, () => void (productSaw = true))
    await upgrade(port, null, '/api/browser/abc/stream')

    expect(productSaw).toBe(true)
  })

  it('refuses when there is no dev server — a packaged build has no such path', async () => {
    let productSaw = false
    const port = await companion(undefined, () => void (productSaw = true))
    await upgrade(port, 'vite-hmr')

    // Declining must FALL THROUGH, not strand the socket.
    expect(productSaw).toBe(true)
  })

  it('refuses a non-http dev url rather than dialling it', async () => {
    let productSaw = false
    const port = await companion('file:///nope', () => void (productSaw = true))
    await upgrade(port, 'vite-hmr')

    expect(productSaw).toBe(true)
  })

  it('destroys the socket when the dev server is unreachable', async () => {
    // Half-open is the one state the client cannot survive. An unreachable Vite
    // must end the socket, not leave it hanging.
    const port = await companion('http://127.0.0.1:1', () => undefined)
    expect(await upgrade(port, 'vite-hmr')).toBe('destroyed')
  })
})
