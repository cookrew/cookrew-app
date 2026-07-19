import { describe, expect, it } from 'vitest'
import { appendTurnRecord, TurnRecord } from '../src/shared/turn'
import { buildForkPreamble } from '../src/shared/fork'

function turn(index: number, overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    index,
    prompt: `prompt ${index}`,
    reply: `reply ${index}`,
    startedAt: 1000 * index,
    endedAt: 1000 * index + 500,
    ...overrides
  }
}

describe('appendTurnRecord', () => {
  it('assigns 1-based monotonic indexes', () => {
    const first = appendTurnRecord([], { prompt: 'a', reply: 'r', startedAt: 1, endedAt: 2 })
    expect(first).toHaveLength(1)
    expect(first[0].index).toBe(1)
    const second = appendTurnRecord(first, { prompt: 'b', reply: 'r', startedAt: 3, endedAt: 4 })
    expect(second[1].index).toBe(2)
  })

  it('does not mutate the input history', () => {
    const history = [turn(1)]
    const next = appendTurnRecord(history, { prompt: 'b', reply: 'r', startedAt: 1, endedAt: 2 })
    expect(history).toHaveLength(1)
    expect(next).toHaveLength(2)
    expect(next).not.toBe(history)
  })

  it('caps history but keeps indexes stable', () => {
    let history: TurnRecord[] = []
    for (let i = 0; i < 5; i += 1) {
      history = appendTurnRecord(history, { prompt: `p${i}`, reply: 'r', startedAt: i, endedAt: i }, 3)
    }
    expect(history).toHaveLength(3)
    expect(history.map((t) => t.index)).toEqual([3, 4, 5])
  })
})

describe('buildForkPreamble', () => {
  it('replays turns up to the fork point only', () => {
    const preamble = buildForkPreamble({
      forkName: 'Coder ⑂T2',
      sourceName: 'Coder',
      turns: [turn(1), turn(2), turn(3)],
      turnIndex: 2
    })
    expect(preamble).toContain('── Turn 1 ──')
    expect(preamble).toContain('── Turn 2 ──')
    expect(preamble).not.toContain('── Turn 3 ──')
    expect(preamble).toContain('prompt 2')
    expect(preamble).toContain('reply 2')
  })

  it('names the fork, the source and the fork point', () => {
    const preamble = buildForkPreamble({
      forkName: 'Coder ⑂T1',
      sourceName: 'Coder',
      turns: [turn(1)],
      turnIndex: 1
    })
    expect(preamble).toContain('"Coder ⑂T1"')
    expect(preamble).toContain('"Coder"')
    expect(preamble).toContain('after turn 1')
    expect(preamble).toContain('right after turn 1')
  })

  it('throws when no turns exist up to the requested index', () => {
    expect(() =>
      buildForkPreamble({ forkName: 'f', sourceName: 's', turns: [turn(5)], turnIndex: 2 })
    ).toThrow(/No turns/)
  })

  it('elides oldest turns beyond the budget with a marker', () => {
    const big = 'x'.repeat(1500)
    const turns = Array.from({ length: 40 }, (_, i) => turn(i + 1, { reply: big }))
    const preamble = buildForkPreamble({
      forkName: 'f',
      sourceName: 's',
      turns,
      turnIndex: 40
    })
    expect(preamble.length).toBeLessThan(25000)
    expect(preamble).toMatch(/\[… \d+ earlier turns omitted …\]/)
    expect(preamble).toContain('── Turn 40 ──')
    expect(preamble).not.toContain('── Turn 1 ──')
  })

  it('truncates oversized prompts and replies per turn', () => {
    const preamble = buildForkPreamble({
      forkName: 'f',
      sourceName: 's',
      turns: [turn(1, { prompt: 'p'.repeat(2000), reply: 'r'.repeat(5000) })],
      turnIndex: 1
    })
    expect(preamble).toContain('…')
    expect(preamble.length).toBeLessThan(4000)
  })
})
