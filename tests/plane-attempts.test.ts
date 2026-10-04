// THE RACE WRITES DOWN WHAT IT TRIED.
//
// The panel is only as honest as this. Three things it has to get right:
//
//   THE NAME IS AN ADDRESS. `192-168-1-24.<deviceId>.d.cookrew.dev` carries a
//   permanent device identifier in a label; the row says 192.168.1.24:8643,
//   which is the fact a reader can act on and nothing else.
//
//   A CANDIDATE BLOCKED BY THE BROWSER IS NOT A CANDIDATE THAT DID NOT ANSWER.
//   Both arrive as the same TypeError, so the only way to tell them apart is
//   to ask the permission store again afterwards: a race that ran under
//   'prompt' and finds itself 'denied' was refused, not ignored.
//
//   NOTHING IS INVENTED. A race blocked before it started reports no rows at
//   all, rather than rows claiming addresses were tried.

import { describe, expect, it } from 'vitest'
import {
  switchPlaneIfBetter,
  type PlaneAttempt,
  type PlaneSwitchDeps
} from '../src/renderer/src/path/plane-switch'
import type { LocalNetworkState } from '../src/renderer/src/local-network'
import type { DataPlane } from '../src/renderer/src/path/../data-plane'
import type { ReachCardLite } from '../src/renderer/src/path/switch'

const DEVICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const LAN = `https://192-168-1-24.${DEVICE}.d.cookrew.dev:8643`
const TAILNET = `https://100-68-81-64.${DEVICE}.d.cookrew.dev:8643`
const RELAY: DataPlane = { origin: '', kind: 'relay' }

const race = async (
  over: Partial<PlaneSwitchDeps> & { readonly answers?: Record<string, boolean> } = {}
): Promise<readonly PlaneAttempt[]> => {
  let noted: readonly PlaneAttempt[] | null = null
  const answers = over.answers ?? { [LAN]: true, [TAILNET]: true }
  const deps: PlaneSwitchDeps = {
    plane: () => RELAY,
    card: async (): Promise<ReachCardLite> => ({
      deviceId: DEVICE,
      lan: [],
      tailnet: null,
      trusted: [LAN, TAILNET]
    }),
    hello: async (origin, nonce) =>
      answers[origin]
        ? {
            ok: true,
            reply: { v: 2, deviceId: DEVICE, nonce, sig: 'a-signature', origin, issuedAtMs: Date.now() }
          }
        : { ok: false, kind: 'blocked', ms: 1, detail: 'TypeError: Failed to fetch' },
    verify: async () => true,
    adopt: () => undefined,
    nonce: () => 'a-nonce',
    now: () => 0,
    note: (attempts) => void (noted = attempts),
    ...over
  }
  await switchPlaneIfBetter(deps)
  return noted ?? []
}

describe('what the race writes down', () => {
  it('names the address the label spells, never the label', async () => {
    const noted = await race()
    expect(noted[0].name).toBe('192.168.1.24:8643')
    expect(noted[0].name).not.toContain(DEVICE)
  })

  it('records the winner as answered, on the plane it became', async () => {
    const noted = await race()
    expect(noted[0].outcome).toBe('answered')
    expect(noted[0].plane).toBe('LAN')
    expect(noted[0].chosen).toBe(true)
  })

  it('records a silent candidate BY THE REASON IT WAS SILENT, with its time', async () => {
    // This is the row the owner saw four of. It used to read 'no-answer' for
    // every failure there is; it now carries the probe's own verdict — here a
    // TypeError back in a millisecond, which is a browser refusing before it
    // connected — and the browser's own words with it.
    const noted = await race({ answers: { [TAILNET]: true } })
    const lan = noted.find((row) => row.name.startsWith('192.168'))
    expect(lan?.outcome).toBe('blocked')
    expect(lan?.ms).toBe(1)
    expect(lan?.detail).toBe('TypeError: Failed to fetch')
    expect(lan?.chosen).toBe(false)
  })

  it('records an answer the registry refused as not verified, with its time', async () => {
    const noted = await race({ verify: async () => false })
    expect(noted[0].outcome).toBe('unverified')
    expect(noted[0].ms).toBe(0)
    expect(noted.every((row) => row.chosen === false)).toBe(true)
  })

  it('records a tier that was never reached as nothing, not as a failure', async () => {
    // The LAN settled it; the tailnet was not tried and must not be listed as
    // having failed.
    const noted = await race()
    expect(noted).toHaveLength(1)
  })

  it('calls a blocked probe refused, once the permission store says so', async () => {
    // The race began under 'prompt' — a person pressed ALLOW — and the dialog
    // was dismissed. The probes all failed and the permission is now denied,
    // which is the ONLY way to tell this apart from a sleeping Mac.
    const states: LocalNetworkState[] = ['prompt', 'denied']
    let asked = 0
    const noted = await race({
      answers: {},
      mayPrompt: () => true,
      permission: async () => states[Math.min(asked++, states.length - 1)]
    })
    expect(noted.map((row) => row.outcome)).toEqual(['refused', 'refused'])
  })

  it("leaves the probe's own verdict alone when the permission is fine", async () => {
    // The upgrade to 'refused' is the permission store settling a GUESS. With
    // the permission granted there is nothing to settle, and overwriting the
    // kind would throw away the only diagnosis the panel has.
    const noted = await race({ answers: {}, permission: async () => 'granted' })
    expect(noted.map((row) => row.outcome)).toEqual(['blocked', 'blocked'])
  })

  it('writes an empty list when the race never started, rather than a lie', async () => {
    // Only a LAN name on the card, so a refusal leaves nothing raceable. (A
    // CGNAT tailnet name would still be raced — the permission does not cover
    // it; see local-network-policy.test.ts.)
    const noted = await race({
      permission: async () => 'denied',
      card: async (): Promise<ReachCardLite> => ({
        deviceId: DEVICE,
        lan: [],
        tailnet: null,
        trusted: [LAN]
      })
    })
    expect(noted).toEqual([])
  })
})

