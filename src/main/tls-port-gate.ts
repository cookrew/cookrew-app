// What answers a plaintext request that arrives on the HTTPS port.
//
// WHY THIS EXISTS
// ---------------
// The companion's phone URL is `https://100.68.81.64:8643`. Typed into a
// phone's address bar, the `https://` is the part people leave out — and every
// mobile browser resolves a schemeless entry to **http**. That request lands on
// the TLS listener, which cannot parse it, so Node drops the connection without
// sending a single byte. The phone shows a blank page with a stalled progress
// bar and no error at all: the most expensive possible failure, because there
// is nothing to read and nothing to search for.
//
// Verified on the wire: `printf 'GET / HTTP/1.1\r\n...' | nc <tailnet-ip> 8643`
// returns zero bytes, while the same request over TLS returns the app.
//
// So the port answers both. The first byte of a TLS connection is a record
// ContentType of 22 (handshake); a plaintext HTTP request starts with a method
// letter. One byte is enough to tell them apart, and the byte is pushed back
// before the socket is handed on, so neither server sees anything unusual.
//
// SCOPE — this routes sockets. It terminates nothing, reads no body, and holds
// no state.

import net from 'node:net'
import type http from 'node:http'

/** TLS record ContentType 22 — the first byte of every ClientHello. */
export const TLS_HANDSHAKE_BYTE = 0x16

/** True when these first bytes begin a TLS handshake rather than plain text. */
export function isTlsHandshake(first: Buffer): boolean {
  return first.length > 0 && first[0] === TLS_HANDSHAKE_BYTE
}

/**
 * How long a connection may stay silent before the gate gives up on it.
 *
 * A socket that never sends a byte is never handed to a server, so nothing
 * else would ever time it out. Port scanners open exactly these.
 */
export const SNIFF_TIMEOUT_MS = 10_000

/** Anything that accepts a socket via its 'connection' event. */
export interface SocketSink {
  emit(event: 'connection', socket: net.Socket): boolean
}

export interface TlsPortGateDeps {
  /** Gets the connection when it starts with a TLS handshake. */
  secure: SocketSink
  /** Gets it when it is plaintext — in practice, an http→https redirector. */
  plain: SocketSink
}

/**
 * A listener that sends each connection to `secure` or `plain` by its first
 * byte. Bind THIS on the HTTPS port; the TLS server itself never listens.
 */
export function createTlsPortGate(deps: TlsPortGateDeps): net.Server {
  return net.createServer((socket) => {
    // Before the handoff nothing else owns this socket, so its failures are
    // ours: a reset mid-sniff must not reach the process as an uncaught error.
    socket.on('error', () => socket.destroy())
    socket.setTimeout(SNIFF_TIMEOUT_MS, () => socket.destroy())

    const sniff = (): void => {
      const first: Buffer | null = socket.read(1)
      if (first === null) {
        // 'readable' also fires at end-of-stream, and on some streams once
        // before any data lands. Distinguish rather than assuming.
        if (socket.readableEnded) socket.destroy()
        else socket.once('readable', sniff)
        return
      }
      // Put it back first: whichever server takes over must see the request
      // from its very first byte, exactly as the client sent it.
      socket.unshift(first)
      socket.setTimeout(0)
      const sink = isTlsHandshake(first) ? deps.secure : deps.plain
      sink.emit('connection', socket)
    }
    socket.once('readable', sniff)
  })
}

/** Bracket an IPv6 literal; leave names and IPv4 alone. */
function urlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

/**
 * The bare host of a `Host:` header — `[fd7a::1]:8643` → `fd7a::1`, and
 * `100.68.81.64:8643` → `100.68.81.64`. Returns null for anything unusable.
 */
export function hostOfHeader(header: string | undefined): string | null {
  const value = (header ?? '').trim()
  if (value.length === 0) return null
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    return close > 1 ? value.slice(1, close) : null
  }
  const host = value.split(':')[0]
  return host.length > 0 ? host : null
}

/** `::ffff:100.68.81.64` → `100.68.81.64`. Dual-stack sockets report peers and */
/** local addresses in the mapped form, which is not a URL host. */
export function unmapIpv4(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  return mapped ? mapped[1] : address
}

export interface RedirectInput {
  /** The request's Host header, if it sent one. */
  hostHeader: string | undefined
  /** The request target, e.g. `/?token=…`. */
  target: string | undefined
  /** The address the client actually connected to (socket.localAddress). */
  localAddress: string | undefined
  /** Hosts this server advertises — the only Host values it will echo back. */
  advertisedHosts: readonly string[]
  port: number
}

/**
 * Where to send a plaintext request that reached the TLS port.
 *
 * The Host header is echoed only when it names a host we ourselves advertise,
 * so a forged Host cannot turn the companion into a redirector to somewhere
 * else. Otherwise the answer is built from the address the client genuinely
 * connected to, which no header can influence. Null when neither is known —
 * better a plain 400 than a redirect to a guess.
 */
export function httpsRedirectTarget(input: RedirectInput): string | null {
  const advertised = new Set(input.advertisedHosts.map((host) => host.toLowerCase()))
  const header = hostOfHeader(input.hostHeader)
  const local = input.localAddress ? unmapIpv4(input.localAddress) : null
  const host = header && advertised.has(header.toLowerCase()) ? header : local
  if (!host) return null
  return `https://${urlHost(host)}:${input.port}${input.target || '/'}`
}
