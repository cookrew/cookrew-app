import { describe, expect, it } from 'vitest'
import {
  activeIndexForScroll,
  checkpointTitle,
  spansFromRecords,
  type CheckpointSpan
} from '../src/renderer/src/checkpoint-sync'
import type { TurnRecord } from '../src/shared/turn'

const record = (over: Partial<TurnRecord> = {}): TurnRecord => ({
  index: 1,
  prompt: 'do the thing\nwith a newline',
  reply: 'done',
  startedAt: 0,
  endedAt: 1,
  ...over
})

describe('checkpointTitle (item 3 dual title mode)', () => {
  it('conclusion mode prefers the Sous title', () => {
    expect(checkpointTitle(record({ title: 'Did the thing' }), 'conclusion')).toBe('Did the thing')
  })

  it('conclusion mode falls back to the prompt when no title', () => {
    expect(checkpointTitle(record({ title: undefined }), 'conclusion')).toBe(
      'do the thing\nwith a newline'
    )
  })

  it('precise mode always shows the exact prompt incl. newlines', () => {
    expect(checkpointTitle(record({ title: 'Did the thing' }), 'precise')).toBe(
      'do the thing\nwith a newline'
    )
  })

  it('handles an empty prompt gracefully', () => {
    expect(checkpointTitle(record({ title: undefined, prompt: '' }), 'precise')).toBe(
      '(empty prompt)'
    )
  })
})

describe('spansFromRecords (item 2 offset mapping)', () => {
  it('derives ascending spans from TurnRecord.scrollLine', () => {
    const spans = spansFromRecords([
      { index: 1, scrollLine: 0 },
      { index: 2, scrollLine: 12 },
      { index: 3, scrollLine: 40 }
    ])
    expect(spans).toEqual([
      { index: 1, top: 0, height: 12 },
      { index: 2, top: 12, height: 28 },
      { index: 3, top: 40, height: 1 }
    ])
  })

  it('skips records without an offset (best-effort tracker)', () => {
    const spans = spansFromRecords([
      { index: 1, scrollLine: 0 },
      { index: 2 },
      { index: 3, scrollLine: 20 }
    ])
    expect(spans.map((s) => s.index)).toEqual([1, 3])
  })

  it('sorts by offset even when records arrive out of order', () => {
    const spans = spansFromRecords([
      { index: 3, scrollLine: 40 },
      { index: 1, scrollLine: 0 }
    ])
    expect(spans.map((s) => s.index)).toEqual([1, 3])
  })
})

describe('activeIndexForScroll (item 2 scroll→checkpoint)', () => {
  const spans: CheckpointSpan[] = [
    { index: 1, top: 0, height: 10 },
    { index: 2, top: 10, height: 20 },
    { index: 3, top: 30, height: 15 }
  ]

  it('returns null for an empty map', () => {
    expect(activeIndexForScroll([], 5)).toBeNull()
  })

  it('maps a row inside a span to that checkpoint', () => {
    expect(activeIndexForScroll(spans, 5)).toBe(1)
    expect(activeIndexForScroll(spans, 15)).toBe(2)
    expect(activeIndexForScroll(spans, 40)).toBe(3)
  })

  it('maps a row at a span boundary to the newer checkpoint', () => {
    expect(activeIndexForScroll(spans, 10)).toBe(2)
    expect(activeIndexForScroll(spans, 30)).toBe(3)
  })

  it('clamps a row before the first span to the oldest checkpoint', () => {
    expect(activeIndexForScroll(spans, -5)).toBe(1)
  })

  it('a row past the last span stays on the last checkpoint', () => {
    expect(activeIndexForScroll(spans, 999)).toBe(3)
  })
})
