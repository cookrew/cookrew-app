// ONE EXCHANGE, ONE ROW (one-stream T2.5 follow-up).
//
// The claims:
//   · a uuid seen again in a LATER file with the same prompt is a REPLAY —
//     one row, the FIRST ordinal, the NEWEST file's bytes;
//   · a uuid seen again with a DIFFERENT prompt is a collision: the later
//     record is skipped, never merged into a row that would then describe two
//     different exchanges;
//   · collapsed ordinals are contiguous, so `total` counts exchanges.

import { describe, expect, it } from 'vitest'
import { collapseByIdentity, replayVerdictOf } from '../src/shared/stream-replay'
import { fileEntriesOf, streamPositionsOf } from '../src/shared/stream-index'
import type { TraceBlock } from '../src/shared/trace-blocks'

const block = (id: string, index: number, prompt: string): TraceBlock => ({
  id,
  index,
  prompt,
  reply: '',
  activity: [],
  startedAt: index * 1000,
  endedAt: index * 1000 + 10
})

/** A two-file chain where file 2 replays file 1's first `n` exchanges. */
function chain(first: TraceBlock[], second: TraceBlock[]) {
  return streamPositionsOf([
    { file: 's1.jsonl', sessionId: 's1', entries: fileEntriesOf(first, []) },
    { file: 's2.jsonl', sessionId: 's2', entries: fileEntriesOf(second, []) }
  ])
}

describe('replayVerdictOf', () => {
  it('same prompt in a new file is a replay; in a known file it is a re-read', () => {
    const held = { promptHead: 'deploy the thing', files: ['s1.jsonl'] }
    expect(replayVerdictOf(held, { file: 's2.jsonl', promptHead: 'deploy the thing' })).toBe('replay')
    expect(replayVerdictOf(held, { file: 's1.jsonl', promptHead: 'deploy the thing' })).toBe(
      'same-file'
    )
  })

  it('a different prompt under the same uuid is a collision, never a replay', () => {
    expect(
      replayVerdictOf(
        { promptHead: 'deploy the thing', files: ['s1.jsonl'] },
        { file: 's2.jsonl', promptHead: 'something else entirely' }
      )
    ).toBe('collision')
  })
})

describe('collapseByIdentity', () => {
  // file 1: u1 u2 u3 u4 ; file 2 replays u3 u4 then continues with v1 v2
  const first = [block('u1', 1, 'one'), block('u2', 2, 'two'), block('u3', 3, 'three'), block('u4', 4, 'four')]
  const second = [
    block('u3', 1, 'three'),
    block('u4', 2, 'four'),
    block('v1', 3, 'five'),
    block('v2', 4, 'six')
  ]

  it('draws each exchange once, in the order it happened', () => {
    const { positions } = collapseByIdentity(chain(first, second))
    expect(positions.map((p) => [p.entry.identity, p.entry.ordinal])).toEqual([
      ['u1', 1],
      ['u2', 2],
      ['u3', 3],
      ['u4', 4],
      ['v1', 5],
      ['v2', 6]
    ])
  })

  it('resolves a replayed exchange from the NEWEST file that holds it', () => {
    const { positions } = collapseByIdentity(chain(first, second))
    const replayed = positions[2]
    expect(replayed.entry.identity).toBe('u3')
    // ordinal from file 1 (when it happened), coordinates in file 2 (what the
    // next rotation continues from)
    expect(replayed.entry.ordinal).toBe(3)
    expect(replayed.fileAt).toBe(1)
    expect(replayed.localAt).toBe(0)
    expect(replayed.entry.replayedIn).toEqual(['s2.jsonl'])
    expect(positions[0].entry.replayedIn).toBeUndefined()
  })

  it('ordinals are contiguous, so a total counts exchanges and not copies', () => {
    const raw = chain(first, second)
    expect(raw).toHaveLength(8)
    const { positions } = collapseByIdentity(raw)
    expect(positions).toHaveLength(6)
    expect(positions.map((p) => p.entry.ordinal)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('skips a uuid a later file reused for a DIFFERENT exchange, and names it', () => {
    const collided = [block('u2', 1, 'a completely different ask'), block('v1', 2, 'five')]
    const { positions, collisions } = collapseByIdentity(chain(first, collided))
    expect(collisions).toEqual([{ identity: 'u2', file: 's2.jsonl' }])
    expect(positions.map((p) => p.entry.identity)).toEqual(['u1', 'u2', 'u3', 'u4', 'v1'])
    // the row still describes the FIRST exchange — nothing was merged into it
    expect(positions[1].entry.promptHead).toBe('two')
    expect(positions[1].fileAt).toBe(0)
  })

  it('a chain with no repeats is returned unchanged but for its numbering', () => {
    const { positions, collisions } = collapseByIdentity(chain(first, [block('v1', 1, 'five')]))
    expect(collisions).toEqual([])
    expect(positions.map((p) => p.entry.identity)).toEqual(['u1', 'u2', 'u3', 'u4', 'v1'])
  })

  it('does not mutate the walk it was given', () => {
    const raw = chain(first, second)
    const before = JSON.parse(JSON.stringify(raw))
    collapseByIdentity(raw)
    expect(raw).toEqual(before)
  })
})
