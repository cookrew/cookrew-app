import type { MobileEndpoint } from './mobile-endpoints'

/**
 * EVERY HOST THIS MAC ANSWERS FOR — the allow-list the Host gate compares against.
 *
 * DERIVED FROM THE ENDPOINTS, NEVER COMPUTED A SECOND WAY. The addresses this
 * server advertises, the certificate's SAN list and the origins it answers
 * cross-origin for all come from `mobileEndpoints()`; a host allow-list built
 * from `os.networkInterfaces()` instead would drift from it in both
 * directions — an advertised address it refuses (a phone that cannot connect
 * at all, blamed on the Wi-Fi) or an unadvertised one it accepts (a hole with
 * nothing pointing at it).
 *
 * BOTH SPELLINGS OF THE SAME LISTENER. The bare address AND, once a chain is
 * held, the trusted name `192-168-2-40.<deviceId>.d.cookrew.dev` — reach v2.1
 * moves the phone's data plane onto the name while the page stays at
 * cookrew.dev, so refusing the name would refuse exactly the path the
 * certificate exists to open.
 *
 * THE LOOPBACK LITERALS ARE CONSTANTS, NOT ADDRESSES. `localhost`, `127.0.0.1`
 * and `::1` are here rather than in the endpoint list because the endpoint
 * list drops loopback (a phone cannot reach it) while the desktop's own
 * renderer, the CLI and the relay bridge all dial it every second. They are
 * also the one part of this set that cannot go stale, which is what makes them
 * the safe floor when the live read fails (mobile-server · companionHosts).
 *
 * NOTE WHAT LOOPBACK DOES NOT BUY. Being on this list makes `localhost` an
 * ANSWERABLE name; it is not authentication and it is not a rebinding
 * exemption. A rebound page runs in the victim's own browser, so its peer
 * address is loopback too — which is precisely why the pairing token gates the
 * routes and the socket underneath this gate.
 */
export const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1']

/** The bare host of a URL, or null when it is not one. IPv6 arrives bracketed. */
function hostOfUrl(raw: string): string | null {
  try {
    const { hostname } = new URL(raw)
    return hostname.length === 0 ? null : hostname.replace(/^\[|\]$/g, '')
  } catch {
    return null
  }
}

/**
 * The hosts implied by a set of advertised endpoints, plus the loopback
 * literals. De-duplicated, lower-cased, never empty.
 */
export function companionHostsOf(endpoints: readonly MobileEndpoint[]): string[] {
  const hosts = new Set<string>(LOOPBACK_HOSTS)
  for (const endpoint of endpoints) {
    if (endpoint.host.length > 0) hosts.add(endpoint.host.toLowerCase())
    // The URLs are the authority on how the host is spelled in a request —
    // and the trusted name exists nowhere else on the endpoint.
    for (const raw of [endpoint.url, endpoint.trustedUrl]) {
      if (raw === undefined) continue
      const host = hostOfUrl(raw)
      if (host !== null) hosts.add(host.toLowerCase())
    }
  }
  return [...hosts]
}
