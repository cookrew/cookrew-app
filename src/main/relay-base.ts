import { RELAY_MARKER } from './canvas-bridge'

/**
 * WHO IS ON THE OTHER END OF THIS SOCKET: THIS MACHINE, OR SOMEBODY ELSE.
 *
 * The one fact every rule about the relay's bridge is built on. A request the
 * bridge carried in says so in a header (`x-cookrew-relay: 1`, written by
 * canvas-bridge over whatever the caller sent), and a header can be typed, so
 * the peer is checked too: the bridge dials 127.0.0.1 in this same process. A
 * LAN client forging the marker is refused on the address, and a local
 * process that could forge it can already reach everything this server has.
 *
 * THE FILE'S NAME IS OLDER THAN ITS CONTENTS. Until 0.6.0 a machine's page
 * was served through the relay under a prefix, and this file decided when the
 * prefix a request named was believed. The relay carries no page now
 * (shared/machine-relay.ts), a machine serves its page at its own root and
 * nowhere else, and nothing on a machine reads a base from a request. What is
 * left is the loopback rule the other readers of the marker share.
 */

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

export { RELAY_MARKER }
