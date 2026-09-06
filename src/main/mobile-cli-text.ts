// What `cookrew mobile` prints. Pure text assembly so it can be tested
// without a socket server, a listener or a tailnet.

import type { EndpointKind, MobileEndpoint } from './mobile-endpoints'
import type { PairingHandout } from '../shared/account-v2'

/**
 * THE PAIRING URL, PRINTED FIRST — and the direct ones underneath, unchanged.
 *
 * The relay URL is the only address that reaches this Mac from a phone that is
 * not on this Wi-Fi, so it leads. The `?token=` URLs stay exactly where they
 * were, because two readers still need them: a phone that is not signed in to
 * cookrew.dev, and a Mac whose uplink is down.
 *
 * Only the RELAY handout is printed here. A `direct` handout is one of the
 * URLs already listed below it, and printing it twice under a heading that
 * says "from anywhere" would be a promise this Mac cannot keep.
 */
const pairingLines = (pairing: PairingHandout | null | undefined): string[] => {
  if (!pairing || pairing.via !== 'relay') return []
  return [
    '  From anywhere, through cookrew.dev',
    `    ${pairing.url}`,
    '    The token is after the # — cookrew.dev never sees it.',
    ''
  ]
}

export interface MobileHelpInput {
  endpoints: MobileEndpoint[]
  /**
   * The one URL to scan (pairing-handout.ts), when there is an account.
   * Absent or `direct` = this Mac has no account and prints what it always did.
   */
  pairing?: PairingHandout | null
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

/**
 * THE NAME, WHEN THERE IS ONE — the bare address otherwise.
 *
 * `https://192-168-2-40.<id>.d.cookrew.dev:8643/?token=…` is the SAME listener
 * as `https://192.168.2.40:8643/?token=…`; the only difference is that a
 * browser has a certificate chain for the first and shows the interstitial for
 * the second. Printing both would be two URLs for one address and an invitation
 * to scan the one that warns, so a Mac that holds a certificate prints only
 * the name — and the self-signed sentence below goes with it.
 */
const printed = (endpoint: MobileEndpoint): string => endpoint.trustedUrl ?? endpoint.url

/** True when anything printed above is a name a browser already trusts. */
const anyTrusted = (endpoints: readonly MobileEndpoint[]): boolean =>
  endpoints.some((endpoint) => endpoint.trustedUrl !== undefined)

export function renderMobileHelp(input: MobileHelpInput): string {
  const lines: string[] = [
    'Cookrew Mobile — open on your phone:',
    '',
    ...pairingLines(input.pairing)
  ]

  for (const kind of GROUP_ORDER) {
    const group = input.endpoints.filter((endpoint) => endpoint.kind === kind)
    if (group.length === 0) continue
    lines.push(`  ${group[0].label}`)
    for (const endpoint of group) lines.push(`    ${printed(endpoint)}`)
    lines.push('')
  }

  if (!input.tailnet) {
    // Not an error — most machines have no tailnet. Say what it would buy.
    lines.push('Tailscale is not running here. With it, the phone can reach Cookrew')
    lines.push('from any network instead of only this Wi-Fi.', '')
  }

  if (!input.secure) {
    lines.push(
      '⚠ HTTP only (openssl not found): 🎙️ dictation needs HTTPS, so the mic will\nbe blocked on the phone. Everything else works.'
    )
  } else if (anyTrusted(input.endpoints)) {
    // No warning to give: the URLs above carry a real certificate issued
    // through cookrew.dev, so the phone loads them like any other site.
    lines.push('These addresses have a real certificate — the phone loads them with no warning.')
  } else {
    lines.push(
      'HTTPS is self-signed: the phone warns once — tap Advanced → Proceed.\nIt is required for 🎙️ dictation, which needs a secure context.'
    )
  }

  if (input.uncovered.length > 0) {
    lines.push(
      '',
      `⚠ The certificate does not cover: ${input.uncovered.join(', ')}`,
      '  Those URLs fail with a name mismatch the phone cannot bypass.',
      '  Cookrew reissues within a minute and swaps it on the running server —',
      '  run this again to confirm, and only restart if it persists.'
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

/**
 * Confirmation text after a rotation, including the fresh URLs.
 *
 * The pairing URL leads, because the token inside it is the thing that just
 * changed — a rotation that printed only the LAN addresses would leave the
 * owner re-scanning a QR that carries the credential they just revoked.
 */
export function renderRotated(
  endpoints: MobileEndpoint[],
  pairing?: PairingHandout | null
): string {
  const relay = pairing && pairing.via === 'relay' ? [`  ${pairing.url}`] : []
  return [
    'Pairing token rotated. Every previously paired device is now unpaired',
    'and will ask to re-pair.',
    '',
    'New URLs:',
    ...relay,
    ...endpoints.map((endpoint) => `  ${printed(endpoint)}`)
  ].join('\n')
}
