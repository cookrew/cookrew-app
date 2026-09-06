import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DNS_CLASS_IN, DNS_TYPE, RCODE } from '../registry/src/dns-wire'
import { createNames, type NamesFeature } from '../registry/src/names'
import type { AcmeClient } from '../registry/src/acme-client'
import type { V2Desktop } from '../registry/src/v2-accounts'

/**
 * THE NAMES HALF, WITH THE STORE AND THE CA BOTH IN THE TEST'S HANDS.
 *
 * The end-to-end file drives the real thing through real sockets; this one
 * drives the parts of it a real CA and a real clock make unreachable — a card
 * dated in the future, and more orders at once than Let's Encrypt's shared
 * ceilings will bear.
 */

const ZONE = 'd.cookrew.dev'
const MAC = 'abcd1234-aaaa-bbbb-cccc-000000000001'
const DAY = 24 * 60 * 60 * 1000

const dirs: string[] = []
afterAll(() => {
  for (const one of dirs) rmSync(one, { recursive: true, force: true })
})

const dir = (): string => {
  const made = mkdtempSync(path.join(tmpdir(), 'names-orders-'))
  dirs.push(made)
  return made
}

const desktop = (over: { at: string; updatedAt: number }): V2Desktop => ({
  deviceId: MAC,
  name: 'MacBook Pro',
  workspaces: [],
  reach: {
    lan: [{ url: 'https://192.168.2.40:8643', certFp: 'a'.repeat(64) }],
    tailnet: null,
    relay: true,
    at: over.at,
    sig: 'x'.repeat(32)
  },
  updatedAt: over.updatedAt
})

const askA = (names: NamesFeature, name: string): number =>
  names.respond({ name, type: DNS_TYPE.A, class: DNS_CLASS_IN }).rcode

/**
 * M1 — FRESHNESS IS THE REGISTRY'S CLOCK, NOT THE CARD'S.
 *
 * The zone drops a card older than the reach TTL so an unplugged Mac stops
 * pointing a public name into whoever's network now holds that address. It
 * measured that age against the `at` the DESKTOP wrote, which the desktop
 * chooses: a card dated 2099 is never stale, and a machine that has been off
 * for a month keeps its name for seventy-odd years. The server-stamped
 * updatedAt from putDesktop is the half nobody but this registry can move.
 */
describe('a card dated in the future', () => {
  const now = 1_757_000_000_000

  const namesWith = (held: V2Desktop): NamesFeature =>
    createNames({
      zone: ZONE,
      ns: [{ host: `ns1.${ZONE}`, address: '203.0.113.10' }],
      dataDir: dir(),
      desktops: { find: (id) => (id === MAC ? held : null), changedAt: () => now },
      acme: {} as AcmeClient,
      now: () => now
    })

  it('does not keep a name alive for a Mac that stopped publishing', () => {
    const names = namesWith(desktop({ at: '2099-01-01T00:00:00.000Z', updatedAt: now - 40 * DAY }))
    expect(askA(names, `192-168-2-40.${MAC}.${ZONE}`)).toBe(RCODE.NXDOMAIN)
  })

  it('still answers for a Mac that published one minute ago, whatever it dated the card', () => {
    const fresh = namesWith(desktop({ at: '2099-01-01T00:00:00.000Z', updatedAt: now - 60_000 }))
    expect(askA(fresh, `192-168-2-40.${MAC}.${ZONE}`)).toBe(RCODE.NOERROR)
    // And the ordinary case is untouched: a card written now, PUT now.
    const ordinary = namesWith(desktop({ at: new Date(now).toISOString(), updatedAt: now }))
    expect(askA(ordinary, `192-168-2-40.${MAC}.${ZONE}`)).toBe(RCODE.NOERROR)
  })

  it('drops a card the desktop itself dated a month ago, as it always did', () => {
    const names = namesWith(desktop({ at: new Date(now - 40 * DAY).toISOString(), updatedAt: now }))
    expect(askA(names, `192-168-2-40.${MAC}.${ZONE}`)).toBe(RCODE.NXDOMAIN)
  })
})
