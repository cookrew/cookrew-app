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

import { isTailnetAddress, type CertHosts, type TailnetIdentity } from './tailscale'
import { MOBILE_PORT, MOBILE_HTTPS_PORT } from './mobile-ports'
import { reachSlots } from './reach-slots'
import { trustedName } from '../shared/reach-names'

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
  /**
   * REACH v2.1 — the same address spelled as a name a browser TRUSTS:
   * `https://192-168-2-40.<id>.d.cookrew.dev:8643/?token=…`.
   *
   * Present only when THREE things hold at once: a certificate is actually
   * held, the address can be a label (a MagicDNS name cannot, and resolves
   * elsewhere anyway), and the address is one the REACH CARD carries — because
   * the registry's zone answers those and NXDOMAIN for everything else. A Mac
   * with two tailnet addresses publishes one; the other keeps its bare
   * spelling rather than a name nothing resolves.
   *
   * Absent means the bare address is still the only spelling there is, exactly
   * as before names existed.
   */
  trustedUrl?: string
}

export interface EndpointInput {
  /**
   * The addresses this Mac may publish — `local-interfaces.ts ·
   * publishedLocalAddresses()`, which is the real interfaces only, en* first.
   * Bare strings by the time they arrive here, so the classification below is
   * about the ADDRESS; whether the INTERFACE was a VM bridge was decided
   * upstream, where its name still existed (five addresses, four bridges,
   * 2026-09-08).
   */
  addresses: string[]
  tailnet: TailnetIdentity | null
  /** True once the HTTPS listener is up. */
  secure: boolean
  /** Pairing token to embed, when the server has one. */
  token: string | null
  /**
   * The device id and zone to spell trusted names with — supplied ONLY when a
   * valid certificate is held for them. Absent = no name is printed, which is
   * the state of a Mac with no account, no internet, or a failed order.
   */
  trusted?: { deviceId: string; zone: string } | null
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
  return named(endpoints, input, scheme, port, query)
}

/**
 * THE TRUSTED NAMES, ON EXACTLY THE ADDRESSES THE CARD CARRIES.
 *
 * Only over HTTPS: the trusted name exists to make the certificate match, and
 * a name on a plaintext URL would be a promise about a listener that has no
 * certificate at all. And only on the card's own slots: the zone answers those
 * and nothing else, so a name spelled for anything else is a URL that fails to
 * resolve — printed, in the old code, under the sentence that promised no
 * warning.
 */
function named(
  endpoints: readonly MobileEndpoint[],
  input: EndpointInput,
  scheme: string,
  port: number,
  query: string
): MobileEndpoint[] {
  const trusted = input.trusted
  if (!input.secure || !trusted) return [...endpoints]
  const slots = reachSlots(endpoints)
  const carried = new Set<MobileEndpoint>([
    ...slots.lan,
    ...(slots.tailnet === null ? [] : [slots.tailnet])
  ])
  return endpoints.map((endpoint) => {
    if (!carried.has(endpoint)) return endpoint
    const name = trustedName(endpoint.host, trusted.deviceId, trusted.zone)
    return name === null ? endpoint : { ...endpoint, trustedUrl: `${scheme}://${name}:${port}${query}` }
  })
}

/**
 * The origins a browser will trust for this Mac — the `trusted` list on the
 * reach publish, `/api/reach.trusted`, and what `cookrew mobile` may print
 * under the "real certificate" sentence.
 *
 * Derived from the endpoints rather than computed a second way, so it cannot
 * drift from the card: an entry here is a name only because `mobileEndpoints`
 * put it on an address the card carries.
 */
export function trustedOriginsOf(endpoints: readonly MobileEndpoint[]): string[] {
  const seen = new Set<string>()
  for (const endpoint of endpoints) {
    if (endpoint.kind === 'loopback' || endpoint.trustedUrl === undefined) continue
    try {
      const url = new URL(endpoint.trustedUrl)
      seen.add(`${url.protocol}//${url.host}`)
    } catch {
      // Unspellable is not trusted.
    }
  }
  return [...seen]
}

/** IPv4 dotted-quad or IPv6 literal; anything else is a name. */
function isIpLiteral(host: string): boolean {
  return host.includes(':') || octets(host) !== null
}

/**
 * The cert hosts implied by a set of advertised endpoints.
 *
 * The cert and the URL list must be derived from ONE source, because a host in
 * one and not the other is a URL that loads with a warning the phone cannot
 * wave away — or a cert that churns for no reason.
 *
 * Feeding the cert from `os.networkInterfaces()` instead did both. It put
 * addresses we never advertise into the SAN list (169.254 link-local, the
 * 198.18 fake-ip a proxy's TUN hands out), and those come and go with every
 * VPN toggle and VM launch. Each appearance reissued the certificate, which
 * means every paired phone and the TV wall had to accept a new self-signed
 * cert again — and each reissue was another chance to write one without the
 * tailnet SAN (see certPlan).
 *
 * Loopback is excluded: ensureCert always emits localhost/127.0.0.1, and the
 * loopback endpoint only exists as the no-addresses fallback anyway.
 */
export function endpointCertHosts(endpoints: readonly MobileEndpoint[]): CertHosts {
  const ips: string[] = []
  const dnsNames: string[] = []
  for (const endpoint of endpoints) {
    if (endpoint.kind === 'loopback') continue
    if (isIpLiteral(endpoint.host)) ips.push(endpoint.host)
    else dnsNames.push(endpoint.host)
  }
  return { ips, dnsNames }
}
