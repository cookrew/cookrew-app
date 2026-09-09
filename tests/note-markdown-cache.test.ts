import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  SideCache,
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
    expect(noteMarkdownCacheStats()).toEqual({ entries: 0, bytes: 0, maxBytes: 16 * KB, maxSideBytes: 32 * KB, hits: 0, misses: 0, oversizedParses: 0, illFormedParses: 0, oversizedBytes: 0, illFormedBytes: 0 })
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
    expect(noteMarkdownCacheStats()).toEqual({ entries: 0, bytes: 0, maxBytes: 8 * 1024 * 1024, maxSideBytes: 16 * 1024 * 1024, hits: 0, misses: 0, oversizedParses: 0, illFormedParses: 0, oversizedBytes: 0, illFormedBytes: 0 })
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

  // ~13K chars of html: 27 KB accounted — over the 16 KB budget, under the 64 KB slot cap.
  const huge = `# Big\n\n${'- **row** with `code`\n'.repeat(250)}`

  it('a note larger than the whole budget renders correctly, stays out of the map, and evicts nothing', () => {
    const small = note('small', 1000)
    renderNoteMarkdown(small)
    const before = noteMarkdownCacheStats()
    const html = renderNoteMarkdown(huge)
    expect(html).toContain('<h1>Big</h1>')
    expect(html).toContain('<strong>row</strong>')
    // Nothing changed in the map: not the count, not the bytes, not the small entry.
    const weight = noteMarkdownEntryBytes(noteMarkdownCacheKey(huge), html)
    expect(weight).toBeGreaterThan(16 * KB)
    expect(noteMarkdownCacheStats()).toEqual({ ...before, oversizedParses: 1, oversizedBytes: weight })
    expect(isCached(small)).toBe(true)
  })

  it('the side cache answers the same oversized note again without a re-parse, under its own byte cap', () => {
    const html = renderNoteMarkdown(huge)
    expect(noteMarkdownCacheStats()).toMatchObject({ oversizedParses: 1, hits: 0 })
    expect(renderNoteMarkdown(huge)).toBe(html)
    expect(noteMarkdownCacheStats()).toMatchObject({ oversizedParses: 1, hits: 1, entries: 0, bytes: 0 })
    // Two oversized notes are each over the budget, so together they are over
    // the two-budget cap: the second evicts the first. This is the named
    // cliff — for notes that are, at the real budget, 70x the largest measured.
    const other = `# Other\n\n${'- *row*\n'.repeat(700)}` // ~28 KB accounted: over budget, under the cap
    renderNoteMarkdown(other)
    const stats = noteMarkdownCacheStats()
    expect(stats).toMatchObject({ oversizedParses: 2, hits: 1, entries: 0, bytes: 0 })
    expect(stats.oversizedBytes).toBe(noteMarkdownEntryBytes(noteMarkdownCacheKey(other), renderNoteMarkdown(other)))
    expect(stats.oversizedBytes).toBeLessThanOrEqual(stats.maxSideBytes)
    expect(isCached(huge)).toBe(false)
  })

  it('the side cache is bounded too: a render above its cap is not kept at all', () => {
    // 16 KB budget, 32 KB side cap: anything over 32 KB accounted is dropped after it is returned.
    const giant = `# Giant\n\n${'- **row** with `code`\n'.repeat(6000)}` // ~320 KB of html
    const html = renderNoteMarkdown(giant)
    expect(noteMarkdownEntryBytes(noteMarkdownCacheKey(giant), html)).toBeGreaterThan(32 * KB)
    expect(noteMarkdownCacheStats()).toMatchObject({ oversizedParses: 1, oversizedBytes: 0, entries: 0 })
    expect(renderNoteMarkdown(giant)).toBe(html)
    expect(noteMarkdownCacheStats()).toMatchObject({ oversizedParses: 2, hits: 0, oversizedBytes: 0 })
    // A render that does not fit does not disturb what the cache already holds.
    renderNoteMarkdown(huge)
    const kept = noteMarkdownCacheStats().oversizedBytes
    expect(kept).toBeGreaterThan(0)
    renderNoteMarkdown(giant)
    expect(noteMarkdownCacheStats().oversizedBytes).toBe(kept)
    expect(isCached(huge)).toBe(true)
  })

  it('an entry whose html exceeds the budget is bypassed however small its source', () => {
    // 7,800 chars of source (15.6 KB at 2 bytes/char) that expands past the
    // budget: every line becomes a list item wrapped in tags, ~3x the source.
    const src = '- *i*\n'.repeat(1300)
    expect(2 * src.length).toBeLessThan(16 * KB)
    const html = renderNoteMarkdown(src)
    expect(noteMarkdownEntryBytes(noteMarkdownCacheKey(src), html)).toBeGreaterThan(16 * KB)
    expect(noteMarkdownCacheStats()).toMatchObject({ entries: 0, bytes: 0, misses: 0, oversizedParses: 1 })
  })
})