describe('what the race writes down once it can ask the zone', () => {
  // 2026-10-04: every LAN candidate died in 4 ms with "TypeError: Load
  // failed" and the row said "refused by the browser before connecting". The
  // name was NXDOMAIN. The stopwatch cannot tell those apart; the zone can.
  const blocked = (ms = 4) => ({ ok: false as const, kind: 'blocked' as const, ms, detail: 'TypeError: Load failed' })
  const network = () => ({ ok: false as const, kind: 'network' as const, ms: 263, detail: 'TypeError: Load failed' })

  it('calls a fast failure on a name the zone is not answering UNNAMED, not refused', async () => {
    const asked: string[] = []
    const noted = await race({
      hello: async () => blocked(),
      named: async (origin) => {
        asked.push(origin)
        return 'dead'
      }
    })
    expect(noted.map((row) => row.outcome)).toEqual(['unnamed', 'unnamed'])
    expect(noted[0].ms).toBe(4)
    // The browser's words are dropped: the sentence is now about the name.
    expect(noted[0].detail).toBeUndefined()
    expect(noted[0].hint).toBeUndefined()
    expect(asked.sort()).toEqual([LAN, TAILNET].sort())
  })

  it('keeps BLOCKED only when the zone confirms the name is live', async () => {
    const noted = await race({ hello: async () => blocked(), named: async () => 'live' })
    expect(noted.map((row) => row.outcome)).toEqual(['blocked', 'blocked'])
    expect(noted[0].detail).toBe('TypeError: Load failed')
  })

  it('will not claim a refusal it could not confirm: unknown downgrades blocked to network', async () => {
    const noted = await race({ hello: async () => blocked(), named: async () => 'unknown' })
    expect(noted.map((row) => row.outcome)).toEqual(['network', 'network'])
  })

  it('calls a slow failure on a dead name unnamed too, and leaves a live one as it was', async () => {
    const dead = await race({ hello: async () => network(), named: async () => 'dead' })
    expect(dead[0].outcome).toBe('unnamed')
    const live = await race({ hello: async () => network(), named: async () => 'live' })
    expect(live[0].outcome).toBe('network')
  })

  it('does not ask about a timeout, an http answer, or an answer it merely could not verify', async () => {
    let asked = 0
    const named = async (): Promise<'dead'> => {
      asked += 1
      return 'dead'
    }
    const timeout = await race({ hello: async () => ({ ok: false, kind: 'timeout', ms: 800 }), named })
    expect(timeout[0].outcome).toBe('timeout')
    const http = await race({ hello: async () => ({ ok: false, kind: 'http', status: 404, ms: 20 }), named })
    expect(http[0].outcome).toBe('http')
    expect(asked).toBe(0)
  })

  it('treats an oracle that throws as unknown', async () => {
    const noted = await race({
      hello: async () => blocked(),
      named: async () => {
        throw new Error('no registry')
      }
    })
    expect(noted[0].outcome).toBe('network')
  })

  it('without an oracle, the stopwatch verdict stands as before', async () => {
    const noted = await race({ hello: async () => blocked() })
    expect(noted[0].outcome).toBe('blocked')
  })
})
