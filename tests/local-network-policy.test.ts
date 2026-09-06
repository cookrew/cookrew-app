// WHAT THE PERMISSION IS ALLOWED TO DO TO THE RACE.
//
// Four states, four different right answers, and getting any of them wrong is
// invisible in a way the reader pays for:
//
//   DENIED — do not race at all. Probing an address the browser will refuse is
//   pure battery, and worse, it produces a failure indistinguishable from a
//   sleeping Mac, so the "why this path" panel would lie about what happened.
//
//   PROMPT — race only when a person asked for it. Chrome raises the dialog
//   from the request itself, so a race started by the 60-second timer raises a
//   prompt at a phone in a pocket, and a prompt nobody sees is DISMISSED. A
//   dismissal is not neutral: it is a refusal that then persists.
//
//   GRANTED and UNSUPPORTED — race exactly as before. Unsupported is Safari
//   today: a browser that never prompts either allows the request or fails it,
//   and a failed request is already "not this path".

import { describe, expect, it } from 'vitest'
import {
  switchPlaneIfBetter,
  type PlaneOutcome,
  type PlaneSwitchDeps
} from '../src/renderer/src/path/plane-switch'
import type { LocalNetworkState } from '../src/renderer/src/local-network'
import type { DataPlane } from '../src/renderer/src/data-plane'
import type { ReachCardLite } from '../src/renderer/src/path/switch'

const DEVICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const LAN = `https://192-168-1-24.${DEVICE}.d.cookrew.dev:8643`
const RELAY: DataPlane = { origin: '', kind: 'relay' }

interface Run {
  readonly outcome: PlaneOutcome
  readonly asked: readonly string[]
  readonly cards: number
}

const race = async (
  permission: LocalNetworkState | undefined,
  over: Partial<PlaneSwitchDeps> = {}
): Promise<Run> => {
  const asked: string[] = []
  let cards = 0
  const deps: PlaneSwitchDeps = {
    plane: () => RELAY,
    card: async (): Promise<ReachCardLite> => {
      cards += 1
      return { deviceId: DEVICE, lan: [], tailnet: null, trusted: [LAN] }
    },
    hello: async (origin, nonce) => {
      asked.push(origin)
      return { deviceId: DEVICE, nonce, sig: 'a-signature' }
    },
    verify: async () => true,
    adopt: () => undefined,
    nonce: () => 'a-nonce',
    ...(permission ? { permission: async () => permission } : {}),
    ...over
  }
  return { outcome: await switchPlaneIfBetter(deps), asked, cards }
}

describe('the permission policy', () => {
  it('DENIED: does not race, and does not even ask the desktop where it lives', async () => {
    const run = await race('denied')
    expect(run.outcome).toBe('refused')
    expect(run.asked).toEqual([])
    // The card fetch is a relay request and would succeed; not making it is
    // the point. A refusal is settled before any work is done.
    expect(run.cards).toBe(0)
  })

  it('PROMPT: does not race off a timer, because nobody is looking at the phone', async () => {
    const run = await race('prompt')
    expect(run.outcome).toBe('unasked')
    expect(run.asked).toEqual([])
    expect(run.cards).toBe(0)
  })

  it('PROMPT: races when a person asked for it — the explainer’s ALLOW', async () => {
    const run = await race('prompt', { mayPrompt: () => true })
    expect(run.outcome).toBe('switched')
    expect(run.asked).toEqual([LAN])
  })

  it('GRANTED: races exactly as it always did', async () => {
    const run = await race('granted')
    expect(run.outcome).toBe('switched')
    expect(run.asked).toEqual([LAN])
  })

  it('UNSUPPORTED: races — Safari has no prompt to raise', async () => {
    const run = await race('unsupported')
    expect(run.outcome).toBe('switched')
    expect(run.asked).toEqual([LAN])
  })

  it('races when nothing was injected at all, so an old call site is unchanged', async () => {
    const run = await race(undefined)
    expect(run.outcome).toBe('switched')
  })

  it('races when the permission cannot be read, rather than stalling for ever', async () => {
    // Not knowing is not a refusal. A rejected query must degrade to the
    // behaviour of a browser that never had the permission.
    const run = await race(undefined, {
      permission: () => Promise.reject(new TypeError('unknown permission'))
    })
    expect(run.outcome).toBe('switched')
  })

  it('checks the permission AFTER the cheap local answers, not before', async () => {
    // Already on the LAN, or holding off after a fallback: no permission
    // question arises, so none is asked.
    let asks = 0
    const counted = async (): Promise<LocalNetworkState> => {
      asks += 1
      return 'denied'
    }
    await race(undefined, { plane: () => ({ origin: LAN, kind: 'lan' }), permission: counted })
    await race(undefined, { held: () => true, permission: counted })
    expect(asks).toBe(0)
  })
})
