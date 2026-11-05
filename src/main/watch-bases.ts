import type { MobileEndpoint } from './mobile-endpoints'
import type { WatchBase } from './watch-routes'

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/**
 * Where a watch can reach this Mac, best first: a name a watch trusts, then
 * the addresses. A watch cannot be told to trust this Mac's own certificate,
 * so the addresses are the plain listener, as a phone on the LAN uses it.
 */
export function watchBases(endpoints: readonly MobileEndpoint[], httpPort: number): WatchBase[] {
  const named: WatchBase[] = []
  const direct: WatchBase[] = []
  for (const endpoint of endpoints) {
    if (endpoint.trustedUrl) named.push({ kind: 'name', url: new URL(endpoint.trustedUrl).origin })
    if (!IPV4.test(endpoint.host)) continue
    if (endpoint.kind === 'lan') direct.unshift({ kind: 'lan', url: `http://${endpoint.host}:${httpPort}` })
    else if (endpoint.kind === 'tailscale') direct.push({ kind: 'tailnet', url: `http://${endpoint.host}:${httpPort}` })
  }
  return [...named, ...direct]
}
