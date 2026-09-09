import { describe, expect, it } from 'vitest'
import { renderMobileHelp, renderRotated } from '../src/main/mobile-cli-text'
import { mobileEndpoints } from '../src/main/mobile-endpoints'
import type { TailnetIdentity } from '../src/main/tailscale'
import type { PairingHandout } from '../src/shared/account-v2'
import { BRIDGE_ADDRESSES, REAL_ADDRESS, publishedFive } from './support/five-interfaces'

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
    // The remedy used to be "restart Cookrew". It no longer is: the server
    // reissues and swaps the cert in place, so telling the user to restart
    // would cost them every running agent for a problem that fixes itself.
    expect(text).toContain('reissues within a minute')
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

  it('warns when a system proxy would swallow the tailnet URL it just printed', () => {
    const text = renderMobileHelp({
      endpoints: withTailnet,
      secure: true,
      uncovered: [],
      tailnet: true,
      proxyBypassGaps: ['100.64.0.0/10', '*.ts.net']
    })
    expect(text).toContain('100.64.0.0/10')
    expect(text).toContain('*.ts.net')
    // The symptom the user will actually see, so searching for it lands here.
    expect(text).toContain('ERR_CONNECTION_CLOSED')
    // It must not read as a Cookrew fault — that is the whole point.
    expect(text).toContain('proxy')
  })

  it('lists only the bypass entry that is actually missing', () => {
    const text = renderMobileHelp({
      endpoints: withTailnet,
      secure: true,
      uncovered: [],
      tailnet: true,
      proxyBypassGaps: ['*.ts.net']
    })
    expect(text).toContain('*.ts.net')
    expect(text).not.toContain('100.64.0.0/10')
  })

  it('stays quiet when the proxy already exempts the tailnet', () => {
    const text = renderMobileHelp({
      endpoints: withTailnet,
      secure: true,
      uncovered: [],
      tailnet: true,
      proxyBypassGaps: []
    })
    expect(text).not.toContain('ERR_CONNECTION_CLOSED')
  })

  it('stays quiet when the input says nothing about a proxy', () => {
    const text = renderMobileHelp({ endpoints: withTailnet, secure: true, uncovered: [], tailnet: true })
    expect(text).not.toContain('ERR_CONNECTION_CLOSED')
  })

  it('says nothing about the proxy when no tailnet URL was advertised', () => {
    // Nothing to break: without a tailnet endpoint the proxy gap is academic.
    const text = renderMobileHelp({
      endpoints: mobileEndpoints({
        addresses: ['192.168.2.13'],
        tailnet: null,
        secure: true,
        token: null
      }),
      secure: true,
      uncovered: [],
      tailnet: false,
      proxyBypassGaps: ['100.64.0.0/10', '*.ts.net']
    })
    expect(text).not.toContain('ERR_CONNECTION_CLOSED')
    expect(text).not.toContain('100.64.0.0/10')
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

/**
 * ONE URL, PRINTED FIRST.
 *
 * The relay URL is the only one that works from a phone that is not on this
 * Wi-Fi, so it goes above the addresses that only work here. The direct URLs
 * stay exactly as they were: a phone with no account, or a Mac with no
 * internet, still has to be able to pair.
 */
const RELAY_URL =
  'https://cookrew.dev/relay/@drej/desktop/0189d0f2-9a4c-8f31-9c0e-2b7a5d6e1f40/#pair=tok'

const RELAY: PairingHandout = {
  url: RELAY_URL,
  via: 'relay',
  desktopName: 'This Mac',
  deviceId: '0189d0f2-9a4c-8f31-9c0e-2b7a5d6e1f40'
}

describe('the pairing URL', () => {
  it('is printed FIRST, above every address that only works on this Wi-Fi', () => {
    const text = renderMobileHelp({
      endpoints: withTailnet,
      secure: true,
      uncovered: [],
      tailnet: true,
      pairing: RELAY
    })
    const relayAt = text.indexOf(RELAY_URL)
    expect(relayAt).toBeGreaterThan(-1)
    expect(relayAt).toBeLessThan(text.indexOf('workbench.example-tailnet.ts.net'))
    expect(relayAt).toBeLessThan(text.indexOf('192.168.2.13'))
    expect(text).toContain('From anywhere')
  })

  it('says why the token is after the # — cookrew.dev never receives it', () => {
    const text = renderMobileHelp({
      endpoints: withTailnet,
      secure: true,
      uncovered: [],
      tailnet: true,
      pairing: RELAY
    })
    expect(text).toContain('#')
    expect(text).toContain('never sees')
  })

  it('still prints the direct URLs, for a phone with no account or no internet', () => {
    const text = renderMobileHelp({
      endpoints: withTailnet,
      secure: true,
      uncovered: [],
      tailnet: true,
      pairing: RELAY
    })
    expect(text).toContain('https://192.168.2.13:8643/?token=tok')
    expect(text).toContain('Same Wi-Fi as this Mac')
  })

  it('is absent entirely when this Mac has no account', () => {
    const text = renderMobileHelp({
      endpoints: withTailnet,
      secure: true,
      uncovered: [],
      tailnet: true,
      pairing: { url: 'https://192.168.2.13:8643/?token=tok', via: 'direct', desktopName: 'This Mac' }
    })
    expect(text).not.toContain('From anywhere')
    expect(text).not.toContain('/relay/@')
    expect(text).toContain('https://192.168.2.13:8643/?token=tok')
  })

  it('is absent when nothing was handed in at all', () => {
    const text = renderMobileHelp({
      endpoints: withTailnet,
      secure: true,
      uncovered: [],
      tailnet: true
    })
    expect(text).not.toContain('/relay/@')
  })
})

/**
 * Five addresses, four bridges (2026-09-08). `cookrew mobile` printed five URLs
 * under "Same Wi-Fi as this Mac" and four of them were host-only networks — an
 * owner reading that list had a one-in-five chance of picking the one that
 * works, and no way to tell which.
 */
describe('the five-interface Mac, as `cookrew mobile` prints it', () => {
  const printed = (env?: Record<string, string>): string =>
    renderMobileHelp({
      endpoints: mobileEndpoints({
        addresses: publishedFive(env),
        tailnet: null,
        secure: true,
        token: 'tok'
      }),
      secure: true,
      uncovered: [],
      tailnet: false
    })

  it('prints one Wi-Fi URL, not five', () => {
    const text = printed()
    expect(text).toContain(`https://${REAL_ADDRESS}:8643/?token=tok`)
    for (const bridge of BRIDGE_ADDRESSES) expect(text).not.toContain(bridge)
    const wifi = text.split('\n').filter((line) => line.includes(':8643'))
    expect(wifi).toHaveLength(1)
  })

  it('prints all five again under COOKREW_PUBLISH_INTERFACES=all', () => {
    const text = printed({ COOKREW_PUBLISH_INTERFACES: 'all' })
    for (const bridge of BRIDGE_ADDRESSES) expect(text).toContain(bridge)
  })
})

describe('renderRotated', () => {
  it('states the consequence before listing the new URLs', () => {
    const text = renderRotated(withTailnet)
    expect(text).toContain('unpaired')
    expect(text.indexOf('unpaired')).toBeLessThan(text.indexOf('New URLs'))
    expect(text).toContain('workbench.example-tailnet.ts.net')
  })

  it('leads with the new pairing URL, because rotation is what changed it', () => {
    const text = renderRotated(withTailnet, RELAY)
    expect(text).toContain(RELAY_URL)
    expect(text.indexOf(RELAY_URL)).toBeLessThan(text.indexOf('workbench.example-tailnet.ts.net'))
  })
})
