// What `cookrew mobile` prints. Pure text assembly so it can be tested
// without a socket server, a listener or a tailnet.

import type { EndpointKind, MobileEndpoint } from './mobile-endpoints'

export interface MobileHelpInput {
  endpoints: MobileEndpoint[]
  /** True once the HTTPS listener is up (self-signed). */
  secure: boolean
  /** Endpoint hosts the running cert does not cover (name-mismatch on load). */
  uncovered: string[]
  /** True when Tailscale is up on this machine. */
  tailnet: boolean
  /**
   * Proxy bypass entries the user must add before a browser on THIS Mac can
   * load the tailnet URLs. Absent or empty means there is nothing to warn
   * about — no proxy, or the tailnet is already exempt.
   */
  proxyBypassGaps?: string[]
}

/** Group order matches mobileEndpoints(): most-reachable first. */
const GROUP_ORDER: EndpointKind[] = ['tailscale', 'lan', 'other', 'loopback']

export function renderMobileHelp(input: MobileHelpInput): string {
  const lines: string[] = ['Cookrew Mobile — open on your phone:', '']

  for (const kind of GROUP_ORDER) {
    const group = input.endpoints.filter((endpoint) => endpoint.kind === kind)
    if (group.length === 0) continue
    lines.push(`  ${group[0].label}`)
    for (const endpoint of group) lines.push(`    ${endpoint.url}`)
    lines.push('')
  }

  if (!input.tailnet) {
    // Not an error — most machines have no tailnet. Say what it would buy.
    lines.push('Tailscale is not running here. With it, the phone can reach Cookrew')
    lines.push('from any network instead of only this Wi-Fi.', '')
  }

  lines.push(
    input.secure
      ? 'HTTPS is self-signed: the phone warns once — tap Advanced → Proceed.\nIt is required for 🎙️ dictation, which needs a secure context.'
      : '⚠ HTTP only (openssl not found): 🎙️ dictation needs HTTPS, so the mic will\nbe blocked on the phone. Everything else works.'
  )

  if (input.uncovered.length > 0) {
    lines.push(
      '',
      `⚠ The certificate does not cover: ${input.uncovered.join(', ')}`,
      '  Those URLs fail with a name mismatch the phone cannot bypass.',
      '  Restart Cookrew to reissue the certificate with them included.'
    )
  }

  // Gate on an ADVERTISED tailnet endpoint, not merely on Tailscale running:
  // a proxy gap only matters if we actually printed a URL it will eat.
  const gaps = input.proxyBypassGaps ?? []
  if (gaps.length > 0 && input.endpoints.some((endpoint) => endpoint.kind === 'tailscale')) {
    lines.push(
      '',
      '⚠ A system proxy here does not exempt the tailnet, so a browser ON THIS MAC',
      '  fails the Tailscale URLs above with ERR_CONNECTION_CLOSED. Your phone is',
      '  unaffected — this is the proxy, not Cookrew.',
      `  Add to the proxy's bypass list: ${gaps.join(', ')}`
    )
  }

  lines.push(
    '',
    'The pairing token is in the URLs above and survives restarts.',
    'Rotate it with `cookrew mobile --rotate` — that unpairs every device.'
  )
  return lines.join('\n')
}

/** Confirmation text after a rotation, including the fresh URLs. */
export function renderRotated(endpoints: MobileEndpoint[]): string {
  return [
    'Pairing token rotated. Every previously paired device is now unpaired',
    'and will ask to re-pair.',
    '',
    'New URLs:',
    ...endpoints.map((endpoint) => `  ${endpoint.url}`)
  ].join('\n')
}
