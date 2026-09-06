/**
 * READING A NETWORK OFF A PUBLICLY-TRUSTED NAME.
 *
 * Reach v2.1 gives every Mac a real certificate for `*.<deviceId>.d.cookrew.dev`
 * and the registry writes one A/AAAA record per address it is publishing. The
 * address label is the IP with its dots (and colons) turned into dashes, so the
 * LAN address 192.168.2.40 is served at
 *
 *     https://192-168-2-40.<deviceId>.d.cookrew.dev:8643
 *
 * which a browser trusts exactly the way it trusts cookrew.dev. That is what
 * makes a live switch possible at all: a page under the relay base can open a
 * connection to it without a certificate interstitial.
 *
 * IT ALSO MAKES THE HOSTNAME UNREADABLE TO THE BADGE. Every one of these names
 * ends in `cookrew.dev`, so `classifyOrigin` — which is right about an origin
 * and only an origin — would call a LAN hop the relay. The network is in the
 * LEFTMOST LABEL and nowhere else, so it is read from there, here, once, and
 * pure: this decides which word a person sees and which address a phone will
 * send its pairing token to.
 *
 * A BARE IP IS REFUSED WHATEVER THE CARD SAYS. There is no publicly-trusted
 * certificate for `https://192.168.2.40:8643` and there never will be, so an
 * origin like that raced from a page under the base produces a certificate
 * warning or a silent failure — never a working plane. Refusing it here means
 * a Mac that puts one in `trusted` by mistake costs nothing.
 */

import { isLanHostname, isTailnetHostname } from './path-badge'

/** The two networks a direct plane can be on. Anything else is not a candidate. */
export type TrustedNetwork = 'lan' | 'tailnet'

const IPV4_LABEL = /^\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}$/

/**
 * The address a dashed label stands for, or null when it stands for nothing.
 *
 * Four numeric groups is an IPv4 literal; anything else containing a hex group
 * is treated as IPv6, because that is the only other thing the registry writes
 * a record for. `::` survives the round trip: an empty group between two
 * dashes rejoins as an empty group between two colons.
 */
export const addressFromLabel = (label: string): string | null => {
  const lower = label.toLowerCase()
  if (lower.length === 0) return null
  if (IPV4_LABEL.test(lower)) {
    const parts = lower.split('-').map(Number)
    return parts.every((part) => part >= 0 && part <= 255) ? parts.join('.') : null
  }
  if (!/^[0-9a-f-]+$/.test(lower) || !lower.includes('-')) return null
  return lower.split('-').join(':')
}

/** Is this host an IP literal rather than a name? Those can never be trusted. */
const isIpLiteral = (host: string): boolean => {
  const bare = host.replace(/^\[/, '').replace(/]$/, '')
  return bare.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(bare)
}

/**
 * Which network a trusted origin is on, or null when it is not a candidate.
 *
 * Null covers three different mistakes on purpose — a bare IP, a name whose
 * first label is not an address, and an origin that will not parse — because
 * the caller does the same thing with all three: leave it alone.
 */
export const trustedNetwork = (origin: string): TrustedNetwork | null => {
  let host: string
  try {
    host = new URL(origin).hostname
  } catch {
    return null
  }
  if (host.length === 0 || isIpLiteral(host)) return null
  const address = addressFromLabel(host.split('.')[0])
  if (address === null) return null
  if (isTailnetHostname(address)) return 'tailnet'
  return isLanHostname(address) ? 'lan' : null
}
