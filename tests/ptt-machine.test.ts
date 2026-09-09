import { describe, expect, it } from 'vitest'
import { PTT_HOLD_MS, PTT_IDLE, pttStep, type PttEvent, type PttState } from '../src/shared/ptt-machine'

const down = (key: string, repeat = false): PttEvent => ({ type: 'keydown', key, metaKey: key === 'Meta', repeat })
const up = (key: string): PttEvent => ({ type: 'keyup', key })

/** Run a sequence with a clock, collecting the actions the world would do. */
function run(events: Array<[PttEvent, number]>): { state: PttState; actions: string[] } {
  let state = PTT_IDLE
  const actions: string[] = []
  for (const [event, now] of events) {
    const step = pttStep(state, event, now)
    state = step.state
    if (step.action) actions.push(step.action)
  }
  return { state, actions }
}

describe('push-to-talk on ⌘', () => {
  it('a held ⌘ starts listening after the beat and stops on release', () => {
    const r = run([
      [down('Meta'), 0],
      [{ type: 'tick', now: 100 }, 100],
      [{ type: 'tick', now: PTT_HOLD_MS }, PTT_HOLD_MS],
      [up('Meta'), 900]
    ])
    expect(r.actions).toEqual(['start', 'stop'])
    expect(r.state).toEqual(PTT_IDLE)
  })
  it('a ⌘ released before the beat was a chord that never came — nothing happens', () => {
    const r = run([
      [down('Meta'), 0],
      [up('Meta'), 200]
    ])
    expect(r.actions).toEqual([])
  })
  it('⌘C is a chord: the letter inside the hold cancels the arm', () => {
    const r = run([
      [down('Meta'), 0],
      [down('c'), 120],
      [{ type: 'tick', now: PTT_HOLD_MS + 10 }, PTT_HOLD_MS + 10],
      [up('c'), 200],
      [up('Meta'), 260]
    ])
    expect(r.actions).toEqual([])
  })
  it('a chord while already listening stops the listen — ⌘C mid-sentence means copy', () => {
    const r = run([
      [down('Meta'), 0],
      [{ type: 'tick', now: PTT_HOLD_MS }, PTT_HOLD_MS],
      [down('c'), 800]
    ])
    expect(r.actions).toEqual(['start', 'stop'])
    expect(r.state).toEqual(PTT_IDLE)
  })
  it('auto-repeat keydowns of ⌘ do not re-arm', () => {
    const r = run([
      [down('Meta'), 0],
      [down('Meta', true), 50],
      [down('Meta', true), 100],
      [{ type: 'tick', now: PTT_HOLD_MS }, PTT_HOLD_MS]
    ])
    expect(r.actions).toEqual(['start'])
  })
  it('blur is a key-up the window never saw', () => {
    const r = run([
      [down('Meta'), 0],
      [{ type: 'tick', now: PTT_HOLD_MS }, PTT_HOLD_MS],
      [{ type: 'blur' }, 500]
    ])
    expect(r.actions).toEqual(['start', 'stop'])
  })
  it('the listener ending on its own leaves the machine idle without a second stop', () => {
    const r = run([
      [down('Meta'), 0],
      [{ type: 'tick', now: PTT_HOLD_MS }, PTT_HOLD_MS],
      [{ type: 'ended' }, 5000],
      [up('Meta'), 5100]
    ])
    expect(r.actions).toEqual(['start'])
  })
  it('other keys on their own are nothing to it', () => {
    const r = run([
      [down('a'), 0],
      [up('a'), 50],
      [{ type: 'tick', now: 1000 }, 1000]
    ])
    expect(r.actions).toEqual([])
    expect(r.state).toEqual(PTT_IDLE)
  })
})
