import { describe, expect, it } from 'vitest'
import {
  gateDoorFor,
  gateWalk,
  phaseFromGateStep,
  type GateScene,
  type WalkPricing,
  type WalkStep
} from '../src/shared/gate-walk'

/**
 * THE SHEET IS A PICTURE OF THE PROTOCOL (R28).
 *
 * These tests pin the one property the whole ruling rests on: the rail the user
 * sees is DERIVED from the gate's order, so it cannot draw a step the gate does
 * not demand nor hide one it does. The component is a projection of this model,
 * so proving the model here proves the sheet cannot lie about the gate — without
 * a DOM.
 */

const TERMS = {
  price: '2.50',
  asset: 'USDC',
  chain: 'Base',
  author: '@drej',
  expiry: 1_700_000_240_000
}
const PRICED: WalkPricing = { model: 'one-time', terms: TERMS }

const stateOf = (steps: WalkStep[], id: WalkStep['id']): WalkStep | undefined =>
  steps.find((s) => s.id === id)

const scene = (over: Partial<GateScene>): GateScene => ({
  door: 'install',
  phase: { kind: 'identify' },
  ...over
})

describe('gateWalk — the install door (a listed team, the account)', () => {
  it('walks identify → seat → pay → open when the team is priced', () => {
    const walk = gateWalk(scene({ pricing: PRICED, phase: { kind: 'pay' }, pin: 'V4' }))
    expect(walk.kind).toBe('walk')
    if (walk.kind !== 'walk') return
    expect(walk.steps.map((s) => s.id)).toEqual(['identify', 'seat', 'pay', 'open'])
    expect(stateOf(walk.steps, 'identify')?.state).toBe('done')
    // The 402 is past the seat rung by construction: the registry seated us
    // before the door quoted, so the seat is cleared, not skipped.
    expect(stateOf(walk.steps, 'seat')?.state).toBe('done')
    expect(stateOf(walk.steps, 'seat')?.band).toBe('403-seat')
    expect(stateOf(walk.steps, 'pay')?.state).toBe('now')
    expect(stateOf(walk.steps, 'open')?.state).toBe('todo')
    expect(walk.pin).toBe('V4')
  })

  it('DASHES the seat and pay steps for a free team — it never hides what it did not ask', () => {
    const walk = gateWalk(scene({ pricing: null, phase: { kind: 'open' }, pin: 'V2' }))
    if (walk.kind !== 'walk') throw new Error('expected walk')
    // The steps are still THERE — the rail always has four slots on this door
    // — but skipped, not cleared. This is the difference the ruling is about.
    expect(stateOf(walk.steps, 'seat')?.state).toBe('skip')
    expect(stateOf(walk.steps, 'seat')?.band).toBeNull()
    expect(stateOf(walk.steps, 'pay')?.state).toBe('skip')
    expect(stateOf(walk.steps, 'pay')?.band).toBeNull()
    expect(stateOf(walk.steps, 'identify')?.state).toBe('done')
    expect(stateOf(walk.steps, 'open')?.state).toBe('now')
  })

  it('a skipped step is never painted as done, at any phase', () => {
    for (const kind of ['identify', 'open'] as const) {
      const walk = gateWalk(scene({ pricing: null, phase: { kind } }))
      if (walk.kind !== 'walk') throw new Error('expected walk')
      expect(stateOf(walk.steps, 'seat')?.state).toBe('skip')
      expect(stateOf(walk.steps, 'pay')?.state).toBe('skip')
    }
  })

  it('lights the seat step on a 403 no_seat — the one refusal that stays on the rail', () => {
    const walk = gateWalk(
      scene({ pricing: PRICED, phase: { kind: 'denied', reason: 'no_seat', retryable: false } })
    )
    expect(walk.kind).toBe('walk')
    if (walk.kind !== 'walk') return
    expect(stateOf(walk.steps, 'identify')?.state).toBe('done')
    expect(stateOf(walk.steps, 'seat')?.state).toBe('now')
    expect(stateOf(walk.steps, 'seat')?.band).toBe('403-seat')
    expect(stateOf(walk.steps, 'pay')?.state).toBe('todo')
    expect(stateOf(walk.steps, 'open')?.state).toBe('todo')
  })

  it('the live step is never dashed, even when no price line was carried in', () => {
    const walk = gateWalk(
      scene({ pricing: null, phase: { kind: 'denied', reason: 'no_seat', retryable: false } })
    )
    if (walk.kind !== 'walk') throw new Error('expected walk')
    expect(stateOf(walk.steps, 'seat')?.state).toBe('now')
  })
})

