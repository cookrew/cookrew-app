// THE SWITCH THAT MOVES THE DATA AND LEAVES THE PAGE ALONE.
//
// Under the relay base the companion may not navigate — that is pinned in
// companion-relay-no-jump.test.ts and it is the whole reason this module
// exists. What is tested here is every way the replacement can go wrong
// quietly, because none of them raises an error and all of them look fine:
//
//   racing a bare IP, which from a page on cookrew.dev is a certificate
//   warning at best and a silent failure at worst;
//
//   adopting whatever answered on 8643, which is a phone sending its pairing
//   token to something that is not the Mac;
//
//   adopting an address that says the right words but cannot prove them —
//   every trusted name is signed by the same public CA, so the browser's own
//   check no longer distinguishes the Mac from anything else under
//   d.cookrew.dev. Only the registry can, and only with the signature.

import { describe, expect, it } from 'vitest'
import {
  PLANE_PROBE_EVERY_MS,
  planeCandidates,
  planeRank,
  switchPlaneIfBetter,
  type PlaneOutcome,
  type PlaneSwitchDeps
} from '../src/renderer/src/path/plane-switch'
import { trustedNetwork } from '../src/shared/trusted-origin'
import type { DataPlane } from '../src/renderer/src/data-plane'
import type { ReachCardLite } from '../src/renderer/src/path/switch'

const DEVICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const LAN = `https://192-168-1-24.${DEVICE}.d.cookrew.dev:8643`
const LAN2 = `https://10-0-0-9.${DEVICE}.d.cookrew.dev:8643`
const TAILNET = `https://100-68-81-64.${DEVICE}.d.cookrew.dev:8643`
const TAILNET6 = `https://fd7a-115c-a1e0-ab12--1.${DEVICE}.d.cookrew.dev:8643`
const BARE_LAN = 'https://192.168.1.24:8643'

const RELAY: DataPlane = { origin: '', kind: 'relay' }
const NOW = 1_800_000_000_000

const card = (over: Partial<ReachCardLite> = {}): ReachCardLite => ({
  deviceId: DEVICE,
  lan: [{ url: BARE_LAN }],
  tailnet: { url: 'https://100.68.81.64:8643' },
  trusted: [LAN, TAILNET],
  ...over
})

interface Run {
  readonly outcome: () => PlaneOutcome
  readonly adopted: () => DataPlane | null
  readonly asked: () => readonly string[]
  readonly verified: () => number
  readonly probes: () => readonly boolean[]
}

/** One race, with everything the browser would have supplied stood in for. */
const race = async (
  over: Partial<PlaneSwitchDeps> & {
    readonly answers?: Record<string, string>
    readonly signatures?: Record<string, string>
  } = {}
): Promise<Run> => {
  const asked: string[] = []
  const probes: boolean[] = []
  let adopted: DataPlane | null = null
  let verified = 0
  let nonces = 0
  const answers = over.answers ?? { [LAN]: DEVICE, [TAILNET]: DEVICE }

  const deps: PlaneSwitchDeps = {
    plane: over.plane ?? ((): DataPlane => RELAY),
    card: over.card ?? (async () => card()),
    hello:
      over.hello ??
      (async (origin, nonce) => {
        asked.push(origin)
        const who = answers[origin]
        // A version 2 answer: the Mac names the endpoint it answered at.
        return who === undefined
          ? null
          : { v: 2, deviceId: who, origin, issuedAtMs: NOW, nonce, sig: 'a-signature' }
      }),
    verify:
      over.verify ??
      (async (claim) => {
        verified += 1
        return claim.sig === 'a-signature'
      }),
    adopt: over.adopt ?? ((plane) => void (adopted = plane)),
    nonce: over.nonce ?? ((): string => `nonce-${(nonces += 1)}`),
    ...(over.held ? { held: over.held } : {}),
    probing: over.probing ?? ((on) => void probes.push(on))
  }
  const outcome = await switchPlaneIfBetter(deps)
  return {
    outcome: () => outcome,
    adopted: () => adopted,
    asked: () => asked,
    verified: () => verified,
    probes: () => probes
  }
}

describe('reading a network off a trusted name', () => {
  it('finds the address in the leftmost label, where the registry put it', () => {
    expect(trustedNetwork(LAN)).toBe('lan')
    expect(trustedNetwork(LAN2)).toBe('lan')
    expect(trustedNetwork(TAILNET)).toBe('tailnet')
    // Tailscale's ULA block survives the colons-to-dashes round trip.
    expect(trustedNetwork(TAILNET6)).toBe('tailnet')
  })

  it('refuses a bare IP however the card describes it', () => {
    // No public CA will ever vouch for one, so an origin like this raced from
    // a page on cookrew.dev produces a warning or nothing at all.
    expect(trustedNetwork(BARE_LAN)).toBe(null)
    expect(trustedNetwork('https://[fd7a:115c:a1e0::1]:8643')).toBe(null)
  })

  it('refuses a name whose first label is not an address', () => {
    expect(trustedNetwork(`https://api.${DEVICE}.d.cookrew.dev`)).toBe(null)
    expect(trustedNetwork('https://cookrew.dev')).toBe(null)
    expect(trustedNetwork('not a url')).toBe(null)
  })
})

