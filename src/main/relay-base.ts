import { RELAY_MARKER } from './canvas-bridge'

/**
 * WHERE THE COMPANION THINKS IT IS, WHEN IT IS NOT AT THE ROOT.
 *
 * Through the relay the app is served at `/relay/@user/desktop/<id>/`, not at
 * `/`. The bundle issues root-absolute `/api/...` requests, so without a base
 * every one of them leaves the prefix and lands on cookrew.dev's own routes —
 * which is exactly what pressing OPEN on /me did: the page loaded and then
 * talked to the registry instead of the Mac.
 *
 * The registry forwards the prefix as `x-cookrew-base` on every relayed
 * request. THAT HEADER IS NOT EVIDENCE BY ITSELF. Two things must hold before
 * it is believed, and neither can be arranged by anyone on the network:
 *
 *   IT ARRIVED THROUGH THE BRIDGE. `x-cookrew-relay: 1` is written by
 *   canvas-bridge over whatever the caller sent, so a request that did not
 *   come down the line cannot claim to have.
 *
 *   IT ARRIVED ON LOOPBACK. The marker is a header and headers can be typed,
 *   so the peer is checked too: the bridge dials 127.0.0.1 in this same
 *   process. A LAN client forging both is refused on the address, and a local
 *   process that could forge it can already reach everything this server has.
 *
 * AND THE SHAPE IS STILL CHECKED. The value is interpolated into the page's
 * boot script and prepended to every request the client makes, so it is
 * matched against the one path it may be rather than escaped and hoped for.
 */

/** `/relay/@handle/desktop/<uuid>`, optionally with a workspace slug after it. */
const BASE = /^\/relay\/@[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\/desktop\/[0-9a-f-]{36}(?:\/[a-z0-9][a-z0-9-]{0,62})?$/

/** `::ffff:127.0.0.1` → `127.0.0.1`; dual-stack peers arrive mapped. */
const unmap = (address: string): string => {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  return mapped ? mapped[1] : address
}

export const isLoopbackPeer = (address: string | undefined): boolean => {
  if (!address) return false
  const peer = unmap(address)
  return peer === '::1' || peer.startsWith('127.')
}

export interface RelayBaseInput {
  readonly marker: string | string[] | undefined
  readonly base: string | string[] | undefined
  readonly remoteAddress: string | undefined
}

/**
 * The prefix this request was served under, or '' — which is the truth for
 * every client that is not on the far end of a relay line.
 */
export const relayBaseOf = (input: RelayBaseInput): string => {
  if (input.marker !== '1') return ''
  if (!isLoopbackPeer(input.remoteAddress)) return ''
  const base = typeof input.base === 'string' ? input.base.replace(/\/+$/, '') : ''
  return BASE.test(base) ? base : ''
}

/** The header a relay puts the prefix in. Read here and nowhere else. */
export const RELAY_BASE_HEADER = 'x-cookrew-base'

export { RELAY_MARKER }
