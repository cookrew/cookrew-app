// WHAT THE PROXY MAY DIAL (main/web-proxy-network.ts): the owner's own networks
// are the point, this machine's loopback is the fence.
import { describe, expect, it } from 'vitest'
import { publicProxyAddress } from '../src/main/web-proxy-network'

describe('the proxy’s dial policy', () => {
  it('reaches the networks this computer is on: LAN, tailnet, and the local tunnel', () => {
    for (const address of ['192.168.1.10', '10.20.100.78', '172.16.4.4', '100.101.102.103', '198.18.2.35']) {
      expect(publicProxyAddress(address), address).toBe(true)
    }
  })

  it('reaches the public internet', () => {
    for (const address of ['1.1.1.1', '104.18.32.7', '2606:4700:4700::1111']) expect(publicProxyAddress(address), address).toBe(true)
  })

  it('reaches a home network’s unique-local IPv6', () => {
    expect(publicProxyAddress('fd7a:115c:a1e0::1')).toBe(true)
  })

  it('never dials this machine itself, nor metadata', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '0.0.0.0', '169.254.169.254', '::1', 'fe80::1', '2001:db8::1', '2001::1']) {
      expect(publicProxyAddress(address), address).toBe(false)
    }
  })

  it('refuses what is not an address at all', () => {
    expect(publicProxyAddress('example.com')).toBe(false)
    expect(publicProxyAddress('')).toBe(false)
  })
})