describe('gateWalk — the DIRECT door (unlisted, this Mac’s own key)', () => {
  it('has NO seat slot at all — no registry is involved, so nobody can be seated', () => {
    const walk = gateWalk({ door: 'direct', phase: { kind: 'identify' }, pin: 'V1' })
    if (walk.kind !== 'walk') throw new Error('expected walk')
    expect(walk.steps.map((s) => s.id)).toEqual(['identify', 'pay', 'open'])
    expect(stateOf(walk.steps, 'seat')).toBeUndefined()
  })

  it('lights identify only on first contact; open waits', () => {
    const walk = gateWalk({ door: 'direct', phase: { kind: 'identify' } })
    if (walk.kind !== 'walk') throw new Error('expected walk')
    expect(stateOf(walk.steps, 'identify')?.state).toBe('now')
    expect(stateOf(walk.steps, 'identify')?.band).toBe('401')
    expect(stateOf(walk.steps, 'pay')?.state).toBe('skip')
    expect(stateOf(walk.steps, 'open')?.state).toBe('todo')
    expect(stateOf(walk.steps, 'open')?.band).toBeNull()
  })

  it('keeps the pay slot — a dialled paid door still charges at its own 402', () => {
    const walk = gateWalk({ door: 'direct', phase: { kind: 'pay' }, pricing: PRICED })
    if (walk.kind !== 'walk') throw new Error('expected walk')
    expect(stateOf(walk.steps, 'identify')?.state).toBe('done')
    expect(stateOf(walk.steps, 'pay')?.state).toBe('now')
    expect(stateOf(walk.steps, 'pay')?.band).toBe('402')
  })

  it('treats no_seat as a plain refusal — the rail has no seat slot to light', () => {
    const walk = gateWalk({
      door: 'direct',
      phase: { kind: 'denied', reason: 'no_seat', retryable: false }
    })
    expect(walk).toEqual({ kind: 'denied', reason: 'no_seat', retryable: false, band: '403' })
  })
})

describe('gateDoorFor — listed or not is the whole decision', () => {
  it('a published name the directory answers for takes the install walk', () => {
    expect(gateDoorFor({ door: '@drej/alpha' }, { listed: true })).toBe('install')
  })

  it('a dialled address is DIRECT — there is no name for a registry to know', () => {
    expect(gateDoorFor({}, { listed: false })).toBe('direct')
    expect(gateDoorFor({ door: undefined }, { listed: true })).toBe('direct')
    expect(gateDoorFor({ door: '' }, { listed: true })).toBe('direct')
  })

  it('a name the directory does not answer for is DIRECT, never install', () => {
    expect(gateDoorFor({ door: '@drej/alpha' }, { listed: false })).toBe('direct')
    expect(gateDoorFor({ door: '@drej/alpha' }, null)).toBe('direct')
  })
})

describe('gateWalk — bands appear only for now/done (shorter as you succeed)', () => {
  it('a todo step shows a tick with no band', () => {
    const walk = gateWalk(scene({ pricing: PRICED, phase: { kind: 'identify' } }))
    if (walk.kind !== 'walk') throw new Error('expected walk')
    expect(stateOf(walk.steps, 'identify')?.band).toBe('401')
    expect(stateOf(walk.steps, 'seat')?.band).toBeNull()
    expect(stateOf(walk.steps, 'pay')?.band).toBeNull()
    expect(stateOf(walk.steps, 'open')?.band).toBeNull()
  })

  it('a cleared identify step keeps its band as a receipt line', () => {
    const walk = gateWalk(scene({ pricing: PRICED, phase: { kind: 'pay' } }))
    if (walk.kind !== 'walk') throw new Error('expected walk')
    expect(stateOf(walk.steps, 'identify')?.band).toBe('401')
    expect(stateOf(walk.steps, 'pay')?.band).toBe('402')
  })
})

describe('gateWalk — refusals are not rail steps', () => {
  it('renders a 403 as its own kind, never a place on the journey', () => {
    const walk = gateWalk(scene({ phase: { kind: 'denied', reason: 'scope', retryable: true } }))
    expect(walk).toEqual({ kind: 'denied', reason: 'scope', retryable: true, band: '403' })
  })

  it('an empty balance wears amber (403-credit), not rose', () => {
    const walk = gateWalk(
      scene({ phase: { kind: 'denied', reason: 'balance_empty', retryable: false } })
    )
    if (walk.kind !== 'denied') throw new Error('expected denied')
    expect(walk.band).toBe('403-credit')
  })

  it('a 404 is gone, and an unusable answer is error with its status', () => {
    expect(gateWalk(scene({ phase: { kind: 'gone' } }))).toEqual({ kind: 'gone' })
    expect(gateWalk(scene({ phase: { kind: 'error', status: 502 } }))).toEqual({
      kind: 'error',
      status: 502
    })
  })
})

describe('phaseFromGateStep — bridges the download client to the sheet', () => {
  it('maps each GateStep kind to its scene phase', () => {
    expect(phaseFromGateStep({ kind: 'ready' })).toEqual({ kind: 'open' })
    expect(phaseFromGateStep({ kind: 'enrol' })).toEqual({ kind: 'identify' })
    expect(phaseFromGateStep({ kind: 'pay' })).toEqual({ kind: 'pay' })
    expect(phaseFromGateStep({ kind: 'gone' })).toEqual({ kind: 'gone' })
  })

  it('carries a denial reason and its retryable flag through', () => {
    expect(phaseFromGateStep({ kind: 'denied', reason: 'scope', retryable: true })).toEqual({
      kind: 'denied',
      reason: 'scope',
      retryable: true
    })
    // A denial with no reason is still a denial — 'unknown', never a crash.
    expect(phaseFromGateStep({ kind: 'denied' })).toEqual({
      kind: 'denied',
      reason: 'unknown',
      retryable: false
    })
  })

  it('turns an error step into an error phase carrying the status', () => {
    expect(phaseFromGateStep({ kind: 'error', status: 500 })).toEqual({ kind: 'error', status: 500 })
    // A kind it has never heard of fails closed to error, not to a served step.
    expect(phaseFromGateStep({ kind: 'teapot' })).toEqual({ kind: 'error', status: 0 })
  })
})
