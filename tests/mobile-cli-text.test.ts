import { describe, expect, it } from 'vitest'
import { renderMobileHelp, renderRotated } from '../src/main/mobile-cli-text'
import { mobileEndpoints } from '../src/main/mobile-endpoints'
import type { TailnetIdentity } from '../src/main/tailscale'

const TAILNET: TailnetIdentity = {
  ips: ['100.101.102.103'],
  magicDnsName: 'workbench.example-tailnet.ts.net',
  magicDnsEnabled: true,
  certDomains: []
}

const withTailnet = mobileEndpoints({
  addresses: ['192.168.2.13'],
  tailnet: TAILNET,
  secure: true,
  token: 'tok'
})

describe('renderMobileHelp', () => {
  it('groups the URLs under a heading that says when to use them', () => {
    const text = renderMobileHelp({
      endpoints: withTailnet,
      secure: true,
      uncovered: [],
      tailnet: true
    })
    const tailscaleAt = text.indexOf('workbench.example-tailnet.ts.net')
    const lanAt = text.indexOf('192.168.2.13')
    expect(tailscaleAt).toBeGreaterThan(-1)
    expect(lanAt).toBeGreaterThan(-1)
    // Tailnet first: it is the address that keeps working off the LAN.
    expect(tailscaleAt).toBeLessThan(lanAt)
    expect(text).toContain('Same Wi-Fi as this Mac')
  })

  it('explains what Tailscale would buy when it is not running', () => {
    const text = renderMobileHelp({
      endpoints: mobileEndpoints({
        addresses: ['192.168.2.13'],
        tailnet: null,
        secure: true,
        token: null
      }),
      secure: true,
      uncovered: [],
      tailnet: false
    })
    expect(text).toContain('Tailscale is not running')
  })

  it('stays quiet about Tailscale when it IS running', () => {
    const text = renderMobileHelp({
      endpoints: withTailnet,
      secure: true,
      uncovered: [],
      tailnet: true
    })
    expect(text).not.toContain('Tailscale is not running')
  })

  it('warns loudly when the cert does not cover an endpoint', () => {
    const text = renderMobileHelp({
      endpoints: withTailnet,
      secure: true,
      uncovered: ['workbench.example-tailnet.ts.net'],
      tailnet: true
    })
    expect(text).toContain('certificate does not cover')
    expect(text).toContain('workbench.example-tailnet.ts.net')
    expect(text).toContain('name mismatch')
  })

  it('says nothing about certificates when everything is covered', () => {
    const text = renderMobileHelp({
      endpoints: withTailnet,
      secure: true,
      uncovered: [],
      tailnet: true
    })
    expect(text).not.toContain('certificate does not cover')
  })

  it('warns that the mic is dead when HTTPS is unavailable', () => {
    const text = renderMobileHelp({
      endpoints: withTailnet,
      secure: false,
      uncovered: [],
      tailnet: true
    })
    expect(text).toContain('HTTP only')
    expect(text).toContain('mic')
  })

  it('tells the user how to revoke — a token that survives restarts needs one', () => {
    const text = renderMobileHelp({
      endpoints: withTailnet,
      secure: true,
      uncovered: [],
      tailnet: true
    })
    expect(text).toContain('--rotate')
    expect(text).toContain('survives restarts')
  })
})

describe('renderRotated', () => {
  it('states the consequence before listing the new URLs', () => {
    const text = renderRotated(withTailnet)
    expect(text).toContain('unpaired')
    expect(text.indexOf('unpaired')).toBeLessThan(text.indexOf('New URLs'))
    expect(text).toContain('workbench.example-tailnet.ts.net')
  })
})
