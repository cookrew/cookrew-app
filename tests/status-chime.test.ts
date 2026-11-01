import { describe, expect, it, vi, afterEach } from 'vitest'
import type { TerminalActivity, TurnPhase } from '../src/shared/turn'
import { KeyedStore } from '../src/renderer/src/keyed-store'
import {
  chimeToPlay,
  EMPTY_CHIME_MEMORY,
  MIN_WORK_MS,
  REPEAT_MS,
  stepChimes,
  type ChimeKind,
  type ChimeMemory
} from '../src/renderer/src/status-chime'
import { installStatusChime } from '../src/renderer/src/chime-sound'

const act = (terminalId: string, phase: TurnPhase, agent = true): TerminalActivity =>
  ({ terminalId, agent, phase }) as TerminalActivity

/** Runs phases through stepChimes at the given times; returns every chime in order. */
function run(steps: ReadonlyArray<[number, Record<string, TurnPhase>]>, agent = true): ChimeKind[] {
  let memory: ChimeMemory = EMPTY_CHIME_MEMORY
  const out: ChimeKind[] = []
  for (const [at, phases] of steps) {
    const map = Object.fromEntries(Object.entries(phases).map(([id, p]) => [id, act(id, p, agent)]))
    const step = stepChimes(memory, map, at)
    memory = step.memory
    out.push(...step.chimes)
  }
  return out
}

describe('status chime — when an agent rings', () => {
  it('rings done when a working turn ends in a reply', () => {
    expect(run([[0, { a: 'idle' }], [1_000, { a: 'thinking' }], [1_000 + MIN_WORK_MS, { a: 'replied' }]])).toEqual(['done'])
  })

  it('does not ring done for a reply that came back faster than MIN_WORK_MS', () => {
    expect(run([[0, { a: 'idle' }], [1_000, { a: 'thinking' }], [1_000 + MIN_WORK_MS - 1, { a: 'replied' }]])).toEqual([])
  })

  it('rings waiting the moment an agent stops on a question', () => {
    expect(run([[0, { a: 'thinking' }], [200, { a: 'waiting' }]])).toEqual(['waiting'])
  })

  it('counts the time spent waiting as part of the turn for done', () => {
    expect(
      run([[0, { a: 'idle' }], [1, { a: 'thinking' }], [100, { a: 'waiting' }], [200, { a: 'thinking' }], [MIN_WORK_MS + 1, { a: 'replied' }]])
    ).toEqual(['waiting', 'done'])
  })

  it('never rings on first sight (boot snapshot, reconnect, a new workspace)', () => {
    expect(run([[0, { a: 'waiting', b: 'replied' }]])).toEqual([])
  })

  it('does not ring for idle ↔ replied (a reply read, a resync)', () => {
    expect(run([[0, { a: 'idle' }], [10_000, { a: 'replied' }], [20_000, { a: 'idle' }]])).toEqual([])
  })

  it('ignores plain shells', () => {
    expect(run([[0, { a: 'thinking' }], [100, { a: 'waiting' }]], false)).toEqual([])
  })

  it('rings a flapping state once per REPEAT_MS', () => {
    const flap = run([
      [0, { a: 'thinking' }],
      [100, { a: 'waiting' }],
      [200, { a: 'thinking' }],
      [300, { a: 'waiting' }],
      [100 + REPEAT_MS, { a: 'thinking' }],
      [200 + REPEAT_MS, { a: 'waiting' }]
    ])
    expect(flap).toEqual(['waiting', 'waiting'])
  })

  it('forgets an agent that left the map, so its return is a first sight', () => {
    expect(run([[0, { a: 'thinking' }], [100, {}], [200, { a: 'waiting' }]])).toEqual([])
  })

  it('collapses many agents into one chime, needs-you first', () => {
    expect(chimeToPlay([])).toBeNull()
    expect(chimeToPlay(['done', 'done'])).toBe('done')
    expect(chimeToPlay(['done', 'waiting'])).toBe('waiting')
  })
})

describe('status chime — the watcher', () => {
  afterEach(() => vi.useRealTimers())

  it('plays from store changes, with a gap between chimes', () => {
    vi.useFakeTimers()
    const store = new KeyedStore<TerminalActivity>()
    const played: ChimeKind[] = []
    store.set('a', act('a', 'thinking'))
    store.set('b', act('b', 'thinking'))
    const off = installStatusChime(store, (k) => played.push(k), () => Date.now())

    store.set('a', act('a', 'waiting'))
    vi.advanceTimersByTime(500)
    expect(played).toEqual(['waiting'])

    // b asks right after: inside the gap, collapsed into the first.
    store.set('b', act('b', 'waiting'))
    vi.advanceTimersByTime(500)
    expect(played).toEqual(['waiting'])

    vi.advanceTimersByTime(MIN_WORK_MS)
    store.set('a', act('a', 'replied'))
    vi.advanceTimersByTime(500)
    expect(played).toEqual(['waiting', 'done'])

    off()
    store.set('b', act('b', 'replied'))
    vi.advanceTimersByTime(500)
    expect(played).toEqual(['waiting', 'done'])
  })
})
