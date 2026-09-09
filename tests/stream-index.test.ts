// The pure half of the one stream: ordinals, boundaries, prompt heads.

import { describe, expect, it } from 'vitest'
import {
  PROMPT_HEAD_CHARS,
  fileEntriesOf,
  promptHeadOf,
  streamIndexOf,
  streamPositionsOf
} from '../src/shared/stream-index'
import type { TraceBlock, TraceBoundaryMarker } from '../src/shared/trace-blocks'

const block = (id: string, index: number, prompt: string): TraceBlock => ({
  id,
  index,
  prompt,
  reply: '',
  activity: [],
  startedAt: index * 1000,
  endedAt: index * 1000 + 10
})

describe('promptHeadOf', () => {
  it('takes the first non-empty line and caps it', () => {
    expect(promptHeadOf('\n\n  hello there  \nsecond line')).toBe('hello there')
    const long = promptHeadOf('x'.repeat(400))
    expect(long.length).toBe(PROMPT_HEAD_CHARS)
    expect(long.endsWith('…')).toBe(true)
  })

  it('never returns an empty label', () => {
    expect(promptHeadOf('   \n  ')).toBe('(empty prompt)')
  })
})

describe('fileEntriesOf', () => {
  const blocks = [block('u1', 1, 'one'), block('u2', 2, 'two'), block('u3', 3, 'three')]
  const markers: TraceBoundaryMarker[] = [{ kind: 'compact', afterIndex: 1 }]

  it('marks the block that follows an in-file compaction boundary', () => {
    expect(fileEntriesOf(blocks, markers).map((entry) => entry.compacted)).toEqual([
      false,
      true,
      false
    ])
  })

  it('derives only from `from` onward — the append path', () => {
    const tail = fileEntriesOf(blocks, markers, 2)
    expect(tail.map((entry) => entry.identity)).toEqual(['u3'])
    expect(fileEntriesOf(blocks, markers, 99)).toEqual([])
  })
})

describe('streamPositionsOf', () => {
  const s1 = fileEntriesOf([block('u1', 1, 'one'), block('u2', 2, 'two')], [])
  const s2 = fileEntriesOf([block('u3', 1, 'three')], [])

  it('runs one ordinal through every file and keeps the coordinates', () => {
    const positions = streamPositionsOf([
      { file: 'a.jsonl', entries: s1 },
      { file: 'b.jsonl', entries: s2 }
    ])
    expect(positions.map((p) => [p.entry.ordinal, p.fileAt, p.localAt])).toEqual([
      [1, 0, 0],
      [2, 0, 1],
      [3, 1, 0]
    ])
  })

  it('a file rotation IS a boundary, even with nothing declared in-file', () => {
    const entries = streamIndexOf([
      { file: 'a.jsonl', entries: s1 },
      { file: 'b.jsonl', entries: s2 }
    ])
    expect(entries.map((entry) => entry.compacted)).toEqual([false, false, true])
  })

  it('the first block of the first file is never marked', () => {
    expect(streamIndexOf([{ file: 'a.jsonl', entries: s1 }])[0].compacted).toBe(false)
  })
})
