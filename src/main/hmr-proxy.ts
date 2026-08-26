/**
 * Vite's HMR socket, carried across the companion origin.
 *
 * WHY THIS EXISTS
 * ---------------
 * A phone loads the renderer from the companion server, so Vite's client
 * computes its HMR socket from the PAGE origin and dials
 * wss://<companion-host>:8643/. Nothing on that server answered it: the only
 * upgrade handler belongs to the interactive-browser stream, so the socket
 * opened a TCP connection and was dropped — close code 1006, wasClean false.
 *
 * That is not a harmless dead socket. Vite's client treats an abnormal close as
 * "the dev server restarted", polls the origin, and reloads the page the moment
 * a ping succeeds (vite/dist/client/client.mjs — waitForSuccessfulPing then
 * location.reload). The companion origin always answers HTTP, so the ping
 * ALWAYS succeeds, and the page reloads, and the fresh page dials the same dead
 * socket again. An endless restart loop, which iOS Safari eventually gives up on
 * and reports as "a problem repeatedly occurred".
 *
 * The desktop window never saw it: it loads from Vite's own origin, where the
 * socket connects normally.
 *
 * WHY PROXY RATHER THAN SUPPRESS
 * ------------------------------
 * Deleting the <script src="/@vite/client"> tag does NOT stop it — Vite injects
 * `createHotContext` imports into every transformed module, so the client loads
 * through the module graph regardless. Rewriting Vite's client to neuter its
 * socket means string surgery on internals that change between versions. Piping
 * the upgrade to the dev server is the only fix that leaves both sides intact,
 * and it restores hot reload on the phone instead of merely silencing it.
 *
 * EXPOSURE
 * --------
 * None that is new. This same server already proxies Vite's entire module graph
 * (/src/, /@, /node_modules/) to the LAN un-tokened — that is what makes the
 * phone boot at all. The HMR socket carries build notifications for source a
 * LAN peer can already read. It is refused outright when the dev proxy is off,
 * so a packaged build has no such path.
 */

import { createConnection } from 'node:net'
import type http from 'node:http'
import type { Duplex } from 'node:stream'

/** Vite's client identifies itself with this subprotocol, and nothing else does. */
const VITE_HMR_PROTOCOL = 'vite-hmr'

/**
 * Is this upgrade Vite's HMR socket rather than a product one?
 *
 * Matched on the SUBPROTOCOL, not the path. Vite dials the page origin's root
 * ("/"), which is far too generic to claim, while the browser stream lives at
 * an explicit /api/browser/:id/stream. The subprotocol is the only part of the
 * request that actually says who is calling.
 */
export function isViteHmrUpgrade(request: http.IncomingMessage): boolean {
  const protocols = request.headers['sec-websocket-protocol']
  if (typeof protocols !== 'string') return false
  return protocols
    .split(',')
    .map((p) => p.trim())
    .includes(VITE_HMR_PROTOCOL)
}

/** Re-serialize the request head so the dev server sees what the phone sent. */
function requestHead(request: http.IncomingMessage, host: string): string {
  const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1`]
  const raw = request.rawHeaders
  for (let i = 0; i < raw.length; i += 2) {
    // The upstream hop is a different origin; its own Host must be used or Vite
    // rejects the upgrade as cross-origin.
    if (raw[i].toLowerCase() === 'host') continue
    lines.push(`${raw[i]}: ${raw[i + 1]}`)
  }
  lines.push(`Host: ${host}`)
  return `${lines.join('\r\n')}\r\n\r\n`
}

/**
 * Pipe one HMR upgrade to the Vite dev server.
 *
 * Returns false when it declines — no dev server configured, or an unusable
 * URL — so the caller can fall through to the product handler rather than
 * leaving a socket hanging.
 *
 * A failure to reach Vite DESTROYS the socket rather than leaving it open. The
 * client is designed for a dead socket; what it cannot survive is the half-open
 * one this module exists to remove.
 */
export function proxyViteHmrUpgrade(
  rendererDevUrl: string | undefined,
  request: http.IncomingMessage,
  socket: Duplex,
  head: Buffer
): boolean {
  if (!rendererDevUrl) return false
  let target: URL
  try {
    target = new URL(rendererDevUrl)
  } catch {
    return false
  }
  if (target.protocol !== 'http:') return false

  const port = Number(target.port || 80)
  if (!Number.isFinite(port) || port <= 0) return false

  const upstream = createConnection({ host: target.hostname, port })
  const abandon = (): void => {
    upstream.destroy()
    socket.destroy()
  }
  upstream.on('error', abandon)
  socket.on('error', abandon)

  upstream.on('connect', () => {
    upstream.write(requestHead(request, `${target.hostname}:${port}`))
    // Bytes the HTTP server already read past the head must not be dropped, or
    // the very first frame of the handshake goes missing.
    if (head.length > 0) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  return true
}
