import { describe, expect, it } from 'vitest'
import { activitySignature, advanceClock } from '../src/renderer/src/activity-clock'
import type { TerminalActivity } from '../src/shared/turn'

const NOW = 1_800_000_000_000
/** activity() defaults to an in-flight turn, so a first sighting seeds here. */
const SEED = NOW - 30_000

function activity(over: Partial<TerminalActivity> = {}): TerminalActivity {
  return {
    terminalId: 't1',
    agent: true,
    phase: 'thinking',
    prompt: 'do the thing',
    reply: null,
    title: 'Do the thing',
    lines: [],
    glance: { status: 'Herding…', tools: ['Read a.ts'], message: null },
    pendingInput: null,
    turnCount: 3,
    turnStartedAt: NOW - 30_000,
    updatedAt: NOW,
    ...over,
  } as TerminalActivity
}

/**
 * "Latest activity" means something HAPPENED — a turn started, a tool ran, a
 * reply landed. It does not mean the tracker re-serialized: updatedAt is
 * stamped on every 250ms push whether or not anything changed, and streaming
 * assistant text changes several times a second. Ranking on either makes the
 * list churn instead of informing.
 */
describe('activitySignature', () => {
  it('is unchanged by a re-serialization with the same content', () => {
    expect(activitySignature(activity({ updatedAt: NOW }))).toBe(
      activitySignature(activity({ updatedAt: NOW + 250 })),
    )
  })

  it('is unchanged while assistant text streams in', () => {
    const a = activity({ glance: { status: 'Herding…', tools: ['Read a.ts'], message: 'He' } })
    const b = activity({
      glance: { status: 'Herding…', tools: ['Read a.ts'], message: 'Here is the answer' },
    })
    expect(activitySignature(a)).toBe(activitySignature(b))
  })

  it('is unchanged by the spinner verb ticking', () => {
    const a = activity({ glance: { status: 'Herding… (3s)', tools: [], message: null } })
    const b = activity({ glance: { status: 'Herding… (9s)', tools: [], message: null } })
    expect(activitySignature(a)).toBe(activitySignature(b))
  })

  it('CHANGES when a new turn starts', () => {
    expect(activitySignature(activity({ turnStartedAt: NOW }))).not.toBe(
      activitySignature(activity({ turnStartedAt: NOW - 30_000 })),
    )
  })

  it('CHANGES when a tool is called', () => {
    const before = activity({ glance: { status: 'x', tools: ['Read a.ts'], message: null } })
    const after = activity({
      glance: { status: 'x', tools: ['Read a.ts', 'Bash npm test'], message: null },
    })
    expect(activitySignature(before)).not.toBe(activitySignature(after))
  })

  it('CHANGES when the phase moves', () => {
    expect(activitySignature(activity({ phase: 'waiting' }))).not.toBe(
      activitySignature(activity({ phase: 'thinking' })),
    )
  })

  it('CHANGES when a turn completes', () => {
    expect(activitySignature(activity({ phase: 'replied', reply: 'done', turnCount: 4 }))).not.toBe(
      activitySignature(activity()),
    )
  })

  it('CHANGES when the recap title lands', () => {
    expect(activitySignature(activity({ title: 'A better recap' }))).not.toBe(
      activitySignature(activity()),
    )
  })
})

describe('advanceClock', () => {
  it('seeds an agent the first time it is seen', () => {
    const clock = advanceClock({}, { t1: activity() }, NOW)
    expect(clock.t1).toBe(SEED)
  })

  it('leaves the stamp alone when nothing happened', () => {
    const first = advanceClock({}, { t1: activity() }, NOW)
    const later = advanceClock(first, { t1: activity({ updatedAt: NOW + 250 }) }, NOW + 250)
    expect(later.t1).toBe(SEED)
  })

  it('holds still across four consecutive pushes of streaming output', () => {
    let clock = advanceClock({}, { t1: activity() }, NOW)
    for (let i = 1; i <= 4; i++) {
      const msg = 'streaming'.slice(0, i)
      clock = advanceClock(
        clock,
        {
          t1: activity({
            updatedAt: NOW + i * 250,
            glance: { status: 's', tools: ['Read a.ts'], message: msg },
          }),
        },
        NOW + i * 250,
      )
    }
    expect(clock.t1).toBe(SEED)
  })

  it('re-stamps the moment something actually happens', () => {
    const first = advanceClock({}, { t1: activity() }, NOW)
    const acted = advanceClock(first, { t1: activity({ phase: 'waiting' }) }, NOW + 9000)
    expect(acted.t1).toBe(NOW + 9000)
  })

  it('returns the SAME object when nothing moved, so React can skip the render', () => {
    const first = advanceClock({}, { t1: activity() }, NOW)
    const again = advanceClock(first, { t1: activity({ updatedAt: NOW + 250 }) }, NOW + 250)
    expect(again).toBe(first)
  })

  it('forgets an agent whose terminal is gone', () => {
    const first = advanceClock({}, { t1: activity(), t2: activity({ terminalId: 't2' }) }, NOW)
    const pruned = advanceClock(first, { t1: activity() }, NOW + 1000)
    expect(pruned.t2).toBeUndefined()
    expect(pruned.t1).toBe(SEED)
  })

  it('tracks each agent independently', () => {
    const first = advanceClock({}, { t1: activity(), t2: activity({ terminalId: 't2' }) }, NOW)
    const moved = advanceClock(
      first,
      { t1: activity(), t2: activity({ terminalId: 't2', phase: 'replied', reply: 'x' }) },
      NOW + 5000,
    )
    expect(moved.t1).toBe(SEED)
    expect(moved.t2).toBe(NOW + 5000)
  })
})

/**
 * Opening the panel is not an event. If a first sighting stamped `now`, every
 * agent would read "now" and the whole list would tie — which is exactly what
 * it did. A first sighting seeds from the agent's OWN last moment instead.
 */
describe('advanceClock — first sighting', () => {
  it('seeds from the agent’s last output, not from when the panel opened', () => {
    const clock = advanceClock(
      {},
      { t1: activity({ phase: 'idle', reply: 'done', updatedAt: NOW - 3_600_000 }) },
      NOW,
    )
    expect(clock.t1).toBe(NOW - 3_600_000)
  })

  it('seeds an in-flight turn from when the turn started', () => {
    const clock = advanceClock(
      {},
      { t1: activity({ phase: 'thinking', turnStartedAt: NOW - 60_000, updatedAt: NOW }) },
      NOW,
    )
    expect(clock.t1).toBe(NOW - 60_000)
  })

  it('does not collapse a whole roster onto the same instant', () => {
    const clock = advanceClock(
      {},
      {
        a: activity({ terminalId: 'a', phase: 'idle', reply: 'x', updatedAt: NOW - 9000 }),
        b: activity({ terminalId: 'b', phase: 'idle', reply: 'y', updatedAt: NOW - 1000 }),
      },
      NOW,
    )
    expect(clock.a).not.toBe(clock.b)
  })

  it('still stamps `now` for a change AFTER the first sighting', () => {
    const first = advanceClock({}, { t1: activity({ updatedAt: NOW - 9000 }) }, NOW)
    const moved = advanceClock(first, { t1: activity({ phase: 'waiting' }) }, NOW + 500)
    expect(moved.t1).toBe(NOW + 500)
  })
})
