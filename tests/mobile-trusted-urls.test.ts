import { describe, expect, it } from 'vitest'
import { renderMobileHelp, renderRotated } from '../src/main/mobile-cli-text'
import { mobileEndpoints } from '../src/main/mobile-endpoints'
import { pairingHandout } from '../src/main/pairing-handout'
import { createReachPublisher } from '../src/main/reach'
import type { TailnetIdentity } from '../src/main/tailscale'
import { fakeAccount } from './support/idv2'
import { DEFAULT_NAME_ZONE } from '../src/shared/reach-names'

/**
 * WHAT THE OWNER SEES, AND WHAT cookrew.dev IS TOLD, once a certificate is
 * held. The bare address and the name are the same listener; the whole point
 * of the name is that a phone loading it sees no interstitial, so a surface
 * that prints both — or a card that claims a name before the chain arrives —
 * puts the warning back.
 */

const MAC = '3f2b9c14-7a55-4d2e-9d0f-1c8e6b4a7f30'
const ZONE = DEFAULT_NAME_ZONE
const TAILNET: TailnetIdentity = {
  ips: ['100.101.102.103'],
  magicDnsName: 'workbench.example-tailnet.ts.net',
  magicDnsEnabled: true,
  certDomains: []
}

const endpoints = (trusted: boolean, secure = true): ReturnType<typeof mobileEndpoints> =>
  mobileEndpoints({
    addresses: ['192.168.2.13'],
    tailnet: TAILNET,
    secure,
    token: 'tok',
    trusted: trusted ? { deviceId: MAC, zone: ZONE } : null
  })

describe('the URLs a Mac with a certificate prints', () => {
  it('spells each address as a name, and never both spellings', () => {
    const text = renderMobileHelp({
      endpoints: endpoints(true),
      secure: true,
      uncovered: [],
      tailnet: true
    })
    expect(text).toContain(`https://192-168-2-13.${MAC}.${ZONE}:8643/?token=tok`)
    expect(text).toContain(`https://100-101-102-103.${MAC}.${ZONE}:8643/?token=tok`)
    // The bare addresses are gone — printing both invites a scan of the one
    // that warns.
    expect(text).not.toContain('https://192.168.2.13:8643')
    expect(text).not.toContain('https://100.101.102.103:8643')
  })

  it('drops the self-signed sentence when a trusted name is printed', () => {
    const trusted = renderMobileHelp({
      endpoints: endpoints(true),
      secure: true,
      uncovered: [],
      tailnet: true
    })
    expect(trusted).not.toContain('self-signed')
    expect(trusted).toContain('no warning')

    const bare = renderMobileHelp({
      endpoints: endpoints(false),
      secure: true,
      uncovered: [],
      tailnet: true
    })
    expect(bare).toContain('HTTPS is self-signed')
    expect(bare).toContain('https://192.168.2.13:8643/?token=tok')
  })

  it('leaves the MagicDNS name alone — it resolves elsewhere', () => {
    const text = renderMobileHelp({
      endpoints: endpoints(true),
      secure: true,
      uncovered: [],
      tailnet: true
    })
    expect(text).toContain('https://workbench.example-tailnet.ts.net:8643/?token=tok')
  })

  it('prints bare addresses over plain HTTP, where there is no certificate at all', () => {
    const text = renderMobileHelp({
      endpoints: endpoints(true, false),
      secure: false,
      uncovered: [],
      tailnet: true
    })
    expect(text).not.toContain(ZONE)
    expect(text).toContain('http://192.168.2.13:8639/?token=tok')
  })

  it('carries the names into the rotation notice too', () => {
    const text = renderRotated(endpoints(true))
    expect(text).toContain(`https://192-168-2-13.${MAC}.${ZONE}:8643/?token=tok`)
    expect(text).not.toContain('https://192.168.2.13:8643')
  })
})

