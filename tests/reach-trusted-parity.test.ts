// THE INVARIANT THAT FAILED: A TRUSTED NAME THE ZONE CANNOT ANSWER.
//
// Reach v2.1 has two halves that must agree about one set of addresses. The
// registry's authoritative DNS answers `<ip-label>.<deviceId>.d.cookrew.dev`
// ONLY for an address present in this Mac's signed reach card — everything
// else is NXDOMAIN, deliberately, because without that gate the zone is a
// public sslip.io. Meanwhile this Mac decides what to PRINT and what to
// publish as `trusted`.
//
// The two halves disagreed. The card keeps ONE tailnet address and used to
// keep the MagicDNS name; `trustedOrigins()` spelled a name for EVERY endpoint
// that could be a label — so `cookrew mobile` and `/api/reach.trusted`
// advertised `100-68-x-x.<id>.d.cookrew.dev` and `fd7a-…--….<id>.d.cookrew.dev`
// under a sentence promising "a real certificate — no warning", and the zone
// answered nothing at all for either.
//
// One property, asserted over the realistic shapes: every origin in `trusted`
// is an address the card carries. Nothing else in this file matters.

import { describe, expect, it } from 'vitest'
import { mobileEndpoints, trustedOriginsOf, type MobileEndpoint } from '../src/main/mobile-endpoints'
import { reachCard } from '../src/main/reach'
import { addressFromTrustedName, addressText, parseAddress, DEFAULT_NAME_ZONE } from '../src/shared/reach-names'
import type { TailnetIdentity } from '../src/main/tailscale'

const MAC = '3f2b9c14-7a55-4d2e-9d0f-1c8e6b4a7f30'
const ZONE = DEFAULT_NAME_ZONE
const FP = 'a'.repeat(64)

const tailnet = (ips: string[], magicDnsName: string | null): TailnetIdentity => ({
  ips,
  magicDnsName,
  magicDnsEnabled: magicDnsName !== null,
  certDomains: []
})

const listing = (addresses: string[], net: TailnetIdentity | null): MobileEndpoint[] =>
  mobileEndpoints({
    addresses,
    tailnet: net,
    secure: true,
    token: 'tok',
    trusted: { deviceId: MAC, zone: ZONE }
  })

/** Every address the card names, spelled the one way both halves spell them. */
const cardAddresses = (endpoints: readonly MobileEndpoint[]): string[] => {
  const card = reachCard({ deviceId: MAC, endpoints, certFp: FP, relay: false, at: 1_800_000_000_000 })
  const urls = [...card.lan.map((a) => a.url), ...(card.tailnet === null ? [] : [card.tailnet.url])]
  return urls.map((url) => {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
    const ip = parseAddress(host)
    return ip === null ? host : addressText(ip)
  })
}

/** The address a trusted origin SPELLS, or null when it spells none. */
const addressOf = (origin: string): string | null =>
  addressFromTrustedName(new URL(origin).hostname)

const CASES: { name: string; addresses: string[]; tailnet: TailnetIdentity | null }[] = [
  {
    name: 'a laptop on Wi-Fi with a full tailnet — the live shape',
    addresses: ['192.168.2.13', '100.68.9.4', 'fd7a:115c:a1e0::4d01'],
    tailnet: tailnet(['100.68.9.4', 'fd7a:115c:a1e0::4d01'], 'workbench.example-tailnet.ts.net')
  },
  {
    name: 'a tailnet that reports only a MagicDNS name',
    addresses: ['192.168.2.13'],
    tailnet: tailnet([], 'workbench.example-tailnet.ts.net')
  },
  {
    name: 'a tailnet with IPv6 only',
    addresses: ['10.0.0.7'],
    tailnet: tailnet(['fd7a:115c:a1e0::4d01'], 'workbench.example-tailnet.ts.net')
  },
  {
    name: 'no tailnet at all',
    addresses: ['192.168.2.13', '172.16.4.9'],
    tailnet: null
  },
  {
    name: 'a developer Mac with nine interfaces — more than the card will carry',
    addresses: [
      '192.168.2.13',
      '10.0.0.7',
      '10.0.0.8',
      '10.0.0.9',
      '10.0.0.10',
      '10.0.0.11',
      '10.0.0.12',
      '10.0.0.13',
      '10.0.0.14',
      '172.16.4.9'
    ],
    tailnet: tailnet(['100.68.9.4'], 'workbench.example-tailnet.ts.net')
  }
]

describe('every trusted origin is an address the reach card carries', () => {
  for (const shape of CASES) {
    it(shape.name, () => {
      const endpoints = listing(shape.addresses, shape.tailnet)
      const carried = cardAddresses(endpoints)
      const trusted = trustedOriginsOf(endpoints)
      for (const origin of trusted) {
        const address = addressOf(origin)
        // A trusted name that spells no address at all is already broken: the
        // zone reads the first label as an address or answers NXDOMAIN.
        expect(address).not.toBeNull()
        expect(carried).toContain(address)
      }
      // And the other way, so "trust nothing" cannot pass this file: every
      // address the card carries that CAN be a name has one.
      for (const address of carried) {
        if (parseAddress(address) === null) continue
        expect(trusted.map(addressOf)).toContain(address)
      }
    })
  }

  it('never spells the MagicDNS name, which the wildcard cannot cover', () => {
    const endpoints = listing(['192.168.2.13'], tailnet(['100.68.9.4'], 'workbench.example-tailnet.ts.net'))
    const magic = endpoints.find((endpoint) => endpoint.host.endsWith('.ts.net'))
    expect(magic).toBeDefined()
    // Still printed as a direct URL — it is the address that survives leaving
    // the house — but never as a name this Mac claims a certificate for.
    expect(magic?.trustedUrl).toBeUndefined()
    expect(trustedOriginsOf(endpoints).join(' ')).not.toContain('ts.net')
  })

  it('leaves the SECOND tailnet address bare — the card keeps only one', () => {
    const endpoints = listing([], tailnet(['100.68.9.4', 'fd7a:115c:a1e0::4d01'], null))
    const trusted = trustedOriginsOf(endpoints)
    expect(trusted).toEqual([`https://100-68-9-4.${MAC}.${ZONE}:8643`])
    // This is the exact name the phone was handed and the zone refused.
    expect(trusted.join(' ')).not.toContain('fd7a')
  })

  it('trusts nothing at all when no certificate is held', () => {
    const endpoints = mobileEndpoints({
      addresses: ['192.168.2.13'],
      tailnet: tailnet(['100.68.9.4'], 'workbench.example-tailnet.ts.net'),
      secure: true,
      token: 'tok',
      trusted: null
    })
    expect(trustedOriginsOf(endpoints)).toEqual([])
  })
})
