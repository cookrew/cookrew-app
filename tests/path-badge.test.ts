import { describe, expect, it } from 'vitest'
import {
  classifyOrigin,
  isLanHostname,
  isTailnetHostname,
  pathBadgeView
} from '../src/shared/path-badge'

describe('path badge host classes', () => {
  it('calls RFC 1918, loopback, link-local and .local addresses the LAN', () => {
    for (const host of [
      '192.168.1.24', '10.0.0.5', '172.16.9.9', '172.31.255.1', '127.0.0.1',
      '169.254.4.4', 'localhost', 'macbook-pro.local', '[fe80::1]', '[::1]'
    ]) {
      expect(isLanHostname(host), host).toBe(true)
    }
  })

  it('does not call a public address the LAN', () => {
    for (const host of ['1.1.1.1', '172.32.0.1', '172.15.0.1', '11.0.0.1', 'cookrew.dev']) {
      expect(isLanHostname(host), host).toBe(false)
    }
  })

  it('recognises the tailnet: 100.64/10, *.ts.net and the ULA block', () => {
    for (const host of [
      '100.64.0.1', '100.101.102.103', '100.127.255.254',
      'macbook-pro.tail1234.ts.net', '[fd7a:115c:a1e0::1]'
    ]) {
      expect(isTailnetHostname(host), host).toBe(true)
    }
  })

  it('keeps 100.64/10 out of the LAN class, so a tailnet hop is never green', () => {
    expect(isTailnetHostname('100.64.0.1')).toBe(true)
    expect(isLanHostname('100.64.0.1')).toBe(false)
    // 100.128.x is ordinary public space, not CGNAT.
    expect(isTailnetHostname('100.128.0.1')).toBe(false)
  })

  it('maps an origin to the word on the badge', () => {
    expect(classifyOrigin('https://192.168.1.24:8643')).toBe('LAN')
    expect(classifyOrigin('https://macbook.local:8643')).toBe('LAN')
    expect(classifyOrigin('https://mac.tail99.ts.net:8643')).toBe('TAILNET')
    expect(classifyOrigin('https://100.75.1.2:8643')).toBe('TAILNET')
    expect(classifyOrigin('https://cookrew.dev')).toBe('RELAY')
    expect(classifyOrigin('https://cookrew.dev/m/abc')).toBe('RELAY')
    // A Mac's own name is the address it spells, until the desktop stops handing names out (step D).
    expect(classifyOrigin('https://192-168-1-24.11111111-2222-3333-4444-555555555555.d.cookrew.dev:8643')).toBe('LAN')
    expect(classifyOrigin('https://100-75-1-2.11111111-2222-3333-4444-555555555555.d.cookrew.dev:8643')).toBe('TAILNET')
  })

  it('honours a registry origin given for a local registry', () => {
    expect(classifyOrigin('https://reg.example.test', 'https://reg.example.test')).toBe('RELAY')
    // Without the override that host is unrecognised — still relay, never LAN.
    expect(classifyOrigin('https://reg.example.test')).toBe('RELAY')
  })

  it('reads an unparseable origin as offline rather than guessing', () => {
    expect(classifyOrigin('not a url')).toBe('OFFLINE')
    expect(classifyOrigin('')).toBe('OFFLINE')
  })
})

