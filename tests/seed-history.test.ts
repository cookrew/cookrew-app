// THE PANE'S HISTORY, MADE FIT TO READ (main/seed-history.ts): a run that a
// resize reprinted is kept once (the later copy, whatever its width), and
// the history is cut where the screen begins, by the screen's own words.
import { describe, expect, it } from 'vitest'
import { clipToCells, cutAtScreen, dropReprints, stripAnsi, textKey } from '../src/main/seed-history'

/** An answer as Claude prints it, hard-wrapped at `width` columns. */
const answer = (width: number): string[] => {
  const words = Array.from({ length: 120 }, (_, i) => `word${i}`)
  const out: string[] = []
  let line = '⏺ '
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      out.push(line)
      line = '  '
    }
    line += `${w} `
  }
  out.push(line, '  ┌──────────┬──────┐'.slice(0, width), '  │ before   │ now  │', '')
  return out
}

describe('textKey', () => {
  it('is the words alone: no colour, spaces, box lines or variation selectors', () => {
    expect(stripAnsi('\x1b[38;2;1;2;3mhi\x1b[0m\x1b]777;x\x07')).toBe('hi')
    expect(textKey('  ⏺︎ a b │ ──── c')).toBe('⏺abc')
  })
})

describe('dropReprints', () => {
  it('keeps the later copy of a reprinted answer, though its width differs', () => {
    const lines = ['older output', ...answer(46), 'between', ...answer(44), 'newest']
    const kept = dropReprints(lines)
    expect(kept[0]).toBe('older output')
    expect(kept.filter((l) => l.startsWith('⏺ word0'))).toHaveLength(1)
    expect(kept.findIndex((l) => l.startsWith('⏺ word0'))).toBeGreaterThan(kept.indexOf('between'))
    expect(kept.at(-1)).toBe('newest')
  })

  it('three copies are one', () => {
    const lines = [...answer(50), ...answer(46), ...answer(44)]
    expect(dropReprints(lines).filter((l) => l.startsWith('⏺ word0'))).toHaveLength(1)
  })

  it('an earlier copy goes when the later one is on the screen; the screen is never touched', () => {
    const screen = answer(44)
    const kept = dropReprints(['top', ...answer(48)], screen)
    expect(kept).toEqual(['top'])
  })

  it('a short phrase said twice is not a reprint', () => {
    const lines = ['  ⎿ Shell cwd was reset to /Users/drej/workspace', 'x', '  ⎿ Shell cwd was reset to /Users/drej/workspace']
    expect(dropReprints(lines)).toEqual(lines)
  })
})

describe('cutAtScreen', () => {
  const history = ['a1', 'a2', 'the screen begins with these words here', 'and goes on', 'to the prompt']
  it('cuts where the screen begins, found by its words, though the history ran past it', () => {
    expect(cutAtScreen(history, ['the screen begins with these', 'words here', 'and goes on'], 10)).toEqual(['a1', 'a2'])
  })
  it('falls back to dropping one screenful when the screen is blank or not there yet', () => {
    expect(cutAtScreen(history, ['', ''], 2)).toEqual(['a1', 'a2', 'the screen begins with these words here'])
    expect(cutAtScreen(history, ['brand new output the history has not seen'], 2)).toEqual(['a1', 'a2', 'the screen begins with these words here'])
  })
})

describe('clipToCells', () => {
  it('cuts to the width in cells, keeps colour, leaves out a wide character that would straddle the edge', () => {
    expect(clipToCells('abcdefghijkl', 10)).toBe('abcdefghij')
    expect(clipToCells('\x1b[31mabcdefghijkl\x1b[0m', 10)).toBe('\x1b[31mabcdefghij\x1b[0m')
    expect(clipToCells('ab历史会在后台自动补新', 9)).toBe('ab历史会')
    expect(clipToCells('short', 10)).toBe('short')
  })
})
