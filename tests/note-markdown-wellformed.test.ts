import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearNoteMarkdownCache,
  isWellFormedString,
  noteMarkdownCacheStats,
  renderNoteMarkdown
} from '../src/renderer/src/note-markdown'

/**
 * The living-room TV box runs Chrome 108. String.prototype.isWellFormed is
 * ES2024 (Chrome 111+), so a bare call crashed every note render there and
 * took the canvas down. note-markdown.ts feature-detects and falls back to a
 * lone-surrogate regex. Node always has the native method, so this suite is
 * the only thing that runs the fallback: it removes the native for the
 * duration of each test and pins the fallback to the native's answers.
 */

type WithIsWellFormed = { isWellFormed?: (this: string) => boolean }
const proto = String.prototype as unknown as WithIsWellFormed
const native = proto.isWellFormed

/** The five shapes the review named, plus the two well-formed controls. */
const CASES: ReadonlyArray<[label: string, body: string, wellFormed: boolean]> = [
  ['H alone', 'a\uD800z', false],
  ['L alone', 'a\uDC00z', false],
  ['H H L', 'a\uD800𐐀z', false],
  ['L L', 'a\uDC00\uDC01z', false],
  ['H L L', 'a𐀀\uDC01z', false],
  ['H L (a pair)', 'a𐀀z', true],
  ['plain text', 'a plain note — with an em dash', true]
]

describe('the isWellFormed fallback', () => {
  beforeEach(() => {
    expect(typeof native).toBe('function')
    delete proto.isWellFormed
  })
  afterEach(() => {
    proto.isWellFormed = native
    clearNoteMarkdownCache()
  })

  it('is really the fallback that runs when the native is absent', () => {
    expect(typeof (('x' as unknown) as WithIsWellFormed).isWellFormed).toBe('undefined')
  })

  it.each(CASES)('classifies %s exactly like the native method', (_label, body, wellFormed) => {
    expect(isWellFormedString(body)).toBe(wellFormed)
    expect(native!.call(body)).toBe(wellFormed)
  })

  it('agrees with the native on a surrogate at either end and on pairs back to back', () => {
    for (const body of ['\uD800', '\uDC00', '𐀀𐐁', '𐀀\uD800', '\uDC00𐀀', '']) {
      expect(isWellFormedString(body)).toBe(native!.call(body))
    }
  })

  it('sends an ill-formed note down the side-slot path, and a well-formed one into the map', () => {
    clearNoteMarkdownCache()
    renderNoteMarkdown('a\uD800z')
    expect(noteMarkdownCacheStats()).toMatchObject({ entries: 0, misses: 0, illFormedParses: 1 })
    // A repeat is a hit from the ill-formed side cache, not another parse.
    renderNoteMarkdown('a\uD800z')
    expect(noteMarkdownCacheStats()).toMatchObject({ hits: 1, illFormedParses: 1 })
    renderNoteMarkdown('a𐀀z')
    expect(noteMarkdownCacheStats()).toMatchObject({ entries: 1, misses: 1, illFormedParses: 1 })
  })
})

describe('with the native present', () => {
  afterEach(() => clearNoteMarkdownCache())

  it('the wrapper defers to it and reaches the same classifications', () => {
    expect(typeof proto.isWellFormed).toBe('function')
    for (const [, body, wellFormed] of CASES) expect(isWellFormedString(body)).toBe(wellFormed)
  })
})
