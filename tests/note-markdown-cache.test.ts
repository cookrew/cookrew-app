import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  clearNoteMarkdownCache,
  noteMarkdownCacheKey,
  noteMarkdownCacheStats,
  noteMarkdownEntryBytes,
  renderNoteMarkdown
} from '../src/renderer/src/note-markdown'

/**
 * The render cache is bounded in BYTES, not entries (perf lane L3). These
 * tests drive it with a small budget through the test seam so that eviction
 * happens on notes a unit test can afford to render, and assert the shape of
 * the bound: what is evicted, in which order, and what the accounting says.
 */

/** A note whose rendered HTML is roughly `chars` long. */
function note(tag: string, chars: number): string {
  return `${tag} ${'x'.repeat(Math.max(0, chars - tag.length - 1))}`
}

/**
 * Whether `source` answers from the cache RIGHT NOW. Strings are primitives:
 * Object.is on two equal renders is true whether or not one was cached, so
 * the only observable is the counter. A probe that misses is itself an
 * insertion, so callers ask about a source once and in the order they mean.
 */
function isCached(source: string): boolean {
  const before = noteMarkdownCacheStats()
  renderNoteMarkdown(source)
  const after = noteMarkdownCacheStats()
  return after.hits === before.hits + 1 && after.misses === before.misses
}

const KB = 1024

describe('byte accounting', () => {
  beforeEach(() => clearNoteMarkdownCache(16 * KB))
  afterAll(() => clearNoteMarkdownCache())

  it('starts empty and reports the budget it was given', () => {
    expect(noteMarkdownCacheStats()).toEqual({ entries: 0, bytes: 0, maxBytes: 16 * KB, hits: 0, misses: 0, bypasses: 0 })
  })

  it('charges each entry its key plus its html at two bytes a char, plus a fixed overhead', () => {
    const src = note('a', 1000)
    const html = renderNoteMarkdown(src)
    const key = noteMarkdownCacheKey(src)
    const expected = noteMarkdownEntryBytes(key, html)
    expect(expected).toBe(128 + 2 * (key.length + html.length))
    expect(noteMarkdownCacheStats()).toMatchObject({ entries: 1, bytes: expected, maxBytes: 16 * KB, misses: 1 })
  })

  it('a hit adds nothing', () => {
    const src = note('a', 1000)
    renderNoteMarkdown(src)
    const once = noteMarkdownCacheStats()
    renderNoteMarkdown(src)
    renderNoteMarkdown(src)
    expect(noteMarkdownCacheStats()).toEqual({ ...once, hits: 2 })
  })

  it('the total is the sum of the entries and never exceeds the budget', () => {
    let sum = 0
    for (let i = 0; i < 40; i += 1) {
      const src = note(`n${i}`, 500 + i * 37)
      const html = renderNoteMarkdown(src)
      sum += noteMarkdownEntryBytes(noteMarkdownCacheKey(src), html)
      const stats = noteMarkdownCacheStats()
      expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes)
      expect(stats.bytes).toBeGreaterThan(0)
    }
    // Forty entries of this size are far more than 16 KB: the cache kept some
    // and dropped the rest, and what it reports is what it holds.
    const { entries, bytes } = noteMarkdownCacheStats()
    expect(entries).toBeLessThan(40)
    expect(bytes).toBeLessThan(sum)
  })

  it('clear returns the accounting to zero and the budget to its default', () => {
    renderNoteMarkdown(note('a', 1000))
    clearNoteMarkdownCache()
    expect(noteMarkdownCacheStats()).toEqual({ entries: 0, bytes: 0, maxBytes: 8 * 1024 * 1024, hits: 0, misses: 0, bypasses: 0 })
  })
})

