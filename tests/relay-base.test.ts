import { Readable } from 'node:stream'
import type http from 'node:http'
import { describe, expect, it } from 'vitest'
import { RELAY_BASE_HEADER, RELAY_MARKER, isLoopbackPeer, relayBaseOf } from '../src/main/relay-base'
import { remoteBootFor } from '../src/main/mobile-server'

/**
 * IDENTITY v2, PHASE 3 — THE COMPANION UNDER A PREFIX.
 *
 * Pressing OPEN on /me loaded the app at `/relay/@user/desktop/<id>/` and then
 * every `/api/...` it issued left that prefix and hit cookrew.dev's own
 * routes. The registry now says where the page is; this is the rule for when
 * that is believed, and it is the whole security of the feature: a LAN client
 * that could name its own base could make a phone's requests go anywhere.
 */

const BASE = '/relay/@owner/desktop/11111111-2222-3333-4444-555555555555'

const asRequest = (
  headers: Record<string, string>,
  remoteAddress = '127.0.0.1'
): http.IncomingMessage => {
  const request = Readable.from([]) as http.IncomingMessage
  request.method = 'GET'
  request.headers = headers
  Object.defineProperty(request, 'socket', { value: { remoteAddress } })
  return request
}

const fromBridge = (base: string): Record<string, string> => ({
  [RELAY_MARKER]: '1',
  [RELAY_BASE_HEADER]: base
})

describe('who may say where the page is', () => {
  it('believes the bridge, on loopback, in the one shape a base may be', () => {
    expect(relayBaseOf({ ...marker(BASE), remoteAddress: '127.0.0.1' })).toBe(BASE)
    expect(relayBaseOf({ ...marker(`${BASE}/`), remoteAddress: '::1' })).toBe(BASE)
    // A relayed client under a workspace slug is still one prefix.
    expect(relayBaseOf({ ...marker(`${BASE}/playground`), remoteAddress: '127.0.0.1' })).toBe(
      `${BASE}/playground`
    )
  })

  it('believes nobody on the network, however well they type the headers', () => {
    // The marker is written by the bridge over whatever the caller sent, so a
    // request that did not come down the line cannot claim to have — and the
    // address is checked too, because a header can be typed and an address
    // cannot be arranged from the LAN.
    expect(relayBaseOf({ ...marker(BASE), remoteAddress: '192.168.1.44' })).toBe('')
    expect(relayBaseOf({ ...marker(BASE), remoteAddress: '100.68.81.64' })).toBe('')
    expect(relayBaseOf({ ...marker(BASE), remoteAddress: undefined })).toBe('')
  })

  it('believes nothing without the marker', () => {
    expect(
      relayBaseOf({ marker: undefined, base: BASE, remoteAddress: '127.0.0.1' })
    ).toBe('')
    expect(relayBaseOf({ marker: '0', base: BASE, remoteAddress: '127.0.0.1' })).toBe('')
  })

  it('refuses anything that is not exactly a canvas relay prefix', () => {
    for (const bad of [
      '/',
      '',
      '//evil.example',
      'https://evil.example',
      '/relay/@owner/desktop/not-a-uuid',
      '/relay/@owner/team',
      `${BASE}/../../etc`,
      `${BASE}"; window.x=1; //`,
      `${BASE}</script><script>alert(1)</script>`
    ]) {
      expect(relayBaseOf({ ...marker(bad), remoteAddress: '127.0.0.1' }), bad).toBe('')
    }
  })

  it('reads a dual-stack peer as the loopback it is', () => {
    expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackPeer('::ffff:192.168.1.4')).toBe(false)
  })
})

const marker = (base: string): { marker: string; base: string } => ({ marker: '1', base })

describe('the shell the companion boots from', () => {
  it('carries the base when it came down the bridge', () => {
    const boot = remoteBootFor(asRequest(fromBridge(BASE)), null)
    expect(boot).toContain(`window.COOKREW_BASE = "${BASE}"`)
    expect(boot).toContain('window.COOKREW_SLUG = ""')
  })

  it('carries no base for a LAN client that forged the headers', () => {
    const boot = remoteBootFor(asRequest(fromBridge(BASE), '192.168.1.44'), null)
    expect(boot).toContain('window.COOKREW_BASE = ""')
  })

  it('carries no base for an ordinary companion at the root', () => {
    expect(remoteBootFor(asRequest({}), 'playground')).toContain('window.COOKREW_BASE = ""')
  })

  it('cannot be broken out of, however the base is spelled', () => {
    // Refused by shape long before this matters — but a lock that only works
    // because of the other lock is not a second lock.
    const boot = remoteBootFor(asRequest(fromBridge('</script><script>alert(1)//')), null)
    expect(boot).not.toContain('</script><script>')
  })
})
