// WHICH ADDRESSES THE REACH CARD CARRIES — the one rule, in one place.
//
// The card has two slots (reach.ts · ReachCard): a capped `lan` list and a
// SINGLE `tailnet` address. The registry's DNS zone answers
// `<ip-label>.<deviceId>.d.cookrew.dev` for exactly the addresses in that card
// and NXDOMAIN for everything else (registry/src/dns-zone.ts), so anything
// this Mac prints or publishes as a trusted name must come from the same
// selection. It did not: `trustedOrigins()` spelled a name for every endpoint
// that could be a label — including the tailnet addresses the card drops — and
// those names were printed under a sentence promising "a real certificate, no
// warning" while the zone answered nothing at all.
//
// So the selection lives here and both halves call it: the card builder
// (reach.ts) and the endpoint list that decides what is printed and published
// (mobile-endpoints.ts). Two callers, one answer, no parity to maintain by
// hand — tests/reach-trusted-parity.test.ts asserts it stays that way.
//
// WHICH TAILNET ADDRESS. The MagicDNS name is the friendliest thing to print
// and the WORST thing to certify: it resolves through Tailscale's own DNS, it
// is nobody's to re-answer, and a wildcard under `<id>.d.cookrew.dev` cannot
// spell it at all. So the slot prefers what the zone can answer — the tailnet
// IPv4 (100.64/10), then the tailnet IPv6 — and falls back to the MagicDNS
// name only when there is no tailnet address, which is the card exactly as it
// was before names existed.

import { isTailnetAddress, isTailnetHost } from './tailscale'

/** More addresses than a machine with three interfaces has; the registry's cap. */
export const LAN_MAX = 8

/** The least an endpoint must be to be sorted into a slot. */
export interface SlotEndpoint {
  readonly kind: string
  readonly host: string
}

export interface ReachSlots<T> {
  readonly lan: readonly T[]
  readonly tailnet: T | null
}

/** 0 beats 1 beats 2: tailnet IPv4, tailnet IPv6, then the MagicDNS name. */
function tailnetRank(host: string): number {
  if (!isTailnetAddress(host)) return 2
  return host.includes(':') ? 1 : 0
}

/**
 * The card's slots over any endpoint shape that knows its kind and its host.
 *
 * Loopback is dropped (a phone cannot reach it), the LAN list is capped at the
 * registry's own limit rather than sent long and refused whole, and at most one
 * tailnet address survives — the best one, by the ranking above. Ties keep the
 * FIRST endpoint, which is the caller's own ordering.
 */
export function reachSlots<T extends SlotEndpoint>(endpoints: readonly T[]): ReachSlots<T> {
  const lan: T[] = []
  let tailnet: T | null = null
  for (const endpoint of endpoints) {
    if (endpoint.kind === 'loopback') continue
    // `kind` is the caller's own classification; the host check is the backstop
    // for an endpoint list that grew a new kind name.
    if (endpoint.kind === 'tailscale' || isTailnetHost(endpoint.host)) {
      if (tailnet === null || tailnetRank(endpoint.host) < tailnetRank(tailnet.host)) {
        tailnet = endpoint
      }
      continue
    }
    lan.push(endpoint)
  }
  return { lan: lan.slice(0, LAN_MAX), tailnet }
}
