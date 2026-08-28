import { describe, expect, it } from 'vitest'
import {
  recordThumbFailure,
  recordThumbSuccess,
  shouldClearLegacyThumbs,
  shouldPollThumbs,
  shouldSnapshotLocally,
  thumbPollList
} from '../src/renderer/src/browser-thumb-policy'
import { INITIAL_BACKOFF_MS, MAX_BACKOFF_MS } from '../src/renderer/src/capture-backoff'

describe('browser thumbnail source policy', () => {
  it('polls main from the phone with headless browsers on — the bug', () => {
    // The phone showed a placeholder on every browser card because this was
    // gated to flag-off clients only.
    expect(shouldPollThumbs({ remote: true, interactive: true })).toBe(true)
  })

  it('polls main from the phone with legacy webviews too', () => {
    expect(shouldPollThumbs({ remote: true, interactive: false })).toBe(true)
  })

  it('waits until ownership is known before asking for a frame', () => {
    expect(shouldPollThumbs({ remote: true, interactive: null })).toBe(false)
  })

  it('never polls from the desktop — it produces the frames', () => {
    expect(shouldPollThumbs({ remote: false, interactive: true })).toBe(false)
    expect(shouldPollThumbs({ remote: false, interactive: false })).toBe(false)
  })

  it('snapshots the local headless page only on the desktop, flag on', () => {
    expect(shouldSnapshotLocally({ remote: false, interactive: true })).toBe(true)
    expect(shouldSnapshotLocally({ remote: false, interactive: false })).toBe(false)
    expect(shouldSnapshotLocally({ remote: false, interactive: null })).toBe(false)
    expect(shouldSnapshotLocally({ remote: true, interactive: true })).toBe(false)
  })

  it('clears retained frames on the desktop only — a phone would wipe its own', () => {
    expect(shouldClearLegacyThumbs({ remote: false, interactive: true })).toBe(true)
    expect(shouldClearLegacyThumbs({ remote: true, interactive: true })).toBe(false)
    expect(shouldClearLegacyThumbs({ remote: false, interactive: false })).toBe(false)
  })
})

describe('thumb poll backoff — the 404 storm the owner\u2019s inspector caught', () => {
  it('asks every id when nothing has failed', () => {
    expect(thumbPollList(['a', 'b'], {}, 1000)).toEqual(['a', 'b'])
  })

  it('a failed id sits out the next ticks; the healthy id keeps polling', () => {
    const after = recordThumbFailure({}, 'a', 1000)
    // 5s later — the poll interval — 'a' is still inside its 10s backoff.
    expect(thumbPollList(['a', 'b'], after, 6000)).toEqual(['b'])
    // Once the desktop-tier initial backoff passes it is asked again.
    expect(thumbPollList(['a', 'b'], after, 1000 + INITIAL_BACKOFF_MS)).toEqual(['a', 'b'])
  })

  it('repeated failures back off exponentially to the desktop cap', () => {
    let b = recordThumbFailure({}, 'a', 0)
    for (let i = 0; i < 10; i += 1) b = recordThumbFailure(b, 'a', 0)
    expect(thumbPollList(['a'], b, MAX_BACKOFF_MS - 1)).toEqual([])
    expect(thumbPollList(['a'], b, MAX_BACKOFF_MS)).toEqual(['a'])
  })

  it('one success ends the backoff — a recovered browser refreshes normally', () => {
    const failed = recordThumbFailure({}, 'a', 1000)
    const healed = recordThumbSuccess(failed, 'a')
    expect(thumbPollList(['a'], healed, 1001)).toEqual(['a'])
  })

  it('records immutably — the prior map is never mutated', () => {
    const before = {}
    const after = recordThumbFailure(before, 'a', 1)
    expect(before).toEqual({})
    expect(after).not.toBe(before)
    expect(recordThumbSuccess(after, 'missing')).toBe(recordThumbSuccess(after, 'missing'))
  })
})
