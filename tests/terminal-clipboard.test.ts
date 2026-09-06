import { describe, expect, it, vi } from 'vitest'
import { pasteFromClipboard, screenText, type ScreenBuffer } from '../src/renderer/src/terminal-clipboard'

const buffer = (rows: string[], viewportY = 0): ScreenBuffer => ({
  viewportY,
  length: rows.length,
  getLine: (i) => (i < rows.length ? { translateToString: (trim) => (trim ? rows[i].trimEnd() : rows[i]) } : undefined)
})

describe('screenText — what the eye sees is what gets copied', () => {
  it('joins the visible rows, trimmed on the right', () => {
    expect(screenText(buffer(['$ ls   ', 'a.txt  ', 'b.txt']), 3)).toBe('$ ls\na.txt\nb.txt')
  })

  it('takes only the viewport, not the scrollback above it', () => {
    const rows = ['old 1', 'old 2', 'now 1', 'now 2']
    expect(screenText(buffer(rows, 2), 2)).toBe('now 1\nnow 2')
  })

  it('drops trailing empty rows but keeps blank lines in the middle', () => {
    expect(screenText(buffer(['a', '', 'b', '', '', '']), 6)).toBe('a\n\nb')
  })

  it('is empty for an empty screen and never throws on a short buffer', () => {
    expect(screenText(buffer(['', '']), 24)).toBe('')
    expect(screenText(buffer([]), 24)).toBe('')
  })
})

describe('pasteFromClipboard — three answers, one PTY write at most', () => {
  it('pastes text exactly once', async () => {
    const paste = vi.fn()
    expect(await pasteFromClipboard(async () => 'hello', paste)).toBe('pasted')
    expect(paste).toHaveBeenCalledTimes(1)
    expect(paste).toHaveBeenCalledWith('hello')
  })

  it('reports an empty clipboard without writing', async () => {
    const paste = vi.fn()
    expect(await pasteFromClipboard(async () => '', paste)).toBe('empty')
    expect(paste).not.toHaveBeenCalled()
  })

  it('reports an unreadable clipboard (insecure context, declined prompt) without writing', async () => {
    const paste = vi.fn()
    expect(await pasteFromClipboard(async () => null, paste)).toBe('unavailable')
    expect(paste).not.toHaveBeenCalled()
  })
})