describe('path badge view model', () => {
  const live = { origin: 'https://192.168.1.24:8643', link: 'live' as const }

  it('shows the path and its sentence when the channel is live', () => {
    const view = pathBadgeView({ ...live, desktopName: 'MacBook Pro', latencyMs: 12 })
    expect(view.state).toBe('LAN')
    expect(view.word).toBe('LAN')
    expect(view.sentence).toBe('Direct over this Wi-Fi.')
    expect(view.pulsing).toBe(false)
    expect(view.desktopName).toBe('MacBook Pro')
    expect(view.latencyMs).toBe(12)
  })

  it('has one relay sentence, with no cause to guess at and nothing to fix', () => {
    // 2026-10-18: the phone goes direct by itself (WebRTC), so the old reasons
    // — a browser refusal, an unpublished name, an iOS wall — were each a
    // story about a path the companion no longer depends on.
    const relay = pathBadgeView({ origin: 'https://cookrew.dev', link: 'live', relayed: true, plane: 'RELAY' })
    expect(relay.sentence).toBe('Via cookrew.dev relay. It goes direct by itself when your Mac can be reached from here.')
    expect(relay.sentence).not.toMatch(/not on this network|Tailscale|Safari|sign in|settings/i)
  })

  it('uses the owner sentences for tailnet and relay', () => {
    expect(pathBadgeView({ origin: 'https://m.tail9.ts.net', link: 'live' }).sentence)
      .toBe('Via your tailnet.')
    expect(pathBadgeView({ origin: 'https://cookrew.dev', link: 'live' }).sentence)
      .toBe('Via cookrew.dev relay. It goes direct by itself when your Mac can be reached from here.')
  })

  it('a failed channel is OFFLINE whatever the address bar says', () => {
    const view = pathBadgeView({ ...live, link: 'failed' })
    expect(view.state).toBe('OFFLINE')
    expect(view.sentence).toBe('Not reachable right now.')
    expect(view.pulsing).toBe(false)
  })

  it('a reconnecting channel is PROBING, and the dot pulses', () => {
    const view = pathBadgeView({ ...live, link: 'reconnecting' })
    expect(view.state).toBe('PROBING')
    expect(view.pulsing).toBe(true)
  })

  it('offers the way to another machine only where there is one: the console’s machines, never a guessed site', () => {
    // 0.6.0: the account's machines are the console's first level. A page that is not the
    // console has no such level to offer, and the registry's hosts serve no page for it
    // (its API host serves none at all): knowing where the registry is offers nothing.
    expect(pathBadgeView(live).switchDesktopUrl).toBeNull()
    expect(pathBadgeView({ ...live, registryOrigin: 'https://api.cookrew.dev' }).switchDesktopUrl).toBeNull()
    expect(pathBadgeView({ ...live, machinesUrl: '/' }).switchDesktopUrl).toBe('/')
  })

  it('knows the relay by the registry’s API host', () => {
    expect(classifyOrigin('https://api.cookrew.dev')).toBe('RELAY')
  })

  it('reports no latency as null rather than zero', () => {
    expect(pathBadgeView(live).latencyMs).toBeNull()
    expect(pathBadgeView({ ...live, latencyMs: null }).latencyMs).toBeNull()
    expect(pathBadgeView({ ...live, latencyMs: 0 }).latencyMs).toBe(0)
  })
})

describe('the relay, when a direct link answered and was not taken (shared/rtc-bind.ts)', () => {
  const relay = { origin: 'https://cookrew.dev', link: 'live' as const, relayed: true, plane: 'RELAY' as const }

  it('still reads RELAY, and says why it stays there instead of promising to go direct', () => {
    const plain = pathBadgeView(relay)
    for (const held of ['old-mac', 'browser', 'unproved', 'unpaired', 'sealing', 'ice', 'sealedOnly'] as const) {
      const view = pathBadgeView({ ...relay, held })
      expect(view.word, held).toBe('RELAY')
      expect(view.sentence, held).not.toBe(plain.sentence)
      expect(view.sentence, held).toMatch(/^Via cookrew\.dev relay\./)
      expect(view.sentence, held).not.toMatch(/goes direct by itself/)
    }
  })

  it('tells an older Mac to update, a browser it cannot check, and anything else that the link was not proved', () => {
    expect(pathBadgeView({ ...relay, held: 'old-mac' }).sentence).toMatch(/update Cookrew on your Mac/i)
    expect(pathBadgeView({ ...relay, held: 'browser' }).sentence).toMatch(/this browser cannot check/i)
    expect(pathBadgeView({ ...relay, held: 'unproved' }).sentence).toMatch(/could not prove/i)
    // The page's own stage: pairing, sealing in progress, or an answered link that never opened.
    expect(pathBadgeView({ ...relay, held: 'unpaired' }).sentence).toMatch(/no sealed session with your Mac/i)
    expect(pathBadgeView({ ...relay, held: 'sealing' }).sentence).toMatch(/has not been confirmed yet/i)
    expect(pathBadgeView({ ...relay, held: 'ice' }).sentence).toMatch(/never opened/i)
    expect(pathBadgeView({ ...relay, held: 'sealedOnly' }).sentence).toMatch(/refuses plain connections/i)
  })

  it('says nothing of it once the plane is direct, or while the link is down', () => {
    expect(pathBadgeView({ ...relay, plane: 'LAN', held: 'unproved' }).sentence).toBe(pathBadgeView({ ...relay, plane: 'LAN' }).sentence)
    expect(pathBadgeView({ ...relay, link: 'failed', held: 'unproved' }).state).toBe('OFFLINE')
    expect(pathBadgeView({ ...relay, link: 'failed', held: 'unproved' }).sentence).toBe(pathBadgeView({ ...relay, link: 'failed' }).sentence)
  })
})
