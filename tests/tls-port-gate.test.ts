import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ensureCert, sansOf } from '../src/main/cert'
import {
  createTlsPortGate,
  hostOfHeader,
  httpsRedirectTarget,
  isTlsHandshake,
  unmapIpv4
} from '../src/main/tls-port-gate'

/**
 * The bug this file exists for, observed on a phone over 5G:
 *
 *   address bar: 100.68.81.64:8643   →   blank page, stalled progress bar
 *
 * Every mobile browser resolves a schemeless entry to http://. That request
 * reached the TLS listener, which answered with NOTHING — verified with
 * `printf 'GET / HTTP/1.1\r\n\r\n' | nc <ip> 8643` returning zero bytes. A
 * blank page is unsearchable and looks exactly like the desktop being down.
 */

const ADVERTISED = ['100.68.81.64', 'workbench.example-tailnet.ts.net', '192.168.2.13']

describe('isTlsHandshake — one byte separates the two protocols', () => {
  it('recognises a ClientHello and a plaintext request line', () => {
    expect(isTlsHandshake(Buffer.from([0x16]))).toBe(true)
    expect(isTlsHandshake(Buffer.from('G'))).toBe(false)
    expect(isTlsHandshake(Buffer.from('P'))).toBe(false)
    expect(isTlsHandshake(Buffer.alloc(0))).toBe(false)
  })
})

describe('hostOfHeader', () => {
  it('drops the port from IPv4, IPv6 and named authorities', () => {
    expect(hostOfHeader('100.68.81.64:8643')).toBe('100.68.81.64')
    expect(hostOfHeader('[fd7a:115c:a1e0::1]:8643')).toBe('fd7a:115c:a1e0::1')
    expect(hostOfHeader('workbench.example-tailnet.ts.net')).toBe(
      'workbench.example-tailnet.ts.net'
    )
  })

  it('returns null for absent or malformed headers', () => {
    expect(hostOfHeader(undefined)).toBeNull()
    expect(hostOfHeader('  ')).toBeNull()
    expect(hostOfHeader('[unclosed')).toBeNull()
  })
})

describe('unmapIpv4 — dual-stack sockets report mapped peers', () => {
  it('reduces a mapped address to the IPv4 host a URL can use', () => {
    expect(unmapIpv4('::ffff:100.68.81.64')).toBe('100.68.81.64')
    expect(unmapIpv4('100.68.81.64')).toBe('100.68.81.64')
    expect(unmapIpv4('fd7a:115c:a1e0::1')).toBe('fd7a:115c:a1e0::1')
  })
})

describe('httpsRedirectTarget', () => {
  it('keeps the path and the pairing token', () => {
    // The whole point: a mistyped scheme must cost a round trip, not a
    // re-pair. Dropping ?token= would strand the phone on the re-pair screen.
    expect(
      httpsRedirectTarget({
        hostHeader: '100.68.81.64:8643',
        target: '/?token=abc123',
        localAddress: '::ffff:100.68.81.64',
        advertisedHosts: ADVERTISED,
        port: 8643
      })
    ).toBe('https://100.68.81.64:8643/?token=abc123')
  })

  it('echoes a MagicDNS name we advertise rather than swapping in the IP', () => {
    expect(
      httpsRedirectTarget({
        hostHeader: 'workbench.example-tailnet.ts.net:8643',
        target: '/',
        localAddress: '::ffff:100.68.81.64',
        advertisedHosts: ADVERTISED,
        port: 8643
      })
    ).toBe('https://workbench.example-tailnet.ts.net:8643/')
  })

  it('ignores a Host header we do not advertise', () => {
    // Otherwise the companion is an open redirector: anyone who can make a
    // phone hit this port could bounce it to a host of their choosing.
    expect(
      httpsRedirectTarget({
        hostHeader: 'evil.example.com',
        target: '/steal',
        localAddress: '::ffff:100.68.81.64',
        advertisedHosts: ADVERTISED,
        port: 8643
      })
    ).toBe('https://100.68.81.64:8643/steal')
  })

  it('brackets an IPv6 local address', () => {
    expect(
      httpsRedirectTarget({
        hostHeader: undefined,
        target: '/',
        localAddress: 'fd7a:115c:a1e0::5401:51a4',
        advertisedHosts: ADVERTISED,
        port: 8643
      })
    ).toBe('https://[fd7a:115c:a1e0::5401:51a4]:8643/')
  })

  it('refuses to guess when neither the header nor the socket says', () => {
    expect(
      httpsRedirectTarget({
        hostHeader: undefined,
        target: '/',
        localAddress: undefined,
        advertisedHosts: ADVERTISED,
        port: 8643
      })
    ).toBeNull()
  })

  it('defaults an empty request target to the root', () => {
    expect(
      httpsRedirectTarget({
        hostHeader: '192.168.2.13:8643',
        target: '',
        localAddress: '192.168.2.13',
        advertisedHosts: ADVERTISED,
        port: 8643
      })
    ).toBe('https://192.168.2.13:8643/')
  })
})

