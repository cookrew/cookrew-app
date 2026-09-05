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

  it('uses the owner sentences for tailnet and relay', () => {
    expect(pathBadgeView({ origin: 'https://m.tail9.ts.net', link: 'live' }).sentence)
      .toBe('Via your tailnet.')
    expect(pathBadgeView({ origin: 'https://cookrew.dev', link: 'live' }).sentence)
      .toBe('Via cookrew.dev relay — your Mac is not on this network.')
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

  it('offers switch desktop at the registry, with no double slash', () => {
    expect(pathBadgeView(live).switchDesktopUrl).toBe('https://cookrew.dev/me')
    expect(pathBadgeView({ ...live, registryOrigin: 'https://reg.test/' }).switchDesktopUrl)
      .toBe('https://reg.test/me')
  })

  it('reports no latency as null rather than zero', () => {
    expect(pathBadgeView(live).latencyMs).toBeNull()
    expect(pathBadgeView({ ...live, latencyMs: null }).latencyMs).toBeNull()
    expect(pathBadgeView({ ...live, latencyMs: 0 }).latencyMs).toBe(0)
  })
})
