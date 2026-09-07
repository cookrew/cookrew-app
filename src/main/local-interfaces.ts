// THE ONE PLACE THIS MAC ASKS THE OS WHERE IT LIVES.
//
// Five addresses, four bridges (2026-09-08). `os.networkInterfaces()` was read
// in two places and both threw the interface NAME away on the first line, which
// is the only thing that distinguishes en0 from bridge103. Everything after
// that — the endpoint list, the reach card, the trusted names, the certificate
// SANs, `cookrew mobile` — was working from a list that could not be filtered
// because the evidence had already been discarded.
//
// So the name and the netmask are carried as far as the rule that needs them
// (shared/interface-kind.ts) and no further; callers get the addresses that
// survived it, in the order a phone should probe them.

import { networkInterfaces } from 'node:os'
import { isTailnetAddress } from './tailscale'
import { publishedAddresses, type LocalInterface } from '../shared/interface-kind'

/**
 * Every non-internal IPv4 interface, with the name and mask still attached.
 *
 * IPv4 only, as before: the phone reaches this Mac over v4 on a LAN, and the
 * one v6 address that matters — the tailnet's — arrives from Tailscale's own
 * status rather than from here.
 */
export function localInterfaces(): LocalInterface[] {
  const found: LocalInterface[] = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue
      found.push({ name, address: net.address, netmask: net.netmask })
    }
  }
  return found
}

/**
 * The addresses this Mac may publish: real interfaces only, Ethernet and Wi-Fi
 * first. The escape hatch is read from the live environment on every call, so
 * it takes effect on the next publish rather than only at boot.
 */
export function publishedLocalAddresses(): string[] {
  return publishedAddresses(localInterfaces(), {
    isTailnet: isTailnetAddress,
    env: process.env
  })
}