/**
 * End to end over real sockets with a real certificate — the only way to
 * prove the sniff, the unshift and the handoff actually work. A unit test of
 * the byte comparison would have passed against the broken server too.
 */
describe('createTlsPortGate on one real port', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const startGate = async (): Promise<{ port: number; certHosts: string[] }> => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-gate-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const cert = ensureCert({ ips: ['127.0.0.1'], dnsNames: ['localhost'] }, dir)
    if (!cert) throw new Error('openssl unavailable')

    const secure = https.createServer({ key: cert.key, cert: cert.cert }, (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('the app')
    })
    const plain = http.createServer((request, response) => {
      const location = httpsRedirectTarget({
        hostHeader: request.headers.host,
        target: request.url,
        localAddress: request.socket.localAddress,
        advertisedHosts: ['127.0.0.1', 'localhost'],
        port: Number((gate.address() as net.AddressInfo).port)
      })
      response.writeHead(307, { location: location ?? '/' })
      response.end()
    })
    const gate = createTlsPortGate({ secure, plain })
    cleanup.push(() => gate.close())
    await new Promise<void>((resolve) => gate.listen(0, '127.0.0.1', resolve))
    return {
      port: (gate.address() as net.AddressInfo).port,
      certHosts: sansOf(new X509Certificate(cert.cert).subjectAltName)
    }
  }

  it('answers a plaintext request with a redirect instead of nothing at all', async () => {
    const { port } = await startGate()
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(`GET /?token=abc123 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)
      })
      let text = ''
      socket.on('data', (chunk) => {
        text += chunk.toString('utf8')
        if (text.includes('\r\n\r\n')) {
          socket.destroy()
          resolve(text)
        }
      })
      socket.setTimeout(5000, () => {
        socket.destroy()
        // Before the gate this is what happened: zero bytes, then a hang.
        reject(new Error(`no response to plaintext on the TLS port (got ${text.length} bytes)`))
      })
      socket.on('error', reject)
    })
    expect(raw).toContain('307')
    // The token has to survive, or the redirect lands the phone unpaired.
    expect(raw).toContain(`location: https://127.0.0.1:${port}/?token=abc123`)
  })

  it('still serves the app over TLS on the same port', async () => {
    const { port } = await startGate()
    const body = await new Promise<string>((resolve, reject) => {
      const request = https.request(
        { host: '127.0.0.1', port, path: '/', rejectUnauthorized: false },
        (response) => {
          let text = ''
          response.on('data', (chunk) => (text += chunk))
          response.on('end', () => resolve(text))
        }
      )
      request.on('error', reject)
      request.end()
    })
    expect(body).toBe('the app')
  })

  it('drops a connection that never sends anything', async () => {
    const { port } = await startGate()
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1')
      // No bytes ever written: nothing owns this socket, so the gate itself
      // must end it rather than leaking a descriptor per port scan.
      socket.on('close', () => resolve())
      socket.on('error', () => resolve())
      socket.setTimeout(5000, () => {
        socket.destroy()
        reject(new Error('the gate held a silent connection open'))
      })
      setTimeout(() => socket.end(), 50)
    })
  })
})
