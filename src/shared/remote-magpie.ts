/**
 * ANOTHER COMPUTER'S MAGPIE, WHAT COOKREW STILL SAYS ABOUT IT.
 *
 * Magpie has the provider built in (`remote-magpie`, 0.1.3935): the other
 * computer's models and routing groups arrive as `<id>/…`. Cookrew no longer
 * types the line that adds one: magpie's CLI takes a key only as an argument,
 * where every same-user process (a served seat included) can read it and the
 * shell keeps it in its history. The key is typed into Magpie's own settings
 * page instead, opened in a card (route/magpie-web.ts · routing/magpie-card.ts).
 *
 * What stays here is the one rule Cookrew still applies to an address it shows
 * (Share with my devices): plain http only where the key does not cross an open
 * network. A private address can still be a hotel's; the panel says so.
 */

export const REMOTE_MAGPIE_PRESET = 'remote-magpie'
export const MAGPIE_PORT = 3425

const LAN_SUFFIXES = ['.local', '.lan', '.home.arpa', '.ts.net']

function ipv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null
  const octets = parts.map(Number)
  return octets.every((o) => o <= 255) ? octets : null
}

/** A private range, a tailnet (100.64/10) or a LAN name. Not the same as a TRUSTED network. */
export function privateHost(host: string): boolean {
  const ip = ipv4(host)
  if (ip !== null) {
    const [a, b] = ip
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  const name = host.toLowerCase()
  return LAN_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/** A tailnet address or name: WireGuard under the http, so the key never crosses in the clear. */
export function tailnetHost(host: string): boolean {
  const ip = ipv4(host)
  if (ip !== null) return ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127
  return host.toLowerCase().endsWith('.ts.net')
}
