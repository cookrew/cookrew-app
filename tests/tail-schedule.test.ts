import { describe, expect, it } from 'vitest'
import { TAIL_BACKSTOP_MS, TAIL_MISS_RETRY_MS, createTailSchedule, tailVersionOf } from '../src/renderer/src/stream/tail-schedule'

/**
 * WHEN A QUIET AGENT'S PREVIEW IS READ AGAIN (bytes 0.6.2). It was every 3 s
 * for every quiet agent in every workspace: 22 agents and 128 KB a sweep on the
 * owner's Mac, back to back through the relay. Now: once, then when its
 * activity says something changed, and at most a minute apart regardless.
 */

const IDS = ['a', 'b', 'c']

describe('a quiet agent’s preview', () => {
  it('is read once for every agent, then not again while nothing changes', () => {
    const plan = createTailSchedule()
    expect(plan.due(IDS, {}, 0)).toEqual(IDS)
    for (const id of IDS) plan.read(id, '', 0)
    for (let at = 3_000; at < TAIL_BACKSTOP_MS; at += 3_000) expect(plan.due(IDS, {}, at), `at ${at}`).toEqual([])
  })

  it('is read again within a minute whatever happens: a missed activity signal is not a stale preview for ever', () => {
    const plan = createTailSchedule()
    for (const id of IDS) plan.read(id, '', 0)
    expect(plan.due(IDS, {}, TAIL_BACKSTOP_MS)).toEqual(IDS)
  })

  it('is read at once when its agent’s activity changed, and only that agent’s', () => {
    const plan = createTailSchedule()
    for (const id of IDS) plan.read(id, 'v1', 0)
    expect(plan.due(IDS, { a: 'v1', b: 'v2', c: 'v1' }, 3_000)).toEqual(['b'])
  })

  it('an agent that joins is read; one that left is forgotten, and read whole if it comes back', () => {
    const plan = createTailSchedule()
    plan.read('a', '', 0)
    expect(plan.due(['a', 'd'], {}, 1_000)).toEqual(['d'])
    plan.due(['d'], {}, 2_000)
    expect(plan.due(['a', 'd'], {}, 3_000)).toEqual(['a', 'd'])
  })

  it('a read that missed is asked again soon, not a minute later', () => {
    const plan = createTailSchedule()
    plan.read('a', '', 0)
    plan.missed('a', 1_000)
    expect(plan.due(['a'], {}, 1_000 + TAIL_MISS_RETRY_MS - 1)).toEqual([])
    expect(plan.due(['a'], {}, 1_000 + TAIL_MISS_RETRY_MS)).toEqual(['a'])
  })

  it('reads the activity’s phase and turn count as its version, not its clock, and nothing as the empty one', () => {
    expect(tailVersionOf(undefined)).toBe('')
    expect(tailVersionOf({ phase: 'idle', turnCount: 2 })).toBe('idle|2')
    // The tracker stamps its clock on every push: a push that changed nothing is no change.
    expect(tailVersionOf({ phase: 'idle', updatedAt: 5, turnCount: 2 } as never)).toBe(tailVersionOf({ phase: 'idle', updatedAt: 9, turnCount: 2 } as never))
    expect(tailVersionOf({ phase: 'idle' })).toBe('idle|0')
  })

  it('in a simulated idle minute of the owner’s Mac (22 quiet agents, a tick every 3 s): 22 reads, not 147', () => {
    const plan = createTailSchedule()
    const ids = Array.from({ length: 22 }, (_, i) => `agent-${i}`)
    let reads = 0
    // Start of the visit, then a minute of ticks.
    for (let at = 0; at <= 60_000; at += 3_000) {
      for (const id of plan.due(ids, {}, at)) {
        plan.read(id, '', at)
        reads += 1
      }
    }
    // The first read of each, and each one's backstop at the minute.
    expect(reads).toBe(44)
    let steady = 0
    for (let at = 63_000; at <= 120_000; at += 3_000) {
      for (const id of plan.due(ids, {}, at)) {
        plan.read(id, '', at)
        steady += 1
      }
    }
    expect(steady).toBe(22)
  })
})
