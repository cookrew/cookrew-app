// The gate's judgement: OK, DIFF, and exactly which differences are allowed.
// If this file is wrong, the equivalence run is a rubber stamp.

import { describe, expect, it } from 'vitest'
import {
  ALLOWED_CLASSES,
  alignAt,
  compareCheckpoints,
  oldCheckpointOf,
  type OldCheckpoint,
  type StreamCheckpointRef
} from '../src/shared/stream-equivalence'

const older = (identity: string, index: number, title?: string): OldCheckpoint => ({
  index,
  identity,
  ...(title !== undefined ? { title } : {})
})

const row = (identity: string, ordinal: number, title?: string): StreamCheckpointRef => ({
  ordinal,
  identity,
  ...(title !== undefined ? { title } : {})
})

describe('alignAt', () => {
  it('finds the contiguous run and refuses a scattered one', () => {
    expect(alignAt(['a', 'b', 'c', 'd'], ['c', 'd'])).toBe(2)
    expect(alignAt(['a', 'b', 'c'], ['a', 'c'])).toBe(-1)
    expect(alignAt(['a'], [])).toBe(0)
  })
})

describe('compareCheckpoints — OK', () => {
  it('same identities in the same order, no titles either side', () => {
    const result = compareCheckpoints(
      [older('u1', 1), older('u2', 2)],
      [row('u1', 41), row('u2', 42)]
    )
    expect(result.ok).toBe(true)
    expect(result.allowed).toBe(true)
    expect(result.counts).toEqual({ old: 2, stream: 2, compared: 2 })
  })

  it('ordinals are NEVER compared — that disagreement is the bug being fixed', () => {
    // The old ledger numbered the current file 1..2; the stream numbers the
    // whole chain 400..401. Same exchanges, different coordinate space.
    expect(compareCheckpoints([older('u1', 1), older('u2', 2)], [row('u1', 400), row('u2', 401)]).ok)
      .toBe(true)
  })
})

describe('compareCheckpoints — allowed classes', () => {
  it('stream-reaches-back: the pre-compaction history the ledger could not address', () => {
    const result = compareCheckpoints([older('u3', 1)], [row('u1', 1), row('u2', 2), row('u3', 3)])
    expect(result.ok).toBe(false)
    expect(result.allowed).toBe(true)
    expect(result.classCounts).toEqual({ 'stream-reaches-back': 1 })
    expect(result.differences[0].detail).toContain('2 block(s) before')
  })

  it('stream-ahead: turns the transcript has and the ledger never persisted', () => {
    const result = compareCheckpoints([older('u1', 1)], [row('u1', 1), row('u2', 2)])
    expect(result.allowed).toBe(true)
    expect(result.classCounts).toEqual({ 'stream-ahead': 1 })
  })

  it('old-noise-prompt: a record the current rule would never mint', () => {
    const noisy = oldCheckpointOf({ index: 1, prompt: '<command-name>clear</command-name>', uuid: 'n1' })
    expect(noisy.noise).toBe(true)
    const result = compareCheckpoints([noisy, older('u1', 2)], [row('u1', 1)])
    expect(result.allowed).toBe(true)
    expect(result.classCounts).toEqual({ 'old-noise-prompt': 1 })
  })

  it('legacy-no-uuid: a scrape-era record with nothing to pair on', () => {
    const legacy = oldCheckpointOf({ index: 1, prompt: 'typed at the pane' })
    expect(legacy.legacy).toBe(true)
    const result = compareCheckpoints([legacy], [])
    expect(result.allowed).toBe(true)
    expect(result.classCounts).toEqual({ 'legacy-no-uuid': 1 })
  })

  it('title-unmigrated: T1 writes no marks, so every old title is unclaimed', () => {
    const result = compareCheckpoints([older('u1', 1, 'ran the suite')], [row('u1', 1)])
    expect(result.allowed).toBe(true)
    expect(result.classCounts).toEqual({ 'title-unmigrated': 1 })
    expect(result.differences[0]).toMatchObject({ identity: 'u1', ordinal: 1, field: 'title' })
  })

  it('no-transcript: the card has no readable file at all', () => {
    const result = compareCheckpoints([older('u1', 1)], [], { streamAvailable: false })
    expect(result.allowed).toBe(true)
    expect(result.classCounts).toEqual({ 'no-transcript': 1 })
  })

  it('every allowed class is a property of the OLD store, and the list is closed', () => {
    expect([...ALLOWED_CLASSES].sort()).toEqual([
      'legacy-no-uuid',
      'no-transcript',
      'old-noise-prompt',
      'stream-ahead',
      'stream-reaches-back',
      'title-unmigrated'
    ])
  })
})

describe('compareCheckpoints — real differences fail the gate', () => {
  it('an identity the stream cannot produce', () => {
    const result = compareCheckpoints([older('u1', 1), older('ghost', 2)], [row('u1', 1)])
    expect(result.allowed).toBe(false)
    expect(result.classCounts['identity-missing']).toBe(1)
    expect(result.differences[0]).toMatchObject({ class: 'identity-missing', identity: 'ghost' })
  })

  it('an identity only the stream holds, out of alignment', () => {
    const result = compareCheckpoints(
      [older('u1', 1), older('u3', 2)],
      [row('u1', 1), row('u2', 2), row('u3', 3)]
    )
    expect(result.allowed).toBe(false)
    expect(result.classCounts['identity-extra']).toBe(1)
  })

  it('the same members in a different order', () => {
    const result = compareCheckpoints(
      [older('u1', 1), older('u2', 2)],
      [row('u2', 1), row('u1', 2)]
    )
    expect(result.allowed).toBe(false)
    expect(result.classCounts['identity-order']).toBe(1)
    expect(result.differences[0].detail).toContain('position 1')
  })

  it('two different titles for the same exchange', () => {
    const result = compareCheckpoints([older('u1', 1, 'old title')], [row('u1', 1, 'new title')])
    expect(result.allowed).toBe(false)
    expect(result.classCounts['title-differs']).toBe(1)
  })

  it('a title the old store never had', () => {
    const result = compareCheckpoints([older('u1', 1)], [row('u1', 1, 'invented')])
    expect(result.allowed).toBe(false)
    expect(result.classCounts['title-only-in-stream']).toBe(1)
  })
})
