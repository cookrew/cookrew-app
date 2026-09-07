// WHICH OF THIS MACHINE'S INTERFACES MAY BE PUBLISHED — the rule, in one pure
// place, with no `node:os` under it so both halves and the tests can call it.
//
// THE INCIDENT: FIVE ADDRESSES, FOUR BRIDGES (2026-09-08)
// ------------------------------------------------------
// A phone's path report came back with five LAN candidates for one Mac:
//
//   en0        192.168.2.40    the Wi-Fi — the only one that ever answered
//   bridge100  192.168.139.3   a container runtime's host-only network
//   bridge101  192.168.215.0   likewise, and not even a host address
//   bridge102  192.168.164.0   likewise
//   bridge103  192.168.156.0   likewise
//
// Nothing downstream could tell them apart, because the address list arrived as
// bare strings with the interface names already thrown away. So each of the
// four became a trusted name under `<deviceId>.d.cookrew.dev`, a DNS record the
// registry answered, a SAN in the self-signed certificate, a printed URL in
// `cookrew mobile`, a row in the phone's "why this path" panel, and ~800 ms of
// probing before the phone gave up on it. Four fifths of the phone's wait, and
// four fifths of the certificate's churn, were networks that exist so a VM can
// talk to its host.
//
// TWO RULES, AND ONE EXCEPTION THAT MATTERS MORE THAN BOTH
// -------------------------------------------------------
// An interface is VIRTUAL when its NAME is one of the families a hypervisor,
// a container runtime or the OS itself brings up, or when its ADDRESS is the
// subnet's own address rather than a host on it (three of the four bridges
// above). Everything else is REAL.
//
// THE EXCEPTION IS TAILSCALE. The tailnet lives on a `utun`, which is on the
// name list, with a /32 mask, which trips the address rule too — and it is the
// one address that keeps working when the phone leaves this Wi-Fi. So the
// tailnet test runs FIRST and wins outright. Which addresses are Tailscale's is
// not restated here: the caller passes `isTailnetAddress` from
// `src/main/tailscale.ts` (100.64/10 and the fd7a:115c:a1e0 ULA prefix), so
// there is one definition of the tailnet in this codebase and not two that can
// drift. It is injected rather than imported because that module reaches for
// `node:child_process`, which the renderer's project may not compile.
//
// THE NAME LIST MATCHES BY PREFIX. `veth1a2b3c` and `virbr0-nic` are real names
// with no trailing digits, so anchoring the end would miss them. The cost is
// that a future interface literally named `ap-something` would be refused; on
// macOS `apN` is the AWDL/hotspot interface and nothing else starts with `ap`.
//
// THE ESCAPE HATCH: `COOKREW_PUBLISH_INTERFACES=all` publishes every interface
// exactly as this Mac did before the rule existed. It is for the machine whose
// ONLY route to a phone is a bridge — a Mac behind a VM'd router, say. It
// overrides what is PUBLISHED, never what `interfaceKind` answers, so the
// classification stays honest and only the filter relaxes.

/** An interface as the OS reports it, reduced to what the rule needs. */
export interface LocalInterface {
  readonly name: string
  readonly address: string
  /** The interface's own mask, when the OS reported one. */
  readonly netmask?: string
}

export type InterfaceKind = 'real' | 'virtual'

export interface InterfaceRules {
  /** `isTailnetAddress` from src/main/tailscale.ts — see the note above. */
  readonly isTailnet: (address: string) => boolean
  /** `process.env`, or a stand-in. Read only for the escape hatch. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** Hypervisors, container runtimes, and the OS's own point-to-point links. */
export const VIRTUAL_INTERFACE_NAME =
  /^(bridge|vmnet|vboxnet|utun|awdl|llw|gif|stf|ap|p2p|anpi|docker|veth|virbr|lxc)\d*/

/** Ethernet and Wi-Fi: the interface most likely to answer a phone. */
const ETHERNET_NAME = /^en\d*/

/** A dotted quad, or null for anything else (IPv6 included). */
function quad(text: string): number[] | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    out.push(octet)
  }
  return out
}

const HOST_MASK = 255
const SLASH_24 = [255, 255, 255, 0]
const SLASH_32 = [255, 255, 255, 255]

/**
 * True when every host bit is zero — `192.168.215.0/24` names the network, not
 * a machine on it, and no phone will ever get an answer from it.
 *
 * The interface's own mask decides when the OS gave one, because `10.4.0.0` is
 * a perfectly good host on a /8 and the subnet address on a /16. Without a mask
 * the assumption is /24, which is what a home LAN is. A /32 is exempt: a
 * point-to-point link has no host part, so "all host bits zero" is true of
 * every address on it and would refuse the whole interface.
 */
export function isSubnetAddress(address: string, netmask?: string): boolean {
  const host = quad(address)
  if (!host) return false
  const mask = (netmask === undefined ? null : quad(netmask)) ?? SLASH_24
  if (mask.every((octet, index) => octet === SLASH_32[index])) return false
  return host.every((octet, index) => (octet & ~mask[index] & HOST_MASK) === 0)
}

/**
 * What this interface is from a phone's point of view.
 *
 * Tailscale first — see the docblock: a tailnet `utun` would fail both of the
 * rules below, and it is the address that survives leaving the house.
 */
export function interfaceKind(iface: LocalInterface, rules: InterfaceRules): InterfaceKind {
  if (rules.isTailnet(iface.address)) return 'real'
  if (VIRTUAL_INTERFACE_NAME.test(iface.name)) return 'virtual'
  if (isSubnetAddress(iface.address, iface.netmask)) return 'virtual'
  return 'real'
}

/** True when the owner has asked for the pre-rule behaviour back. */
export function publishesEveryInterface(
  env: Readonly<Record<string, string | undefined>> = {}
): boolean {
  return (env.COOKREW_PUBLISH_INTERFACES ?? '').trim().toLowerCase() === 'all'
}

/**
 * The interfaces this Mac may publish, en* first.
 *
 * Order is the whole point of the second half: the phone probes candidates in
 * the order it is given them and pays a timeout for each one that does not
 * answer, so Ethernet and Wi-Fi lead and everything else real follows in the
 * order the OS listed it.
 */
export function realInterfaces<T extends LocalInterface>(
  interfaces: readonly T[],
  rules: InterfaceRules
): T[] {
  const kept = publishesEveryInterface(rules.env)
    ? [...interfaces]
    : interfaces.filter((iface) => interfaceKind(iface, rules) === 'real')
  return [
    ...kept.filter((iface) => ETHERNET_NAME.test(iface.name)),
    ...kept.filter((iface) => !ETHERNET_NAME.test(iface.name))
  ]
}

/**
 * The published addresses: real interfaces, en* first, each address once.
 *
 * Everything the phone is ever told about this Mac starts here — the endpoint
 * list, the reach card's `lan[]`, the trusted names, the certificate's SANs and
 * what `cookrew mobile` prints — so an address that does not survive this
 * function is one no downstream half can reintroduce.
 */
export function publishedAddresses(
  interfaces: readonly LocalInterface[],
  rules: InterfaceRules
): string[] {
  return [...new Set(realInterfaces(interfaces, rules).map((iface) => iface.address))]
}
