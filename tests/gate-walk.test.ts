import { describe, expect, it } from 'vitest'
import {
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

describe('gateWalk — the install door (buy a copy)', () => {
  it('walks identify → pay → open when the preset is priced', () => {
    const walk = gateWalk(scene({ pricing: PRICED, phase: { kind: 'pay' }, pin: 'V4' }))
    expect(walk.kind).toBe('walk')
    if (walk.kind !== 'walk') return
    expect(walk.steps.map((s) => s.id)).toEqual(['identify', 'pay', 'open'])
    expect(stateOf(walk.steps, 'identify')?.state).toBe('done')
    expect(stateOf(walk.steps, 'pay')?.state).toBe('now')
    expect(stateOf(walk.steps, 'open')?.state).toBe('todo')
    expect(walk.pin).toBe('V4')
  })

  it('DASHES the pay step for a free preset — it never hides what it did not ask', () => {
    const walk = gateWalk(scene({ pricing: null, phase: { kind: 'open' }, pin: 'V2' }))
    if (walk.kind !== 'walk') throw new Error('expected walk')
    // The step is still THERE — the rail always has three slots on this door —
    // but skipped, not cleared. This is the difference the ruling is about.
    expect(stateOf(walk.steps, 'pay')?.state).toBe('skip')
    expect(stateOf(walk.steps, 'pay')?.band).toBeNull()
    expect(stateOf(walk.steps, 'identify')?.state).toBe('done')
    expect(stateOf(walk.steps, 'open')?.state).toBe('now')
  })

  it('a skipped pay step is never painted as done, at any phase', () => {
    for (const kind of ['identify', 'open'] as const) {
      const walk = gateWalk(scene({ pricing: null, phase: { kind } }))
      if (walk.kind !== 'walk') throw new Error('expected walk')
      expect(stateOf(walk.steps, 'pay')?.state).toBe('skip')
    }
  })
})

describe('gateWalk — the call door (a live line)', () => {
  it('has NO pay slot at all — R5, a call never charges inline', () => {
    const walk = gateWalk({ door: 'call', phase: { kind: 'identify' }, pin: 'V1' })
    if (walk.kind !== 'walk') throw new Error('expected walk')
    expect(walk.steps.map((s) => s.id)).toEqual(['identify', 'open'])
    expect(stateOf(walk.steps, 'pay')).toBeUndefined()
  })

  it('lights identify only on first contact; open waits', () => {
    const walk = gateWalk({ door: 'call', phase: { kind: 'identify' } })
    if (walk.kind !== 'walk') throw new Error('expected walk')
    expect(stateOf(walk.steps, 'identify')?.state).toBe('now')
    expect(stateOf(walk.steps, 'identify')?.band).toBe('401')
    expect(stateOf(walk.steps, 'open')?.state).toBe('todo')
    expect(stateOf(walk.steps, 'open')?.band).toBeNull()
  })

  it('collapses an impossible pay phase to identify rather than inventing a step', () => {
    // The gate cannot answer 402 on the call door; if a caller somehow feeds one
    // in, the rail must not grow a slot it has no room for.
    const walk = gateWalk({ door: 'call', phase: { kind: 'pay' } })
    if (walk.kind !== 'walk') throw new Error('expected walk')
    expect(walk.steps.map((s) => s.id)).toEqual(['identify', 'open'])
    expect(stateOf(walk.steps, 'identify')?.state).toBe('now')
  })
})

describe('gateWalk — bands appear only for now/done (shorter as you succeed)', () => {
  it('a todo step shows a tick with no band', () => {
    const walk = gateWalk(scene({ pricing: PRICED, phase: { kind: 'identify' } }))
    if (walk.kind !== 'walk') throw new Error('expected walk')
    expect(stateOf(walk.steps, 'identify')?.band).toBe('401')
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