describe('which origins are raced', () => {
  it('is card.trusted and nothing else — lan[] is for the navigating switch', () => {
    expect(planeCandidates(card(), 'relay')).toEqual([
      { origin: LAN, kind: 'lan' },
      { origin: TAILNET, kind: 'tailnet' }
    ])
    // The bare-IP addresses are still on the card and are still ignored here.
    expect(planeCandidates(card(), 'relay').map((c) => c.origin)).not.toContain(BARE_LAN)
  })

  it('offers nothing at all when the Mac holds no certificates yet', () => {
    // No account, no internet, issuance not done. An empty list means "no
    // live switch today", never a fall back to an address a browser refuses.
    expect(planeCandidates(card({ trusted: [] }), 'relay')).toEqual([])
    expect(planeCandidates(card({ trusted: undefined }), 'relay')).toEqual([])
  })

  it('puts the LAN ahead of the tailnet however the card orders them', () => {
    const shuffled = card({ trusted: [TAILNET, LAN2, LAN] })
    expect(planeCandidates(shuffled, 'relay').map((c) => c.kind)).toEqual([
      'lan',
      'lan',
      'tailnet'
    ])
  })

  it('offers only what beats the plane the phone is already on', () => {
    expect(planeCandidates(card(), 'tailnet')).toEqual([{ origin: LAN, kind: 'lan' }])
    expect(planeCandidates(card(), 'lan')).toEqual([])
    expect(planeRank('lan')).toBeGreaterThan(planeRank('tailnet'))
    expect(planeRank('tailnet')).toBeGreaterThan(planeRank('relay'))
  })

  it('drops a duplicate rather than probing the same origin twice', () => {
    expect(planeCandidates(card({ trusted: [LAN, `${LAN}/`] }), 'relay')).toEqual([
      { origin: LAN, kind: 'lan' }
    ])
  })
})

describe('one race', () => {
  it('SETS THE PLANE — it does not navigate, and there is nowhere for it to', async () => {
    const run = await race()
    expect(run.outcome()).toBe('switched')
    expect(run.adopted()).toEqual({ origin: LAN, kind: 'lan' })
    // The LAN answered, so the tailnet was never asked.
    expect(run.asked()).toEqual([LAN])
    // No `go`, no URL, no token in a query string: the deps have no way to
    // navigate, which is the design and not an omission.
    expect(Object.keys(run)).not.toContain('went')
  })

  it('says PROBING while it looks, and stops saying it when it is done', async () => {
    const run = await race({ answers: {} })
    expect(run.outcome()).toBe('unreachable')
    expect(run.probes()).toEqual([true, false])
  })

  it('does nothing from the LAN — there is no better plane', async () => {
    const run = await race({ plane: () => ({ origin: LAN, kind: 'lan' }) })
    expect(run.outcome()).toBe('skipped')
    expect(run.asked()).toEqual([])
  })

  it('falls through to the tailnet when the LAN name does not answer', async () => {
    const run = await race({ answers: { [TAILNET]: DEVICE } })
    expect(run.outcome()).toBe('switched')
    expect(run.asked()).toEqual([LAN, TAILNET])
    expect(run.adopted()).toEqual({ origin: TAILNET, kind: 'tailnet' })
  })

  it('refuses an address that answers as somebody else', async () => {
    const run = await race({ answers: { [LAN]: 'a-different-mac', [TAILNET]: DEVICE } })
    expect(run.adopted()).toEqual({ origin: TAILNET, kind: 'tailnet' })
  })

  it('refuses a replayed answer, however right the device id is', async () => {
    const run = await race({
      hello: async (origin, nonce) =>
        origin === LAN
          ? { v: 2, deviceId: DEVICE, origin, issuedAtMs: NOW, nonce: 'a-nonce-from-yesterday', sig: 'a-signature' }
          : { v: 2, deviceId: DEVICE, origin, issuedAtMs: NOW, nonce, sig: 'a-signature' }
    })
    expect(run.adopted()).toEqual({ origin: TAILNET, kind: 'tailnet' })
  })

  it('refuses an answer the registry will not vouch for', async () => {
    // The whole of the new gate. Every trusted name is signed by the same
    // public CA, so the browser connecting proves only that SOMETHING under
    // d.cookrew.dev answered.
    const run = await race({ verify: async () => false })
    expect(run.outcome()).toBe('unreachable')
    expect(run.adopted()).toBe(null)
  })

  it('refuses an answer with no signature at all, without asking the registry', async () => {
    const run = await race({
      hello: async (origin, nonce) => ({ v: 2, deviceId: DEVICE, origin, issuedAtMs: NOW, nonce })
    })
    expect(run.outcome()).toBe('unreachable')
    expect(run.verified()).toBe(0)
  })

  it('stays on the relay when the registry cannot be reached', async () => {
    // Offline, rate limited, signed out. An unfinished verification is a no.
    const run = await race({ verify: () => Promise.reject(new Error('offline')) })
    expect(run.outcome()).toBe('unreachable')
    expect(run.adopted()).toBe(null)
  })

  it('stays where it is when the desktop cannot be asked', async () => {
    const run = await race({ card: async () => null })
    expect(run.outcome()).toBe('no-card')
    expect(run.asked()).toEqual([])
  })

  it('survives a desktop that throws rather than answers', async () => {
    const run = await race({ card: () => Promise.reject(new Error('the link went down')) })
    expect(run.outcome()).toBe('no-card')
  })

  it('says so, and probes nothing, when the Mac holds no trusted names', async () => {
    const run = await race({ card: async () => card({ trusted: [] }) })
    expect(run.outcome()).toBe('no-trusted')
    expect(run.asked()).toEqual([])
  })

  it('does not re-adopt a plane it has just fallen back from', async () => {
    // The Mac may well still answer /api/hello from the network it is on; the
    // hold is what stops the badge blinking LAN, RELAY, LAN forever.
    const run = await race({ held: () => true })
    expect(run.outcome()).toBe('skipped')
    expect(run.asked()).toEqual([])
  })
})

describe('the schedule', () => {
  it('is slower than the navigating switcher, because it is not racing a page load', () => {
    expect(PLANE_PROBE_EVERY_MS).toBe(60_000)
  })
})
