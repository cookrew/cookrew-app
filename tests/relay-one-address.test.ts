import { describe, expect, it } from 'vitest'
import {
  MACHINE_RELAY_PREFIX,
  RELAY_MACHINE_HEADER,
  RELAY_ROUTE_HEADER,
  RELAY_ROUTE_MAX,
  relayAtOneAddress,
  relayPathFromHeaders
} from '../src/shared/machine-relay'

/**
 * ONE ADDRESS FOR EVERY RELAYED CALL A PAGE MAKES (latency 0.6.1).
 *
 * The console sends the account session in a header, so a browser preflights
 * each relayed request and keeps the answer PER URL. Measured on the console
 * stage: 30 preflights in 20 s inside one machine, one round trip each (~405 ms
 * from the owner's Mac). At one address the browser asks once.
 *
 * Both halves of the rule are here: how a page folds a relay URL into the one
 * address and two headers, and how the registry unfolds the headers into the
 * path it has always checked, refusing whatever the path form would refuse.
 */

const API = 'https://api.cookrew.dev'
const M = '7200b968-70b6-8d4d-bb3a-1c7b2f18b479'

describe('a page folding a relayed call into the one address', () => {
  it('moves the machine and the route, query and all, into two headers', () => {
    expect(relayAtOneAddress(`${API}/api/m/${M}/api/terminal/t1/turns?after=5&limit=20`, API)).toEqual({
      url: `${API}${MACHINE_RELAY_PREFIX}`,
      headers: { [RELAY_MACHINE_HEADER]: M, [RELAY_ROUTE_HEADER]: 'api/terminal/t1/turns?after=5&limit=20' }
    })
  })

  it('gives every route of every machine the same address, which is the point', () => {
    const urls = [`${API}/api/m/${M}/api/fleet`, `${API}/api/m/${M}/api/watch/cards?workspace=w1`, `${API}/api/m/${M.replace('7200', '9999')}/~seal/hello`]
    expect(new Set(urls.map((url) => relayAtOneAddress(url, API)?.url))).toEqual(new Set([`${API}/api/m`]))
  })

  it('writes the route as a URL has it: encoded, so a header can always carry it', () => {
    const folded = relayAtOneAddress(`${API}/api/m/${M}/api/attachments?name=été café.png`, API)
    expect(folded?.headers[RELAY_ROUTE_HEADER]).toBe('api/attachments?name=%C3%A9t%C3%A9%20caf%C3%A9.png')
    expect(/^[\x21-\x7e]+$/.test(folded?.headers[RELAY_ROUTE_HEADER] ?? '')).toBe(true)
  })

  it('leaves the fragment behind, as a request does', () => {
    expect(relayAtOneAddress(`${API}/api/m/${M}/api/fleet#x`, API)?.headers[RELAY_ROUTE_HEADER]).toBe('api/fleet')
  })

  it('lowercases the machine, as the registry keeps it', () => {
    expect(relayAtOneAddress(`${API}/api/m/${M.toUpperCase()}/api/fleet`, API)?.headers[RELAY_MACHINE_HEADER]).toBe(M)
  })

  it('folds nothing that is not a relayed call to a machine of this API', () => {
    for (const url of [
      `${API}/v2/me/desktops`,
      `https://evil.example/api/m/${M}/api/fleet`,
      `${API}/api/m/not-a-machine/api/fleet`,
      `${API}/api/m/${M}`,
      `${API}/api/m/${M}/index.html`,
      `${API}/api/m/${M}/apiary`,
      `${API}/api/m/${M}/api/x%2F..%2Fsecrets`,
      'https://192-168-2-40.abc.d.cookrew.dev:8643/api/fleet',
      '/api/fleet',
      'not a url'
    ]) {
      expect(relayAtOneAddress(url, API), url).toBeNull()
    }
  })
})

describe('the registry unfolding the two headers', () => {
  it('builds the very path the path form would have had', () => {
    expect(relayPathFromHeaders(M, 'api/terminal/t1/turns?after=5')).toBe(`/api/m/${M}/api/terminal/t1/turns?after=5`)
    expect(relayPathFromHeaders(M, '/api/fleet')).toBe(`/api/m/${M}/api/fleet`)
    expect(relayPathFromHeaders(M.toUpperCase(), '~seal/hello')).toBe(`/api/m/${M}/~seal/hello`)
  })

  it('refuses what the path form refuses, and what a header should never hold', () => {
    const refused: [unknown, unknown][] = [
      [undefined, 'api/fleet'],
      [M, undefined],
      [['a', 'b'], 'api/fleet'],
      [M, ['api/fleet', 'api/x']],
      ['not-a-machine', 'api/fleet'],
      [M, ''],
      [M, 'index.html'],
      [M, 'api/../v2/me'],
      [M, 'api/./fleet'],
      [M, 'api/x%2F..%2Fsecrets'],
      [M, 'api/%2e%2e/secrets'],
      [M, 'api\\..\\secrets'],
      [M, 'api/fleet#frag'],
      [M, 'api/fleet with space'],
      [M, 'api/café'],
      [M, `api/${'x'.repeat(RELAY_ROUTE_MAX)}`]
    ]
    for (const [machine, route] of refused) {
      expect(relayPathFromHeaders(machine, route), `${String(machine)} ${String(route).slice(0, 40)}`).toBeNull()
    }
  })
})
