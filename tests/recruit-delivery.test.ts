// THE BRIEF REACHES THE RECRUITED CARD (route program R3, live defect on
// storyboard beat 4): the sentence goes through the dispatch engine, the two
// boot-time 503s of a card made a moment ago are retried inside a window, every
// other refusal is thrown, and "delivered" is read from the ledger's record.

import { describe, expect, it } from 'vitest'
import { deliverToRecruit, retryableAtBoot, type RecruitDispatchEngine } from '../src/main/recruit-delivery'

type Answer = { status: number; body: Record<string, unknown> }

const engine = (answers: Answer[], record?: { state: string; error?: string }) => {
  const calls: Array<{ agentId: string; input: { text: string; origin?: string } }> = []
  let settledCalls = 0
  const fake: RecruitDispatchEngine = {
    dispatch: async (agentId, input) => {
      calls.push({ agentId, input })
      return answers[Math.min(calls.length, answers.length) - 1]
    },
    settled: async () => void (settledCalls += 1),
    get: () => record ?? { state: 'submitted' }
  }
  return { fake, calls, settled: () => settledCalls }
}

const clock = () => {
  let t = 0
  return { now: () => t, sleep: async (ms: number) => void (t += ms) }
}

describe('retryableAtBoot', () => {
  it('only the two refusals a booting card gives, and only as 503', () => {
    expect(retryableAtBoot(503, { error: 'unreachable' })).toBe(true)
    expect(retryableAtBoot(503, { error: 'agent has no durable observer' })).toBe(true)
    expect(retryableAtBoot(503, { error: 'dispatch ledger unavailable' })).toBe(false)
    expect(retryableAtBoot(409, { error: 'busy' })).toBe(false)
    expect(retryableAtBoot(404, { error: 'no such agent' })).toBe(false)
  })
})

describe('deliverToRecruit', () => {
  it('admits once, with the sentence as the text and the asker as origin, and resolves with the dispatch id', async () => {
    const e = engine([{ status: 202, body: { dispatchId: 'd1', state: 'submitted' } }])
    const out = await deliverToRecruit(e.fake, { nodeId: 'new', sentence: 'write a haiku about cables', originId: 'conductor' }, clock())
    expect(out).toEqual({ dispatchId: 'd1' })
    expect(e.calls).toEqual([{ agentId: 'new', input: { text: 'write a haiku about cables', origin: 'conductor' } }])
    expect(e.settled()).toBe(1)
  })

  it('a card whose pane and observer are not up yet is retried until it admits — one delivery', async () => {
    const e = engine([
      { status: 503, body: { error: 'unreachable' } },
      { status: 503, body: { error: 'agent has no durable observer' } },
      { status: 202, body: { dispatchId: 'd2', state: 'submitted' } }
    ])
    const out = await deliverToRecruit(e.fake, { nodeId: 'new', sentence: 's', originId: null }, { ...clock(), retryMs: 250 })
    expect(out.dispatchId).toBe('d2')
    expect(e.calls).toHaveLength(3)
    expect(e.calls[0].input).toEqual({ text: 's' })
  })

  it('gives up when the boot window closes, saying why', async () => {
    const e = engine([{ status: 503, body: { error: 'unreachable' } }])
    await expect(deliverToRecruit(e.fake, { nodeId: 'new', sentence: 's', originId: null }, { ...clock(), admissionMs: 1000, retryMs: 250 })).rejects.toThrow(/unreachable/)
    expect(e.calls.length).toBeGreaterThanOrEqual(4)
    expect(e.calls.length).toBeLessThanOrEqual(6)
  })

  it('a refusal that is not a boot symptom is thrown at once — busy, no such agent, a dead ledger', async () => {
    for (const answer of [
      { status: 409, body: { error: 'busy' } },
      { status: 404, body: { error: 'no such agent' } },
      { status: 503, body: { error: 'dispatch ledger unavailable' } }
    ]) {
      const e = engine([answer])
      await expect(deliverToRecruit(e.fake, { nodeId: 'new', sentence: 's', originId: null }, clock())).rejects.toThrow(String(answer.body.error))
      expect(e.calls).toHaveLength(1)
    }
  })

  it('an admitted brief whose delivery leg failed is a failure, not a "sent"', async () => {
    const e = engine([{ status: 202, body: { dispatchId: 'd3', state: 'submitted' } }], { state: 'failed', error: 'context-full' })
    await expect(deliverToRecruit(e.fake, { nodeId: 'new', sentence: 's', originId: null }, clock())).rejects.toThrow(/context-full/)
    const i = engine([{ status: 202, body: { dispatchId: 'd4', state: 'submitted' } }], { state: 'interrupted' })
    await expect(deliverToRecruit(i.fake, { nodeId: 'new', sentence: 's', originId: null }, clock())).rejects.toThrow(/interrupted/)
    // a record already running or done, or one the engine no longer holds, is a delivery
    const r = engine([{ status: 202, body: { dispatchId: 'd5', state: 'submitted' } }], { state: 'running' })
    await expect(deliverToRecruit(r.fake, { nodeId: 'new', sentence: 's', originId: null }, clock())).resolves.toEqual({ dispatchId: 'd5' })
  })
})
