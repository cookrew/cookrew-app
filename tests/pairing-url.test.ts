import { describe, expect, it } from 'vitest'
import {
  PAIR_FRAGMENT,
  pairingUrl,
  parsePairingFragment,
  relayDesktopUrl
} from '../src/shared/pairing-url'
import { pairingHandout } from '../src/main/pairing-handout'
import { reachCard } from '../src/main/reach'

/**
 * THE ONE CREDENTIAL, IN THE ONE URL.
 *
 * Two properties are load-bearing and neither is obvious from reading the
 * string: the token is in the FRAGMENT, so cookrew.dev never receives it; and
 * the prefix is exactly the relay prefix the registry serves, so the phone
 * stays on cookrew.dev instead of being sent to an address on a Wi-Fi it may
 * not be on.
 */

const DEVICE = '0189d0f2-9a4c-8f31-9c0e-2b7a5d6e1f40'
const TOKEN = 'a-persisted-pairing-token'

describe('the canonical pairing URL', () => {
  it('is the relay prefix for this account and this Mac, with the token after the #', () => {
    expect(
      pairingUrl({
        registryOrigin: 'https://cookrew.dev',
        username: 'drej',
        deviceId: DEVICE,
        pairingToken: TOKEN
      })
    ).toBe(`https://cookrew.dev/relay/@drej/desktop/${DEVICE}/#pair=${TOKEN}`)
  })

  it('keeps the token OUT of everything the registry is sent', () => {
    const url = pairingUrl({
      registryOrigin: 'https://cookrew.dev',
      username: 'drej',
      deviceId: DEVICE,
      pairingToken: TOKEN
    })
    const parsed = new URL(url as string)
    // Path and query are what a browser puts on the wire. Neither may carry it.
    expect(parsed.pathname).not.toContain(TOKEN)
    expect(parsed.search).toBe('')
    expect(parsed.hash).toBe(`#${PAIR_FRAGMENT}=${TOKEN}`)
  })

  it('percent-encodes a token, so a fragment cannot be split in two', () => {
    const url = pairingUrl({
      registryOrigin: 'https://cookrew.dev',
      username: 'drej',
      deviceId: DEVICE,
      pairingToken: 'a b&c#d'
    })
    expect(url).toContain('#pair=a%20b%26c%23d')
    expect(parsePairingFragment(new URL(url as string).hash)).toBe('a b&c#d')
  })

  it('tolerates a trailing slash on the origin and honours a self-hosted one', () => {
    expect(
      pairingUrl({
        registryOrigin: 'https://registry.example/',
        username: 'drej',
        deviceId: DEVICE,
        pairingToken: TOKEN
      })
    ).toBe(`https://registry.example/relay/@drej/desktop/${DEVICE}/#pair=${TOKEN}`)
  })

  it('is nothing at all when any part of it is missing or malformed', () => {
    const good = {
      registryOrigin: 'https://cookrew.dev',
      username: 'drej',
      deviceId: DEVICE,
      pairingToken: TOKEN
    }
    expect(pairingUrl({ ...good, username: 'Not A Handle' })).toBeNull()
    expect(pairingUrl({ ...good, username: '' })).toBeNull()
    expect(pairingUrl({ ...good, deviceId: 'not-a-uuid' })).toBeNull()
    expect(pairingUrl({ ...good, pairingToken: '' })).toBeNull()
    expect(pairingUrl({ ...good, registryOrigin: '' })).toBeNull()
    // A registry origin that is not https is not one we hand a phone.
    expect(pairingUrl({ ...good, registryOrigin: 'ftp://cookrew.dev' })).toBeNull()
  })

  it('names the prefix the relay actually serves', () => {
    expect(
      relayDesktopUrl({ registryOrigin: 'https://cookrew.dev', username: 'drej', deviceId: DEVICE })
    ).toBe(`https://cookrew.dev/relay/@drej/desktop/${DEVICE}/`)
  })
})

describe('reading the fragment back', () => {
  it('takes the token with or without the leading #', () => {
    expect(parsePairingFragment(`#pair=${TOKEN}`)).toBe(TOKEN)
    expect(parsePairingFragment(`pair=${TOKEN}`)).toBe(TOKEN)
  })

  it('is null for a fragment that carries something else, or nothing', () => {
    expect(parsePairingFragment('')).toBeNull()
    expect(parsePairingFragment('#')).toBeNull()
    expect(parsePairingFragment('#pair=')).toBeNull()
    expect(parsePairingFragment('#other=x')).toBeNull()
  })
})

describe('what the desktop hands its two surfaces', () => {
  const endpoints = [
    { url: 'https://mac.tail1234.ts.net:8643/?token=t', kind: 'tailscale' },
    { url: 'https://192.168.2.40:8643/?token=t', kind: 'lan' },
    { url: 'https://localhost:8643/?token=t', kind: 'loopback' }
  ]

  it('is the relay URL when this Mac has an account', () => {
    const handout = pairingHandout({
      account: () => ({ username: 'drej', deviceId: DEVICE, name: 'This Mac' }),
      registryOrigin: () => 'https://cookrew.dev',
      endpoints: () => endpoints,
      pairingToken: () => TOKEN
    })
    expect(handout).toEqual({
      url: `https://cookrew.dev/relay/@drej/desktop/${DEVICE}/#pair=${TOKEN}`,
      via: 'relay',
      desktopName: 'This Mac',
      deviceId: DEVICE
    })
  })

  it('falls back to the most reachable DIRECT address with no account', () => {
    const handout = pairingHandout({
      account: () => null,
      registryOrigin: () => 'https://cookrew.dev',
      endpoints: () => endpoints,
      pairingToken: () => TOKEN
    })
    expect(handout).toEqual({
      url: 'https://mac.tail1234.ts.net:8643/?token=t',
      via: 'direct',
      desktopName: 'This Mac'
    })
  })

  it('never offers loopback as the thing to scan', () => {
    const handout = pairingHandout({
      account: () => null,
      registryOrigin: () => 'https://cookrew.dev',
      endpoints: () => [{ url: 'https://localhost:8643/?token=t', kind: 'loopback' }],
      pairingToken: () => TOKEN
    })
    expect(handout).toBeNull()
  })

  it('is nothing before the server has a token to hand out', () => {
    expect(
      pairingHandout({
        account: () => ({ username: 'drej', deviceId: DEVICE, name: 'This Mac' }),
        registryOrigin: () => 'https://cookrew.dev',
        endpoints: () => endpoints,
        pairingToken: () => null
      })
    ).toBeNull()
  })
})

describe('the reach card still carries no credential', () => {
  it('publishes the addresses and neither the token nor the pairing URL', () => {
    const card = reachCard({
      deviceId: DEVICE,
      endpoints: [
        { url: `https://192.168.2.40:8643/?token=${TOKEN}`, kind: 'lan', host: '192.168.2.40' }
      ],
      certFp: 'ff'.repeat(32),
      relay: true,
      at: 0
    })
    const published = JSON.stringify(card)
    expect(published).not.toContain(TOKEN)
    expect(published).not.toContain('pair=')
    expect(published).not.toContain('token')
  })
})
