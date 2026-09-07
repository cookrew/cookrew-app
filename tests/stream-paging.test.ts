// INDEX PAGING (one-stream T2.5 — "index 也分页").
//
// The two properties a rail's backwards scroll depends on, tested as
// properties and not as examples: following the cursors visits every row
// EXACTLY ONCE (exhaustive) and NEVER TWICE (non-overlapping), in both
// directions, for pages that divide evenly and pages that do not.

import { describe, expect, it } from 'vitest'
import {
  MAX_STREAM_INDEX_PAGE,
  STREAM_INDEX_PAGE_LIMIT,
  indexPageLimit,
  pageByIdentity
} from '../src/shared/stream-paging'

const rows = (count: number): { identity: string; ordinal: number }[] =>
  Array.from({ length: count }, (_, at) => ({ identity: `u${at + 1}`, ordinal: at + 1 }))

/** Walk from the default (newest) page towards the oldest, collecting rows. */
function walkBackwards(all: ReturnType<typeof rows>, limit: number): string[] {
  const seen: string[] = []
  let page = pageByIdentity(all, { limit })
  seen.unshift(...page.rows.map((row) => row.identity))
  while (page.backwardsCursor !== null) {
    page = pageByIdentity(all, { before: page.backwardsCursor, limit })
    seen.unshift(...page.rows.map((row) => row.identity))
  }
  return seen
}

/** Walk from the oldest page towards the newest. */
function walkForwards(all: ReturnType<typeof rows>, limit: number): string[] {
  const seen: string[] = []
  let page = pageByIdentity(all, { before: all[0].identity, limit })
  // the oldest page: everything before the first row is nothing, so start at
  // the first row itself and page forward from it
  seen.push(all[0].identity)
  page = pageByIdentity(all, { after: all[0].identity, limit })
  seen.push(...page.rows.map((row) => row.identity))
  while (page.nextCursor !== null) {
    page = pageByIdentity(all, { after: page.nextCursor, limit })
    seen.push(...page.rows.map((row) => row.identity))
  }
  return seen
}

describe('pageByIdentity', () => {
  it('defaults to the NEWEST page — a rail opens at the bottom', () => {
    const page = pageByIdentity(rows(250), { limit: 100 })
    expect(page.rows[0].ordinal).toBe(151)
    expect(page.rows[99].ordinal).toBe(250)
    expect(page.nextCursor).toBeNull()
    expect(page.backwardsCursor).toBe('u151')
    expect(page.total).toBe(250)
  })

  it('before= is short at the start rather than shifted forward', () => {
    const page = pageByIdentity(rows(10), { before: 'u3', limit: 5 })
    expect(page.rows.map((row) => row.identity)).toEqual(['u1', 'u2'])
    expect(page.backwardsCursor).toBeNull()
    expect(page.nextCursor).toBe('u2')
  })

  it('after= starts strictly past the cursor row', () => {
    const page = pageByIdentity(rows(10), { after: 'u8', limit: 5 })
    expect(page.rows.map((row) => row.identity)).toEqual(['u9', 'u10'])
    expect(page.nextCursor).toBeNull()
    expect(page.backwardsCursor).toBe('u9')
  })

  it.each([
    [250, 100],
    [250, 25],
    [7, 3],
    [3, 100],
    [1, 1]
  ])('is exhaustive and non-overlapping backwards (%i rows, limit %i)', (count, limit) => {
    const all = rows(count)
    const seen = walkBackwards(all, limit)
    expect(seen).toEqual(all.map((row) => row.identity))
    expect(new Set(seen).size).toBe(count)
  })

  it.each([
    [250, 100],
    [250, 25],
    [7, 3]
  ])('is exhaustive and non-overlapping forwards (%i rows, limit %i)', (count, limit) => {
    const all = rows(count)
    const seen = walkForwards(all, limit)
    expect(seen).toEqual(all.map((row) => row.identity))
    expect(new Set(seen).size).toBe(count)
  })

  it('an unknown cursor is said out loud, never a silent fallback to an end', () => {
    expect(pageByIdentity(rows(5), { after: 'nope' })).toMatchObject({
      rows: [],
      unknownAfter: true
    })
    expect(pageByIdentity(rows(5), { before: 'nope' })).toMatchObject({
      rows: [],
      unknownBefore: true
    })
  })

  it('an empty list pages to nothing, with both cursors null', () => {
    expect(pageByIdentity([])).toEqual({
      rows: [],
      nextCursor: null,
      backwardsCursor: null,
      total: 0
    })
  })

  it('clamps a page to something a rail can hold', () => {
    expect(pageByIdentity(rows(1000), { limit: 99_999 }).rows).toHaveLength(MAX_STREAM_INDEX_PAGE)
    expect(pageByIdentity(rows(1000), { limit: 0 }).rows).toHaveLength(1)
  })
})

describe('indexPageLimit', () => {
  it('is the default for anything unusable, and clamped otherwise', () => {
    expect(indexPageLimit(null)).toBe(STREAM_INDEX_PAGE_LIMIT)
    expect(indexPageLimit('banana')).toBe(STREAM_INDEX_PAGE_LIMIT)
    expect(indexPageLimit('0')).toBe(1)
    expect(indexPageLimit('50')).toBe(50)
    expect(indexPageLimit('99999')).toBe(MAX_STREAM_INDEX_PAGE)
  })
})