describe('eviction order', () => {
  // Each note renders to ~2 KB of HTML → ~4.2 KB accounted; three fit in 16 KB, a fourth does not.
  const A = note('A', 2000)
  const B = note('B', 2000)
  const C = note('C', 2000)
  const D = note('D', 2000)

  beforeEach(() => clearNoteMarkdownCache(16 * KB))
  afterAll(() => clearNoteMarkdownCache())

  it('evicts the oldest insertion first, and only as many as the newcomer needs', () => {
    renderNoteMarkdown(A)
    renderNoteMarkdown(B)
    renderNoteMarkdown(C)
    expect(noteMarkdownCacheStats().entries).toBe(3)
    renderNoteMarkdown(D)
    expect(noteMarkdownCacheStats().entries).toBe(3)
    // A went; B, C and D stayed.
    expect(isCached(B)).toBe(true)
    expect(isCached(C)).toBe(true)
    expect(isCached(D)).toBe(true)
    // A is a miss now, and re-inserting it evicts B, the next oldest, not C.
    expect(isCached(A)).toBe(false)
    expect(noteMarkdownCacheStats().entries).toBe(3)
    expect(isCached(C)).toBe(true)
    expect(isCached(D)).toBe(true)
    expect(isCached(A)).toBe(true)
    expect(isCached(B)).toBe(false)
  })

  it('a read does not refresh position — insertion order, not LRU', () => {
    renderNoteMarkdown(A)
    renderNoteMarkdown(B)
    renderNoteMarkdown(C)
    expect(isCached(A)).toBe(true) // a hit: must NOT move A to the back
    renderNoteMarkdown(D) // needs room: the oldest INSERTION is still A
    expect(isCached(B)).toBe(true)
    expect(isCached(A)).toBe(false)
  })

  it('evicts several small entries to admit one large one', () => {
    for (let i = 0; i < 6; i += 1) renderNoteMarkdown(note(`s${i}`, 900)) // ~2 KB each
    const before = noteMarkdownCacheStats()
    expect(before.entries).toBe(6)
    const big = note('big', 6000) // ~12 KB accounted: needs more than half the budget
    renderNoteMarkdown(big)
    const after = noteMarkdownCacheStats()
    expect(after.bytes).toBeLessThanOrEqual(after.maxBytes)
    expect(isCached(big)).toBe(true)
    // The survivors are the NEWEST small ones.
    expect(isCached(note('s0', 900))).toBe(false)
    expect(isCached(note('s5', 900))).toBe(true)
  })
})

describe('oversized bypass', () => {
  beforeEach(() => clearNoteMarkdownCache(16 * KB))
  afterAll(() => clearNoteMarkdownCache())

  it('a note larger than the whole budget renders correctly but is not cached, and evicts nothing', () => {
    const small = note('small', 1000)
    renderNoteMarkdown(small)
    const before = noteMarkdownCacheStats()
    const huge = `# Big\n\n${'- **row** with `code`\n'.repeat(1500)}` // ~40 KB of html, > 16 KB
    const html = renderNoteMarkdown(huge)
    expect(html).toContain('<h1>Big</h1>')
    expect(html).toContain('<strong>row</strong>')
    // Nothing changed in the cache: not the count, not the bytes, not the small entry.
    expect(noteMarkdownCacheStats()).toEqual({ ...before, bypasses: 1 })
    expect(isCached(small)).toBe(true)
    // And the huge note bypasses every time.
    expect(renderNoteMarkdown(huge)).toBe(html)
    expect(noteMarkdownCacheStats().bypasses).toBe(2)
  })

  it('an entry whose html alone exceeds the budget is bypassed even when its source did not', () => {
    // Source under budget (7,800 chars, 15.6 KB at 2 bytes/char) that expands
    // past it: every line becomes a list item wrapped in tags, ~3x the source.
    const src = '- *i*\n'.repeat(1300)
    expect(2 * src.length).toBeLessThan(16 * KB)
    const html = renderNoteMarkdown(src)
    expect(noteMarkdownEntryBytes(noteMarkdownCacheKey(src), html)).toBeGreaterThan(16 * KB)
    expect(noteMarkdownCacheStats()).toMatchObject({ entries: 0, bytes: 0, misses: 0, bypasses: 1 })
  })
})

describe('the key', () => {
  it('is a pure function of the content and carries its length', () => {
    const src = note('k', 3000)
    expect(noteMarkdownCacheKey(src)).toBe(noteMarkdownCacheKey(`${src.slice(0, 10)}${src.slice(10)}`))
    expect(noteMarkdownCacheKey(src).startsWith(`${src.length}:`)).toBe(true)
  })

  it('is short — it never carries the source', () => {
    expect(noteMarkdownCacheKey('x'.repeat(200_000)).length).toBeLessThan(40)
  })

  it('differs for content that differs anywhere, including past the first chunk', () => {
    const base = 'y'.repeat(70_000) // two 64 KB chunks
    const flipped = `${base.slice(0, 69_000)}Z${base.slice(69_001)}`
    expect(flipped.length).toBe(base.length)
    expect(noteMarkdownCacheKey(flipped)).not.toBe(noteMarkdownCacheKey(base))
    // and a non-Latin-1 body hashes to something else again
    expect(noteMarkdownCacheKey('笔记 内容')).not.toBe(noteMarkdownCacheKey('笔记 內容'))
  })
})

describe('identity', () => {
  beforeEach(() => clearNoteMarkdownCache())

  it('a hit returns the stored render, and an equal but distinct source string is a hit too', () => {
    const src = '# heading\n\n- one\n- two\n\nsome **bold** text'
    const first = renderNoteMarkdown(src)
    expect(renderNoteMarkdown(src)).toBe(first)
    expect(renderNoteMarkdown(`${src.slice(0, 5)}${src.slice(5)}`)).toBe(first)
    expect(noteMarkdownCacheStats()).toMatchObject({ entries: 1, hits: 2, misses: 1, bypasses: 0 })
  })
})
