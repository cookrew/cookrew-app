import type http from 'node:http'
import type { TLSSocket } from 'node:tls'
import { RELAY_MARKER } from './canvas-bridge'

/**
 * THE PAIRING CEREMONY DOES NOT HAPPEN IN THE CLEAR.
 *
 * The companion serves the whole app on two listeners: TLS on 8643 and plain
 * HTTP on 8639. The plaintext one exists so a phone that typed the address
 * without a scheme gets a redirect instead of a blank page, and so the relay
 * bridge can reach this process over loopback without a certificate dance.
 *
 * It was also answering the entire v2 admission. `?open=&key=&device=` went
 * over the LAN in the clear, and the 303 back carried the companion's session
 * token in a URL — so anyone on the same Wi-Fi could read a working credential
 * off the wire, and (before jtis were burned) replay the admission itself for
 * the rest of the token's ten minutes. Both halves of the ceremony are secrets
 * in transit and neither belongs on a plaintext port.
 *
 * THE ONE EXCEPTION IS THE RELAY BRIDGE. canvas-bridge dials 127.0.0.1:8639
 * from inside this same process and marks the request; that hop never leaves
 * the machine, and the TLS that matters is the relay's own, further out. It is
 * recognised by BOTH the marker and a loopback peer — the marker alone is a
 * header, and a header is something a caller writes.
 */

export type PlaintextVerdict =
  /** TLS, or the loopback relay bridge: carry on. */
  | 'allow'
  /** Plaintext on the LAN, with TLS up: send them to the secure address. */
  | 'redirect'
  /** Plaintext on the LAN with no TLS at all: there is nowhere to send them. */
  | 'refuse'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Did this request arrive over TLS? */
export const isSecureRequest = (request: Pick<http.IncomingMessage, 'socket'>): boolean =>
  (request.socket as TLSSocket | undefined)?.encrypted === true

/**
 * The relay bridge's own hop: marked AND from this machine. Either alone is
 * not enough — the marker is a header anyone can send, and loopback alone is
 * every other local client, including the desktop's own renderer.
 */
export const isRelayBridge = (
  request: Pick<http.IncomingMessage, 'headers' | 'socket'>
): boolean => {
  if (request.headers[RELAY_MARKER] === undefined) return false
  const peer = request.socket?.remoteAddress
  return typeof peer === 'string' && LOOPBACK.has(peer)
}

export const plaintextVerdict = (
  request: Pick<http.IncomingMessage, 'headers' | 'socket'>,
  httpsReady: boolean
): PlaintextVerdict => {
  if (isSecureRequest(request) || isRelayBridge(request)) return 'allow'
  return httpsReady ? 'redirect' : 'refuse'
}
