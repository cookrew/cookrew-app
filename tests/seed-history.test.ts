// THE PANE'S HISTORY, MADE FIT TO READ (main/seed-history.ts): a run that a
// resize reprinted is kept once (the later copy, whatever its width), and
// the history is cut where the screen begins, by the screen's own words.
import { describe, expect, it } from 'vitest'
import { clipToCells, cutAtScreen, dropReprintedMessages, dropReprints, stripAnsi, textKey } from '../src/main/seed-history'

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

describe('dropReprints · a short reprinted paragraph', () => {
  it('a paragraph printed once at 198 columns and again wrapped at 49 is kept once, the later copy', () => {
    const wide = "⏺ Still no reseed. I'll check the page's state: which view it is in, whether it counts as visible, and whether a seed is stuck in flight."
    const narrow = ["⏺ Still no reseed. I'll check the page's state:", '  which view it is in, whether it counts as', '  visible, and whether a seed is stuck in flight.']
    expect(dropReprints(['before', wide, '', 'between', ...narrow])).toEqual(['before', 'between', ...narrow])
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
  it('cuts a border or padding that hangs past the edge, keeping colour', () => {
    expect(clipToCells('abcdefgh    ', 10)).toBe('abcdefgh  ')
    expect(clipToCells('\x1b[31m  ┌────────────┐\x1b[0m', 10)).toBe('\x1b[31m  ┌───────\x1b[0m')
    expect(clipToCells('short', 10)).toBe('short')
  })
  it('leaves a line whose real text hangs past the edge whole, to wrap — words are never cut', () => {
    expect(clipToCells('abcdefghijkl', 10)).toBe('abcdefghijkl')
    expect(clipToCells('ab历史会在后台自动补新', 9)).toBe('ab历史会在后台自动补新')
  })
})

describe('whole messages, kept once (dropReprintedMessages)', () => {
  // The shape read off a live pane, 2026-10-31: the same exchange printed
  // three times, the middle copy narrow-wrapped, the first with a row of an
  // old diff left in it — which is what broke dropReprints' run.
  const exchange = (garbage: string, wrap = false): string[] => [
    '✻ Crunched for 12s · done 2:03 PM',
    '',
    '❯ 怎么给你这个目录的权限呢 ？',
    '',
    wrap ? '⏺ 不建议去开这个目录的权限，换个' : '⏺ 不建议去开这个目录的权限，换个保存位置更简单。',
    garbage,
    '  原因：这是 macOS 截屏工具的临时文件夹。',
    '⏺ Bash(ls ~/Desktop)',
    '  ⎿ Screen Recording.mov'
  ]
  const later = ['✻ Cooked for 15s · done 2:05 PM', '❯ /Users/drej/Desktop/Screen Recording.mov 往回翻', '⏺ Pulling frames out of it.']

  it('keeps the newest copy of a reprinted exchange, garbage rows and narrow copies included', () => {
    const lines = [...exchange('          + size, the        710 +      // others adopt'), ...exchange('', true), ...exchange(''), ...later]
    const kept = dropReprintedMessages(lines)
    expect(kept).toEqual([...exchange(''), ...later])
  })

  it('a head with old cells past its end is still the same message', () => {
    const lines = ['⏺ 不建议去开这个目录的权限，换个保存位置更简单。      x7 ', 'old body', '⏺ 不建议去开这个目录的权限，换个保存位置更简单。', 'new body']
    expect(dropReprintedMessages(lines)).toEqual(['⏺ 不建议去开这个目录的权限，换个保存位置更简单。', 'new body'])
  })

  it('never drops a tool call or a short prompt that really ran twice', () => {
    const lines = [
      '❯ merge',
      '⏺ Merged into dev as 6d8a72c, checked in the real app.',
      '⏺ Bash(npx tsc --noEmit -p tsconfig.web.json)',
      '  ⎿ (No output)',
      '❯ merge',
      '⏺ Merged into dev as 0d90fce; the phone strip is gone too.',
      '⏺ Bash(npx tsc --noEmit -p tsconfig.web.json)',
      '  ⎿ (No output)'
    ]
    expect(dropReprintedMessages(lines)).toEqual(lines)
  })

  it('a message the screen already shows goes from the history', () => {
    const lines = ['❯ older question here please', '⏺ An older answer that the screen shows again.', 'body']
    expect(dropReprintedMessages(lines, ['⏺ An older answer that the screen shows again.'])).toEqual(['❯ older question here please'])
  })

  it('history with no message heads passes as it is', () => {
    expect(dropReprintedMessages(['$ ls', 'a  b  c', '$ ls', 'a  b  c'])).toEqual(['$ ls', 'a  b  c', '$ ls', 'a  b  c'])
  })
})