describe('ill-formed UTF-16', () => {
  beforeEach(() => clearNoteMarkdownCache(16 * KB))
  afterAll(() => clearNoteMarkdownCache())

  it('renders, is never hashed into the map, and is matched by exact source equality', () => {
    const high = renderNoteMarkdown('alpha \uD800 omega')
    expect(high).toContain('\uD800')
    expect(noteMarkdownCacheStats()).toMatchObject({ entries: 0, hits: 0, misses: 0, illFormedParses: 1 })
    // The same body again is a hit from the ill-formed cache, not a re-parse:
    // a body truncated at a byte limit must not re-parse on every React render.
    expect(renderNoteMarkdown('alpha \uD800 omega')).toBe(high)
    expect(noteMarkdownCacheStats()).toMatchObject({ hits: 1, illFormedParses: 1 })
    // A twin with a different lone surrogate is NOT the same body, whatever
    // encodeInto would say: exact equality, so it is its own parse.
    const low = renderNoteMarkdown('alpha \uDC00 omega')
    expect(low).not.toBe(high)
    expect(low).toContain('\uDC00')
    expect(noteMarkdownCacheStats()).toMatchObject({ hits: 1, illFormedParses: 2, entries: 0 })
  })

  it('two ill-formed notes on one canvas are both held — no single-slot thrash', () => {
    // ~4 KB accounted each: four fit under the 32 KB side cap, so the entry
    // count is what bounds them here.
    const a = `- *a*\n`.repeat(80) + '\uD800'
    const b = `- *b*\n`.repeat(80) + '\uDC00'
    renderNoteMarkdown(a)
    renderNoteMarkdown(b)
    expect(isCached(a)).toBe(true)
    expect(isCached(b)).toBe(true)
    expect(noteMarkdownCacheStats()).toMatchObject({ illFormedParses: 2, hits: 2 })
    // Up to four; the fifth evicts the oldest, in insertion order. (A miss
    // probe re-inserts, so the survivors are probed first.)
    const more = ['c', 'd', 'e'].map((t) => `- *${t}*\n`.repeat(80) + '\uD800')
    for (const src of more) renderNoteMarkdown(src)
    expect(noteMarkdownCacheStats().illFormedBytes).toBeLessThan(32 * KB)
    expect(isCached(more[2])).toBe(true)
    expect(isCached(b)).toBe(true)
    expect(isCached(a)).toBe(false)
  })

  it('accounts the retained source alongside the html, and drops a render above the side cap', () => {
    const src = `- *i*\n`.repeat(500) + '\uD800'
    const html = renderNoteMarkdown(src)
    const stats = noteMarkdownCacheStats()
    expect(stats.illFormedBytes).toBe(noteMarkdownEntryBytes(src, html))
    expect(stats.illFormedBytes).toBeLessThanOrEqual(stats.maxSideBytes)
    const giant = `# Giant\n\n${'- **row** with `code`\n'.repeat(6000)}\uDC00`
    renderNoteMarkdown(giant)
    // Not kept, and what was there before is undisturbed.
    expect(noteMarkdownCacheStats()).toMatchObject({ illFormedParses: 2, illFormedBytes: stats.illFormedBytes })
    renderNoteMarkdown(giant)
    expect(noteMarkdownCacheStats()).toMatchObject({ illFormedParses: 3, hits: 0 })
    expect(isCached(src)).toBe(true)
  })

  it('a properly paired surrogate is well-formed and caches as usual', () => {
    expect(isCached('alpha \u{1F600} omega')).toBe(false)
    expect(isCached('alpha \u{1F600} omega')).toBe(true)
    expect(noteMarkdownCacheStats()).toMatchObject({ entries: 1, illFormedParses: 0 })
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
    expect(noteMarkdownCacheStats()).toMatchObject({ entries: 1, hits: 2, misses: 1, oversizedParses: 0, illFormedParses: 0 })
  })
})

describe('SideCache', () => {
  it('overwriting a key replaces its bytes instead of adding to them', () => {
    const cache = new SideCache()
    cache.put('k', 'first', 1000, 4096)
    cache.put('k', 'second', 1500, 4096)
    expect(cache.get('k')).toBe('second')
    expect(cache.bytes).toBe(1500)
    // and the overwritten entry does not count against the entry limit either
    cache.put('a', 'a', 100, 4096)
    cache.put('b', 'b', 100, 4096)
    cache.put('c', 'c', 100, 4096)
    expect(cache.get('k')).toBe('second')
    expect(cache.bytes).toBe(1800)
  })

  it('evicts oldest first under the byte cap and the entry limit, and refuses a render above the cap alone', () => {
    const cache = new SideCache()
    cache.put('a', 'a', 1000, 2500)
    cache.put('b', 'b', 1000, 2500)
    cache.put('c', 'c', 1000, 2500) // a out: 3000 > 2500
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe('b')
    expect(cache.bytes).toBe(2000)
    cache.put('huge', 'h', 3000, 2500) // not kept, nothing disturbed
    expect(cache.get('huge')).toBeUndefined()
    expect(cache.bytes).toBe(2000)
    cache.clear()
    expect(cache.bytes).toBe(0)
    expect(cache.get('b')).toBeUndefined()
  })
})