describe('the one URL the popout draws', () => {
  const deps = (trusted: boolean): Parameters<typeof pairingHandout>[0] => ({
    account: () => null,
    registryOrigin: () => 'https://cookrew.dev',
    endpoints: () => endpoints(trusted),
    pairingToken: () => 'tok'
  })

  it('hands out the trusted name when this Mac has one', () => {
    const handout = pairingHandout(deps(true))
    expect(handout?.via).toBe('direct')
    expect(handout?.url).toContain(`.${MAC}.${ZONE}:8643`)
  })

  it('falls back to the most reachable bare address otherwise', () => {
    const handout = pairingHandout(deps(false))
    expect(handout?.url).toBe('https://workbench.example-tailnet.ts.net:8643/?token=tok')
  })
})

describe('what the registry is told', () => {
  // A real device key: the card is SIGNED, and a publisher that could not
  // sign would report every publish as refused for the wrong reason.
  const account = fakeAccount()

  const publisherWith = (
    trusted: readonly string[],
    seen: { body?: { workspaces: unknown; reach: unknown; trusted: readonly string[] } }
  ): ReturnType<typeof createReachPublisher> =>
    createReachPublisher({
      account: () => account,
      endpoints: () => [
        { url: 'https://192.168.2.13:8643/?token=tok', kind: 'lan', host: '192.168.2.13' }
      ],
      certFp: () => 'a'.repeat(64),
      relay: () => false,
      workspaces: () => [{ id: 'w1', name: 'One' }],
      trusted: () => trusted,
      register: (workspaces, reach, sent) => {
        seen.body = { workspaces, reach: reach.reach, trusted: sent }
        return Promise.resolve({ ok: true })
      }
    })

  it('sends the trusted origins BESIDE the signed card, never inside it', async () => {
    const seen: { body?: { workspaces: unknown; reach: unknown; trusted: readonly string[] } } = {}
    const origin = `https://192-168-2-13.${MAC}.${ZONE}:8643`
    const publisher = publisherWith([origin], seen)
    expect(await publisher.republish('boot')).toBe('published')
    expect(seen.body?.trusted).toEqual([origin])
    // The card holds exactly the members the registry's reader names; an extra
    // one inside it would fail every signature check on the phone.
    expect(Object.keys(seen.body?.reach as object).sort()).toEqual([
      'at',
      'deviceId',
      'lan',
      'relay',
      'tailnet'
    ])
  })

  it('sends an empty list when no certificate is held', async () => {
    const seen: { body?: { workspaces: unknown; reach: unknown; trusted: readonly string[] } } = {}
    const publisher = publisherWith([], seen)
    expect(await publisher.republish('boot')).toBe('published')
    expect(seen.body?.trusted).toEqual([])
  })

  it('republishes when the first certificate arrives, though the card is unchanged', async () => {
    const seen: { body?: { workspaces: unknown; reach: unknown; trusted: readonly string[] } } = {}
    let trusted: readonly string[] = []
    const publisher = createReachPublisher({
      account: () => account,
      endpoints: () => [
        { url: 'https://192.168.2.13:8643/?token=tok', kind: 'lan', host: '192.168.2.13' }
      ],
      certFp: () => 'a'.repeat(64),
      relay: () => false,
      workspaces: () => [{ id: 'w1', name: 'One' }],
      trusted: () => trusted,
      register: (workspaces, reach, sent) => {
        seen.body = { workspaces, reach: reach.reach, trusted: sent }
        return Promise.resolve({ ok: true })
      }
    })
    expect(await publisher.publish('boot')).toBe('published')
    expect(await publisher.publish('nothing changed')).toBe('unchanged')
    // The addresses are identical; only the certificate is new. Without this
    // the Mac would sit publishing "no trusted names" for ever.
    trusted = [`https://192-168-2-13.${MAC}.${ZONE}:8643`]
    expect(await publisher.publish('certificate issued')).toBe('published')
    expect(seen.body?.trusted).toEqual(trusted)
  })
})
