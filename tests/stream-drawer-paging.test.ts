// THE DRAWER PAGES BY IDENTITY, NEVER BY POSITION (one-stream T3).
//
// The pager used to address windows by a NUMBER that a /compact restarted, so
// a jump into an earlier segment landed on a different turn than the one that
// was clicked. Identities do not restart, so the whole paging rule reduces to
// one question: which identity does the window start after, so that the block
// somebody asked for is inside it?
//
// The routes' cursors are EXCLUSIVE, which is the trap: `before=<identity>`
// returns the page that stops one short of the block the caller wants.

import { describe, expect, it } from 'vitest'
import { anchorFor, patchToMark } from '../src/renderer/src/stream/stream-reducer'
import type { StreamCheckpoint } from '../src/renderer/src/stream/stream-types'

const index = (n: number): StreamCheckpoint[] =>
  Array.from({ length: n }, (_, i) => ({
    identity: `u${i + 1}`,
    ordinal: i + 1,
    startedAt: i,
    endedAt: i,
    promptHead: `prompt ${i + 1}`,
    compacted: false,
    file: '/s1.jsonl'
  }))

describe('anchorFor — the window that contains the block you asked for', () => {
  const rows = index(100)

  it('starts half a window earlier, so the target sits mid-page', () => {
    // Target u50: the window should begin at u40, so it is asked for AFTER u39.
    expect(anchorFor(rows, 'u50', 20)).toBe('u39')
  })

  it('the target is inside the page the anchor produces', () => {
    const limit = 20
    for (const target of ['u1', 'u2', 'u10', 'u50', 'u99', 'u100']) {
      const anchor = anchorFor(rows, target, limit)
      const start = anchor === null ? 0 : rows.findIndex((r) => r.identity === anchor) + 1
      const page = rows.slice(start, start + limit).map((r) => r.identity)
      expect(page).toContain(target)
    }
  })

  it('near the oldest end there is nothing to anchor to, so the page starts there', () => {
    expect(anchorFor(rows, 'u1', 20)).toBeNull()
    expect(anchorFor(rows, 'u10', 20)).toBeNull()
    expect(anchorFor(rows, 'u11', 20)).toBeNull()
    expect(anchorFor(rows, 'u12', 20)).toBe('u1')
  })

  it('near the newest end the window is short rather than shifted', () => {
    const anchor = anchorFor(rows, 'u100', 20)
    expect(anchor).toBe('u89')
    const start = rows.findIndex((r) => r.identity === anchor) + 1
    expect(rows.slice(start, start + 20).map((r) => r.identity)).toContain('u100')
  })

  it('an identity this client has not indexed starts at the oldest, never guesses', () => {
    expect(anchorFor(rows, 'u-unknown', 20)).toBeNull()
  })

  it('an odd limit still contains its target', () => {
    const anchor = anchorFor(rows, 'u50', 7)
    const start = rows.findIndex((r) => r.identity === anchor) + 1
    expect(rows.slice(start, start + 7).map((r) => r.identity)).toContain('u50')
  })

  it('an empty index has nothing to anchor to', () => {
    expect(anchorFor([], 'u1', 20)).toBeNull()
  })
})

describe('patchToMark — the optimistic row a write implies', () => {
  const rows: StreamCheckpoint[] = [
    { ...index(1)[0], marks: { title: 'old title', seenAt: 5 } }
  ]

  it('sets the field it names and leaves the rest of the mark alone', () => {
    expect(patchToMark(rows, { identity: 'u1', title: 'new title' })).toEqual({
      title: 'new title',
      seenAt: 5
    })
  })

  it('a null CLEARS the field, because withdrawn and never-written differ', () => {
    expect(patchToMark(rows, { identity: 'u1', title: null })).toEqual({ seenAt: 5 })
  })

  it('a row with no marks yet starts from nothing', () => {
    expect(patchToMark(index(1), { identity: 'u1', seenAt: 9 })).toEqual({ seenAt: 9 })
  })

  it('never carries the identity into the marks — that is the ledger’s key', () => {
    expect(patchToMark(rows, { identity: 'u1', pin: 3 })).not.toHaveProperty('identity')
  })
})
