// THE ONE REVERSE AUTHORITY, AND THE READ-REPAIR PATH (T2.5, panel C ④).
//
// The claim under test is the one stream-authority.ts states in prose: the
// files are authoritative for everything they contain, so every disagreement
// with the persisted state is repaired IN FAVOUR OF THE FILES, with one log
// line, and nothing is deleted.

import { describe, expect, it } from 'vitest'
import {
  logStreamRepairs,
  repairStreamState,
  type AuthorityEvidence
} from '../src/main/stream-authority'
import { emptyStreamState, type StreamState } from '../src/main/stream-state'

const T0 = Date.parse('2026-09-07T09:00:00.000Z')

function row(ordinal: number, over: Record<string, unknown> = {}) {
  return {
    identity: `u${ordinal}`,
    ordinal,
    startedAt: T0,
    endedAt: T0 + 100,
    promptHead: `p${ordinal}`,
    compacted: false,
    file: '/tmp/s1.jsonl',
    firstAt: T0,
    latestAt: T0 + 100,
    occurrences: [{ file: '/tmp/s1.jsonl' }],
    ...over
  }
}

function state(over: Partial<StreamState> = {}): StreamState {
  return {
    ...emptyStreamState(),
    cursor: { file: '/tmp/s1.jsonl', byteOffset: 1000, ordinal: 3 },
    index: [row(1), row(2), row(3)],
    ...over
  }
}

const files = (over: Partial<AuthorityEvidence> = {}): AuthorityEvidence => ({
  cursorFileBytes: 1000,
  tailFile: '/tmp/s1.jsonl',
  ...over
})

describe('repairStreamState', () => {
  it('agrees with the files: no repair, no change', () => {
    const result = repairStreamState(state(), files())
    expect(result.repairs).toEqual([])
    expect(result.state).toEqual(state())
  })

  it('cursor-beyond-eof: the file wins and the cursor is clamped', () => {
    const result = repairStreamState(state(), files({ cursorFileBytes: 400 }))
    expect(result.repairs.map((repair) => repair.kind)).toEqual(['cursor-beyond-eof'])
    expect(result.state.cursor.byteOffset).toBe(400)
    // and nothing is deleted
    expect(result.state.index).toHaveLength(3)
  })

  it('missing-file: the cursor moves to the chain tail and keeps the high-water mark', () => {
    const result = repairStreamState(
      state(),
      files({ cursorFileBytes: null, tailFile: '/tmp/s2.jsonl' })
    )
    expect(result.repairs.map((repair) => repair.kind)).toEqual(['missing-file'])
    expect(result.state.cursor).toEqual({ file: '/tmp/s2.jsonl', byteOffset: 0, ordinal: 3 })
    expect(result.state.index).toHaveLength(3)
  })

  it('ordinal-regression: a row above the mark raises the mark, never lowers a row', () => {
    const behind = state({ cursor: { file: '/tmp/s1.jsonl', byteOffset: 1000, ordinal: 1 } })
    const result = repairStreamState(behind, files())
    expect(result.repairs.map((repair) => repair.kind)).toEqual(['ordinal-regression'])
    expect(result.state.cursor.ordinal).toBe(3)
    expect(result.state.index.map((entry) => entry.ordinal)).toEqual([1, 2, 3])
  })

  it('chain-grew-behind: rebuild, keeping the rolled-back rows at the low end', () => {
    const withRollback = state({
      index: [row(1), row(2), row(3, { rolledBack: true })],
      rolledBack: [{ fromOrdinal: 3, at: T0 }]
    })
    const result = repairStreamState(withRollback, files({ chainGrewBehind: true }))
    expect(result.repairs.map((repair) => repair.kind)).toEqual(['chain-grew-behind'])
    expect(result.state.index.map((entry) => entry.identity)).toEqual(['u3'])
    // the mark survives a rebuild — the bytes are gone, so no replay finds it
    expect(result.state.rolledBack).toEqual([{ fromOrdinal: 3, at: T0 }])
    // and the next block is numbered ABOVE it: ordinals never regress
    expect(result.state.cursor).toEqual({ file: '', byteOffset: 0, ordinal: 3 })
  })

  it('never mutates the state it was handed', () => {
    const before = state()
    const snapshot = JSON.parse(JSON.stringify(before))
    repairStreamState(before, files({ cursorFileBytes: 1 }))
    expect(before).toEqual(snapshot)
  })
})

describe('logStreamRepairs', () => {
  it('writes exactly one greppable line per repair, and no path beyond a file name', () => {
    const lines: string[] = []
    const result = repairStreamState(
      state({ cursor: { file: '/Users/someone/projects/deep/s1.jsonl', byteOffset: 9, ordinal: 1 } }),
      files({ cursorFileBytes: 4 })
    )
    logStreamRepairs('term-1', result.repairs, (message) => lines.push(message))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^stream read-repair: term-1 cursor-beyond-eof — /)
    expect(lines[1]).toMatch(/^stream read-repair: term-1 ordinal-regression — /)
    expect(lines.join('\n')).not.toContain('/Users/someone')
    expect(lines[0]).toContain('s1.jsonl')
  })

  it('says nothing when nothing disagreed', () => {
    const lines: string[] = []
    logStreamRepairs('term-1', [], (message) => lines.push(message))
    expect(lines).toEqual([])
  })
})
