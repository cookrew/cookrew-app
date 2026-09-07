// THE MAC THAT PUBLISHED FIVE ADDRESSES — the 2026-09-08 fixture, once.
//
// Measured from a phone's path report: one Wi-Fi address and four host-only
// bridges a container runtime and a VM host had brought up, three of them not
// even host addresses. Every half of the publish path is pinned against THIS
// list rather than a hand-copied result, so a rule that stops filtering shows
// up in the endpoint list, the reach card, the printed text and the cert SANs
// at the same time.

import { publishedAddresses, type LocalInterface } from '../../src/shared/interface-kind'
import { isTailnetAddress } from '../../src/main/tailscale'

export const FIVE_INTERFACES: readonly LocalInterface[] = [
  { name: 'en0', address: '192.168.2.40', netmask: '255.255.255.0' },
  { name: 'bridge100', address: '192.168.139.3', netmask: '255.255.255.0' },
  { name: 'bridge101', address: '192.168.215.0', netmask: '255.255.255.0' },
  { name: 'bridge102', address: '192.168.164.0', netmask: '255.255.255.0' },
  { name: 'bridge103', address: '192.168.156.0', netmask: '255.255.255.0' }
]

/** The four the phone spent ~800 ms each on and never reached. */
export const BRIDGE_ADDRESSES = [
  '192.168.139.3',
  '192.168.215.0',
  '192.168.164.0',
  '192.168.156.0'
] as const

/** The one address that answered. */
export const REAL_ADDRESS = '192.168.2.40'

/** What `publishedLocalAddresses()` would hand the rest of the app. */
export const publishedFive = (
  env?: Readonly<Record<string, string | undefined>>
): string[] => publishedAddresses(FIVE_INTERFACES, { isTailnet: isTailnetAddress, env })
