import { describe, expect, it } from 'vitest'
import { classifyHost, endpointCertHosts, mobileEndpoints } from '../src/main/mobile-endpoints'
import type { TailnetIdentity } from '../src/main/tailscale'

const TAILNET: TailnetIdentity = {
  ips: ['100.101.102.103', 'fd7a:115c:a1e0::1234:5678'],
  magicDnsName: 'workbench.example-tailnet.ts.net',
  magicDnsEnabled: true,
  certDomains: ['workbench.example-tailnet.ts.net']
}

/**
 * The addresses a real Mac reports once VMs, a proxy and Tailscale are all
 * installed. Only ONE of these is a LAN address a phone can reach.
 */
const MESSY = [
  '192.168.2.13', // the actual Wi-Fi
  '192.168.139.3', // a VM host-only bridge
  '198.18.0.1', // proxy fake-ip range
  '100.101.102.103', // tailnet
  '169.254.1.6' // link-local, never routable
]

describe('classifyHost', () => {
  it('separates tailnet, LAN and addresses no phone can use', () => {
    expect(classifyHost('100.101.102.103')).toBe('tailscale')
    expect(classifyHost('192.168.2.13')).toBe('lan')
    expect(classifyHost('10.1.2.3')).toBe('lan')
    expect(classifyHost('172.16.4.5')).toBe('lan')
    // 172.32 is OUTSIDE the /12 — a boundary a naive `172.` test gets wrong.
    expect(classifyHost('172.32.4.5')).toBe('other')
    expect(classifyHost('169.254.1.6')).toBe('unusable')
    expect(classifyHost('198.18.0.1')).toBe('unusable')
  })
})

describe('mobileEndpoints', () => {
  it('puts the tailnet first: it is the one address that works off the LAN', () => {
    const endpoints = mobileEndpoints({
      addresses: MESSY,
      tailnet: TAILNET,
      secure: true,
      token: 'abc'
    })
    expect(endpoints[0].kind).toBe('tailscale')
    expect(endpoints[0].url).toContain('workbench.example-tailnet.ts.net')
  })

  it('prefers the MagicDNS name over the raw tailnet IP', () => {
    const [first, second] = mobileEndpoints({
      addresses: [],
      tailnet: TAILNET,
      secure: true,
      token: null
    })
    expect(first.url).toBe('https://workbench.example-tailnet.ts.net:8643')
    expect(second.url).toBe('https://100.101.102.103:8643')
  })

  it('brackets IPv6 hosts so the URL is actually parseable', () => {
    const v6 = mobileEndpoints({ addresses: [], tailnet: TAILNET, secure: true, token: null }).find(
      (e) => e.host.includes(':')
    )
    expect(v6?.url).toBe('https://[fd7a:115c:a1e0::1234:5678]:8643')
    expect(() => new URL(v6?.url ?? '')).not.toThrow()
  })

  it('drops link-local and fake-ip addresses instead of listing dead links', () => {
    const urls = mobileEndpoints({
      addresses: MESSY,
      tailnet: TAILNET,
      secure: true,
      token: null
    }).map((e) => e.url)
    expect(urls.some((u) => u.includes('169.254'))).toBe(false)
    expect(urls.some((u) => u.includes('198.18'))).toBe(false)
    expect(urls.some((u) => u.includes('192.168.2.13'))).toBe(true)
  })

  it('lists a tailnet address once, even though it is also a local interface', () => {
    // 100.101.102.103 arrives BOTH from Tailscale's status and from the
    // machine's own interface list. Listing it twice is how the URL list
    // grew to seven lines in the first place.
    const tailnetUrls = mobileEndpoints({
      addresses: MESSY,
      tailnet: TAILNET,
      secure: true,
      token: null
    }).filter((e) => e.url.includes('100.101.102.103'))
    expect(tailnetUrls).toHaveLength(1)
  })

  it('carries the pairing token on every endpoint', () => {
    const endpoints = mobileEndpoints({
      addresses: ['192.168.2.13'],
      tailnet: TAILNET,
      secure: true,
      token: 'tok-123'
    })
    expect(endpoints.length).toBeGreaterThan(0)
    for (const endpoint of endpoints) expect(endpoint.url).toContain('?token=tok-123')
  })

  it('falls back to loopback when the machine has no usable address', () => {
    const endpoints = mobileEndpoints({
      addresses: ['169.254.1.6'],
      tailnet: null,
      secure: false,
      token: null
    })
    expect(endpoints).toHaveLength(1)
    expect(endpoints[0].kind).toBe('loopback')
    expect(endpoints[0].url).toBe('http://localhost:8639')
  })

  it('uses the plain port when HTTPS is unavailable', () => {
    const endpoints = mobileEndpoints({
      addresses: ['192.168.2.13'],
      tailnet: null,
      secure: false,
      token: null
    })
    expect(endpoints[0].url).toBe('http://192.168.2.13:8639')
  })

  it('says what each endpoint is for — an unlabelled list is unusable', () => {
    const endpoints = mobileEndpoints({
      addresses: ['192.168.2.13'],
      tailnet: TAILNET,
      secure: true,
      token: null
    })
    const tailscale = endpoints.find((e) => e.kind === 'tailscale')
    expect(tailscale?.label.toLowerCase()).toContain('tailscale')
    expect(endpoints.find((e) => e.kind === 'lan')?.label.toLowerCase()).toContain('wi-fi')
  })
})

describe('endpointCertHosts — the cert covers exactly what we advertise', () => {
  it('carries every advertised host, split into IPs and DNS names', () => {
    const hosts = endpointCertHosts(
      mobileEndpoints({ addresses: MESSY, tailnet: TAILNET, secure: true, token: null })
    )
    expect(hosts.dnsNames).toEqual(['workbench.example-tailnet.ts.net'])
    // Both tailnet families: a phone on a v6-only carrier reaches the v6
    // address first, and an uncovered v6 SAN is a URL it cannot load.
    expect(hosts.ips).toContain('100.101.102.103')
    expect(hosts.ips).toContain('fd7a:115c:a1e0::1234:5678')
    expect(hosts.ips).toContain('192.168.2.13')
  })

  it('leaves out the addresses no phone is ever sent to', () => {
    // These are the churn source: a proxy's TUN and a link-local address come
    // and go with every VPN toggle. In the cert they forced a reissue — and
    // every paired phone then had to accept a new self-signed cert again.
    const hosts = endpointCertHosts(
      mobileEndpoints({ addresses: MESSY, tailnet: TAILNET, secure: true, token: null })
    )
    expect(hosts.ips).not.toContain('198.18.0.1')
    expect(hosts.ips).not.toContain('169.254.1.6')
  })

  it('asks for nothing when only the loopback fallback is advertised', () => {
    // ensureCert always emits localhost/127.0.0.1, so requesting them here
    // would just be a second spelling of the same guarantee.
    const hosts = endpointCertHosts(
      mobileEndpoints({ addresses: [], tailnet: null, secure: false, token: null })
    )
    expect(hosts).toEqual({ ips: [], dnsNames: [] })
  })
})
