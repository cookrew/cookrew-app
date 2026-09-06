import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DNS_CLASS_IN, DNS_TYPE, RCODE } from '../registry/src/dns-wire'
import { createNames, type NamesFeature } from '../registry/src/names'
import type { AcmeClient } from '../registry/src/acme-client'
import type { V2Desktop } from '../registry/src/v2-accounts'
import { ecPair, makeCsr } from './support/x509-forge'

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

/**
 * H4 — HOW MANY CA CONVERSATIONS AT ONCE, AND HOW MANY A WEEK.
 *
 * Nothing above `run` queued: the route answers 202 and the order runs behind
 * it, so twenty Macs coming back from a rollout at the same moment were twenty
 * simultaneous ACME orders. And nothing counted the total: the per-device
 * limits are limits on a device, while the ceiling that matters is Let's
 * Encrypt's fifty new certificates per registered domain per week — the same
 * allowance cookrew.dev's own certificate is renewed out of.
 */
describe('orders, in flight and in total', () => {
  const now = 1_757_000_000_000

  interface Watched {
    names: NamesFeature
    peak: () => number
    started: () => number
    settled: () => Promise<void>
  }

  /** A CA that does nothing but take its time and count who is inside it. */
  const watched = (over: { weeklyBudget?: number; concurrency?: number; holdMs?: number } = {}): Watched => {
    let inside = 0
    let peak = 0
    let started = 0
    let live: Promise<unknown>[] = []
    const acme = {
      issue: (): Promise<{ ok: false; reason: 'server'; detail: string }> => {
        inside += 1
        started += 1
        peak = Math.max(peak, inside)
        const held = new Promise<{ ok: false; reason: 'server'; detail: string }>((resolve) =>
          setTimeout(() => {
            inside -= 1
            resolve({ ok: false, reason: 'server', detail: 'the CA is busy' })
          }, over.holdMs ?? 60)
        )
        live.push(held)
        return held
      }
    }
    const names = createNames({
      zone: ZONE,
      ns: [{ host: `ns1.${ZONE}`, address: '203.0.113.10' }],
      dataDir: dir(),
      desktops: { find: () => null, changedAt: () => now },
      acme: acme as unknown as AcmeClient,
      now: () => now,
      ...(over.weeklyBudget === undefined ? {} : { weeklyBudget: over.weeklyBudget }),
      ...(over.concurrency === undefined ? {} : { concurrency: over.concurrency })
    })
    return {
      names,
      peak: () => peak,
      started: () => started,
      settled: async () => {
        for (let attempt = 0; attempt < 200 && (live.length > 0 || inside > 0); attempt += 1) {
          const held = live
          live = []
          await Promise.all(held)
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
    }
  }

  const macs = (count: number): { id: string; csr: string }[] =>
    Array.from({ length: count }, (_, i) => {
      const id = `abcd1234-aaaa-bbbb-cccc-${String(i).padStart(12, '0')}`
      return { id, csr: makeCsr({ pair: ecPair(), names: [`*.${id}.${ZONE}`] }) }
    })

  it('never has more than three orders with the CA at once', async () => {
    const site = watched({ holdMs: 80 })
    for (const mac of macs(9)) {
      expect(site.names.request(mac.id, mac.csr)).toMatchObject({ ok: true, status: 'pending' })
    }
    await site.settled()
    expect(site.started()).toBe(9)
    // The whole point: nine Macs, three conversations.
    expect(site.peak()).toBeLessThanOrEqual(3)
    expect(site.peak()).toBeGreaterThan(1)
  })

  it('waits its turn rather than dropping the order', async () => {
    const site = watched({ concurrency: 1, holdMs: 20 })
    const queued = macs(4)
    for (const mac of queued) site.names.request(mac.id, mac.csr)
    await site.settled()
    expect(site.peak()).toBe(1)
    // Every one of them ran and every one of them recorded its outcome, so a
    // Mac polling never sits on a `pending` that nothing is working on.
    for (const mac of queued) expect(site.names.state(mac.id).status).toBe('failed')
  })

  it('refuses past the registry’s weekly budget, with a retry-after', async () => {
    const site = watched({ weeklyBudget: 4, holdMs: 5 })
    const asking = macs(6)
    const answers = asking.map((mac) => site.names.request(mac.id, mac.csr))
    expect(answers.filter((one) => one.ok).length).toBe(4)
    const refused = answers.filter((one) => !one.ok)
    expect(refused).toHaveLength(2)
    for (const one of refused) {
      expect(one).toMatchObject({ ok: false, code: 429, error: 'rate_limited' })
      if (!one.ok && one.code === 429) expect(one.retryAfter).toBeGreaterThan(0)
    }
    await site.settled()
    // And the CA was never asked about the two that were refused.
    expect(site.started()).toBe(4)
  })
})
