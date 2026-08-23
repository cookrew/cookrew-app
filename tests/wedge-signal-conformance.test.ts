import { describe, expect, it, beforeEach } from 'vitest'
import {
  confirmDelivery,
  deliveryWedgeCoverage,
  resetDeliveryWedgeCoverage,
  type DeliveryDeps
} from '../src/main/ask-delivery'
import { DirectMultiplexer } from '../src/main/direct-multiplexer'
import { toScrollState } from '../src/main/herdr-host-multiplexer'

// THE SIGNAL THE WEDGE CHECK RESTS ON, per backend.
//
// `unresponsive` fires only when scrollback depth fails to advance across a
// write. That makes the whole feature contingent on `historySize` RISING with
// output — and this lane already contains the cautionary precedent: herdr's
// `revision` field looks exactly like an output counter and stayed at 1 across
// four bursts. A field that never advances makes the wedge check unreachable,
// silently, with no failure anywhere.
//
// So each backend states here what its depth signal does. A backend that
// cannot answer must say so out loud (null), not by returning a constant that
// merely looks like an answer.

describe('herdr — max_offset_from_bottom is the counter that advances', () => {
  const pane = (max: number | null) =>
    ({ scroll: { offset_from_bottom: 0, max_offset_from_bottom: max } }) as never

  it('rises with output, which is what the wedge check reads', () => {
    // Measured against a live pane across four output bursts.
    const depths = [0, 18, 59, 100, 141].map((max) => toScrollState(pane(max)).historySize)
    expect(depths).toEqual([0, 18, 59, 100, 141])
    for (let i = 1; i < depths.length; i += 1) {
      expect(depths[i] as number).toBeGreaterThan(depths[i - 1] as number)
    }
  })

  it('reports null rather than zero when there is no scroll block', () => {
    // Zero would read as a real depth and make every pane look frozen at 0 —
    // a wedge verdict for the entire fleet.
    expect(toScrollState(null).historySize).toBeNull()
    expect(toScrollState({} as never).historySize).toBeNull()
  })
})

describe('direct — declares no depth rather than faking one', () => {
  const backend = new DirectMultiplexer()

  it('answers null depth, so the wedge check stays UNASKED', () => {
    expect(backend.scrollState('cookrew_t1').historySize).toBeNull()
  })

  it('answers identically for every terminal — no cross-pane verdict is possible', () => {
    // The signature ignored its name argument, so a per-terminal answer here
    // would have been one pane's state reported for another.
    expect(backend.scrollState('cookrew_a')).toEqual(backend.scrollState('cookrew_b'))
  })
})

// ---------------------------------------------------------------------------
// The degrade is COUNTED, so an inert feature is visible.
// ---------------------------------------------------------------------------

const PROMPT = 'Run the F2 simulation and report the counts.'

function deps(over: Partial<DeliveryDeps> = {}): DeliveryDeps {
  return {
    turnCountOf: () => 4,
    capture: () => 'unrelated screen',
    submit: () => undefined,
    settle: async () => undefined,
    outputDepth: () => 141,
    ...over
  }
}

const run = (d: DeliveryDeps, depthBefore: number | null) =>
  confirmDelivery(d, { terminalId: 'term-1', prompt: PROMPT, turnsBefore: 4, depthBefore })

describe('a blind wedge check is counted, not silent', () => {
  beforeEach(() => resetDeliveryWedgeCoverage())

  it('counts a verdict reached with no depth reading as BLIND', async () => {
    await run(deps({ outputDepth: () => null }), 100)
    expect(deliveryWedgeCoverage()).toEqual({ blind: 1, seen: 0 })
  })

  it('counts a verdict with both readings as SEEN', async () => {
    await run(deps(), 100)
    expect(deliveryWedgeCoverage()).toEqual({ blind: 0, seen: 1 })
  })

  it('counts a backend with no outputDepth at all as blind', async () => {
    const { outputDepth, ...rest } = deps()
    void outputDepth
    await run(rest as DeliveryDeps, 100)
    expect(deliveryWedgeCoverage().blind).toBe(1)
  })

  it('makes an INERT wedge check distinguishable from a healthy fleet', async () => {
    // The failure this counter exists for: a backend whose depth never
    // advances produces zero `unresponsive` verdicts forever, which looks
    // exactly like no pane ever wedging. All-blind is the tell.
    for (let i = 0; i < 5; i += 1) await run(deps({ outputDepth: () => null }), 100)
    const coverage = deliveryWedgeCoverage()
    expect(coverage.seen).toBe(0)
    expect(coverage.blind).toBe(5)
  })
})

describe('the depth read never fails the ask', () => {
  beforeEach(() => resetDeliveryWedgeCoverage())

  it('survives a scrollState that THROWS on a dead session', async () => {
    // Trading a merely-wrong verdict for a hard failure is a bad trade: the
    // wedge check enriches the answer, it is not the answer. A backend
    // throwing on a dead session is ordinary, and the ask must still reach a
    // verdict rather than dying on the enrichment.
    const throwing = deps({
      outputDepth: () => {
        throw new Error('no such session')
      }
    })
    const report = await run(throwing, 100)
    expect(report.outcome).toBe('dropped')
    // ...and the failed reading is counted blind, not silently swallowed.
    expect(deliveryWedgeCoverage().blind).toBe(1)
  })
})
