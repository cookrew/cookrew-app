// WITHIN A TIER, THE FASTEST ANSWER WINS. ACROSS TIERS, NOTHING CHANGES.
//
// A Mac with a virtual-machine bridge, or two interfaces on the same Wi-Fi,
// publishes two LAN names. Today the first one to verify wins, and "first" is
// whatever order the card happened to list — so a phone can settle for a
// session on a bridged interface that answers in 90 ms while the real Wi-Fi
// address answers in 6 ms, and never look again, because only-better means a
// LAN plane is not an improvement on a LAN plane.
//
// Tailscale made this same move: away from a hardcoded preference order and
// onto measured round trip, reporting that it "tends to result in the same
// LAN > WAN > WAN+NAT ordering" anyway. The tier order stays absolute here for
// the reason it always was — the relay bills for egress, and a tailnet hop is
// the same house through an encrypted overlay, so neither is a matter of
// speed. RFC 8305 is the shape of the rest: measure, prefer, do not re-probe.
//
// ONE MEASUREMENT PER CANDIDATE. It is enough to break a tie, and a second
// probe would cost a phone on battery more than the tie is worth.

import { describe, expect, it } from 'vitest'
import {
  switchPlaneIfBetter,
  type PlaneOutcome,
  type PlaneSwitchDeps
} from '../src/renderer/src/path/plane-switch'
import type { DataPlane } from '../src/renderer/src/data-plane'
import type { ReachCardLite } from '../src/renderer/src/path/switch'

const DEVICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const BRIDGE = `https://192-168-1-24.${DEVICE}.d.cookrew.dev:8643`
const WIFI = `https://10-0-0-9.${DEVICE}.d.cookrew.dev:8643`
const TAILNET = `https://100-68-81-64.${DEVICE}.d.cookrew.dev:8643`
const RELAY: DataPlane = { origin: '', kind: 'relay' }

interface Run {
  readonly outcome: PlaneOutcome
  readonly adopted: DataPlane | null
  readonly asked: readonly string[]
  readonly verified: readonly string[]
}

/**
 * A VIRTUAL CLOCK THAT CAN REPRESENT TWO PROBES AT ONCE.
 *
 * The candidates in a tier are probed together, so a single counter that each
 * hello adds to would measure them as a queue and prove nothing. Instead every
 * probe starts at 0 and resolves after as many microtasks as it costs
 * milliseconds — the two chains interleave one tick at a time, so they finish
 * in cost order — and each sets the clock to its own cost as it lands.
 */
const ticks = async (count: number): Promise<void> => {
  for (let i = 0; i < count; i += 1) await Promise.resolve()
}

/**
 * A race whose clock is a script: each origin costs exactly the number of
 * milliseconds given, so the ordering under test is the only variable.
 */
const race = async (
  costs: Record<string, number>,
  over: Partial<PlaneSwitchDeps> & { readonly trusted?: readonly string[] } = {}
): Promise<Run> => {
  const asked: string[] = []
  const verified: string[] = []
  let adopted: DataPlane | null = null
  let clock = 0
  const deps: PlaneSwitchDeps = {
    plane: () => RELAY,
    card: async (): Promise<ReachCardLite> => ({
      deviceId: DEVICE,
      lan: [],
      tailnet: null,
      trusted: over.trusted ?? [BRIDGE, WIFI, TAILNET]
    }),
    hello: async (origin, nonce) => {
      asked.push(origin)
      const cost = costs[origin]
      // A candidate with no cost is one that never answers: the verdict shape
      // askHello gives a timeout, rather than the old undifferentiated null.
      if (cost === undefined) return { ok: false, kind: 'timeout', ms: 800 }
      await ticks(cost)
      clock = cost
      return {
        ok: true,
        reply: { v: 2, deviceId: DEVICE, nonce, sig: `sig:${origin}`, origin, issuedAtMs: Date.now() }
      }
    },
    verify: async (claim) => {
      verified.push(claim.sig)
      return claim.sig !== 'sig:refused'
    },
    adopt: (plane) => void (adopted = plane),
    nonce: () => 'a-nonce',
    now: () => clock,
    ...over
  }
  const outcome = await switchPlaneIfBetter(deps)
  return { outcome, adopted, asked, verified }
}

describe('ordering within a tier', () => {
  it('takes the fastest LAN address, not the first one the card listed', async () => {
    const run = await race({ [BRIDGE]: 90, [WIFI]: 6 })
    expect(run.outcome).toBe('switched')
    expect(run.adopted).toEqual({ origin: WIFI, kind: 'lan' })
    // Both LAN names were measured — that is the whole cost of the rule, and
    // it is one probe each.
    expect(run.asked).toEqual([BRIDGE, WIFI])
  })

  it('measures each candidate exactly once', async () => {
    const run = await race({ [BRIDGE]: 90, [WIFI]: 6 })
    expect(new Set(run.asked).size).toBe(run.asked.length)
  })

  it('keeps the card’s order when the measurements are equal', async () => {
    const run = await race({ [BRIDGE]: 20, [WIFI]: 20 })
    expect(run.adopted).toEqual({ origin: BRIDGE, kind: 'lan' })
  })

  it('asks the registry about the fastest first, and only about it', async () => {
    const run = await race({ [BRIDGE]: 90, [WIFI]: 6 })
    expect(run.verified).toEqual([`sig:${WIFI}`])
  })

  it('falls to the next-fastest in the SAME tier when the registry says no', async () => {
    // A name that answers fast but cannot prove itself must not push the phone
    // down a tier — the other LAN address is still better than the tailnet.
    const run = await race({ [BRIDGE]: 90, [WIFI]: 6 }, {
      hello: async (origin, nonce) =>
        origin === WIFI
          ? {
              ok: true,
              reply: { v: 2, deviceId: DEVICE, nonce, sig: 'sig:refused', origin, issuedAtMs: Date.now() }
            }
          : origin === BRIDGE
            ? {
                ok: true,
                reply: { v: 2, deviceId: DEVICE, nonce, sig: `sig:${origin}`, origin, issuedAtMs: Date.now() }
              }
            : { ok: false, kind: 'timeout', ms: 800 },
      verify: async (claim) => claim.sig !== 'sig:refused'
    })
    expect(run.adopted).toEqual({ origin: BRIDGE, kind: 'lan' })
  })
})

describe('the tier order is still absolute', () => {
  it('prefers a slow LAN address over a fast tailnet one', async () => {
    // The tailnet is the same house through an encrypted overlay and the relay
    // bills for egress. Neither is a matter of milliseconds.
    const run = await race({ [BRIDGE]: 400, [TAILNET]: 3 })
    expect(run.adopted).toEqual({ origin: BRIDGE, kind: 'lan' })
    // And the tailnet was never even probed, because the LAN tier settled it.
    expect(run.asked).not.toContain(TAILNET)
  })

  it('orders within the tailnet tier too, once the LAN tier is empty', async () => {
    const TAILNET2 = `https://100-68-81-99.${DEVICE}.d.cookrew.dev:8643`
    const run = await race({ [TAILNET]: 40, [TAILNET2]: 9 }, {
      trusted: [TAILNET, TAILNET2]
    })
    expect(run.adopted).toEqual({ origin: TAILNET2, kind: 'tailnet' })
  })

  it('still walks down to the tailnet when no LAN name answers', async () => {
    const run = await race({ [TAILNET]: 40 })
    expect(run.adopted).toEqual({ origin: TAILNET, kind: 'tailnet' })
    expect(run.asked).toEqual([BRIDGE, WIFI, TAILNET])
  })
})
