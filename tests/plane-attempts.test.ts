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
      answers[origin] ? { v: 2, deviceId: DEVICE, nonce, sig: 'a-signature', origin, issuedAtMs: Date.now() } : null,
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

  it('records a silent candidate as no answer, with no time', async () => {
    const noted = await race({ answers: { [TAILNET]: true } })
    const lan = noted.find((row) => row.name.startsWith('192.168'))
    expect(lan?.outcome).toBe('no-answer')
    expect(lan?.ms).toBe(null)
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

  it('leaves a plain silence alone when the permission is fine', async () => {
    const noted = await race({ answers: {}, permission: async () => 'granted' })
    expect(noted.map((row) => row.outcome)).toEqual(['no-answer', 'no-answer'])
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
