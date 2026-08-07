// Where the phone can actually reach the companion, and what each address is.
//
// `cookrew mobile` used to print every non-internal IPv4 the machine reports.
// On a developer's Mac that is seven lines — VM bridges, a proxy's fake-ip
// address, a link-local autoconf address, the tailnet, and somewhere in there
// the one Wi-Fi address that works. An unlabelled list of seven URLs where six
// are dead is worse than a list of two that say what they are.
//
// This module classifies, de-duplicates and ORDERS them; it decides nothing
// about auth and opens no sockets.

import { isTailnetAddress, type TailnetIdentity } from './tailscale'
import { MOBILE_PORT, MOBILE_HTTPS_PORT } from './mobile-ports'

export type EndpointKind = 'tailscale' | 'lan' | 'other' | 'loopback'

/** 'unusable' never becomes an endpoint — it is filtered out. */
export type HostClass = EndpointKind | 'unusable'

export interface MobileEndpoint {
  /** Full URL including the pairing token when there is one. */
  url: string
  kind: EndpointKind
  /** Bare host (unbracketed, even for IPv6) for cert/SAN purposes. */
  host: string
  /** One line telling the user when this address is the right one. */
  label: string
}

export interface EndpointInput {
  /** Non-internal addresses from os.networkInterfaces(). */
  addresses: string[]
  tailnet: TailnetIdentity | null
  /** True once the HTTPS listener is up. */
  secure: boolean
  /** Pairing token to embed, when the server has one. */
  token: string | null
}

const LABELS: Record<EndpointKind, string> = {
  // The phone needs Tailscale installed and signed into the same tailnet —
  // say so, because otherwise this line looks like a broken URL.
  tailscale: 'Tailscale — works anywhere, if the phone is on the same tailnet',
  lan: 'Same Wi-Fi as this Mac',
  other: 'Other interface — may not be reachable',
  loopback: 'This Mac only'
}

function octets(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const parsed = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  return parsed.some((n) => Number.isNaN(n) || n > 255) ? null : parsed
}

/**
 * What kind of address this is from a phone's point of view.
 *
 * 'unusable' covers two families that show up on every developer machine and
 * can never serve a phone: 169.254/16 (link-local autoconfiguration — no
 * router will forward it) and 198.18/15 (the benchmarking range, which proxy
 * tools hand out as fake-ip).
 */
export function classifyHost(address: string): HostClass {
  if (isTailnetAddress(address)) return 'tailscale'
  if (address.includes(':')) return 'other'
  const parts = octets(address)
  if (!parts) return 'unusable'
  const [a, b] = parts
  if (a === 127) return 'loopback'
  if (a === 169 && b === 254) return 'unusable'
  if (a === 198 && (b === 18 || b === 19)) return 'unusable'
  if (a === 10) return 'lan'
  if (a === 172 && b >= 16 && b <= 31) return 'lan'
  if (a === 192 && b === 168) return 'lan'
  return 'other'
}

/** IPv6 literals need brackets inside a URL; names and IPv4 must not have them. */
function urlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

/**
 * Endpoints in the order a user should try them: the tailnet first (it is the
 * only address that survives leaving the house), then the LAN, then anything
 * else, then loopback as a last resort.
 */
export function mobileEndpoints(input: EndpointInput): MobileEndpoint[] {
  const scheme = input.secure ? 'https' : 'http'
  const port = input.secure ? MOBILE_HTTPS_PORT : MOBILE_PORT
  const query = input.token ? `/?token=${input.token}` : ''

  const seen = new Set<string>()
  const endpoints: MobileEndpoint[] = []
  const add = (host: string, kind: EndpointKind): void => {
    if (seen.has(host)) return
    seen.add(host)
    endpoints.push({
      url: `${scheme}://${urlHost(host)}:${port}${query}`,
      kind,
      host,
      label: LABELS[kind]
    })
  }

  // MagicDNS name before the raw tailnet IP: it is stable across re-auth and
  // it is the name a publicly-trusted Tailscale cert would be issued for.
  if (input.tailnet?.magicDnsName) add(input.tailnet.magicDnsName, 'tailscale')
  for (const ip of input.tailnet?.ips ?? []) add(ip, 'tailscale')

  const rest: Record<'lan' | 'other', string[]> = { lan: [], other: [] }
  for (const address of input.addresses) {
    const kind = classifyHost(address)
    if (kind === 'lan' || kind === 'other') rest[kind].push(address)
    // 'tailscale' addresses are already covered above (the tailnet interface
    // is also a local interface); 'unusable' and 'loopback' are dropped.
  }
  for (const address of rest.lan) add(address, 'lan')
  for (const address of rest.other) add(address, 'other')

  if (endpoints.length === 0) add('localhost', 'loopback')
  return endpoints
}
