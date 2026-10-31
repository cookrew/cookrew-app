import { describe, expect, it } from 'vitest'
import { paperCursor } from '../src/renderer/src/paper-cursor'

// Read off a live Claude Code pane, 2026-10-31.
const CURSOR = '\x1b[31;1H\x1b[0;38;2;153;153;153;49m❯\x1b[31;2H\xa0\x1b[31;3H\x1b[0;38;2;0;0;0;48;2;255;255;255m \x1b[0;39;49m   '

describe("Claude Code's cursor on paper", () => {
  it('turns the white cell into an ink block with paper text', () => {
    expect(paperCursor(CURSOR)).toBe(
      '\x1b[31;1H\x1b[0;38;2;153;153;153;49m❯\x1b[31;2H\xa0\x1b[31;3H\x1b[0;38;2;255;254;245;48;2;45;42;32m \x1b[0;39;49m   '
    )
  })
  it('keeps the background swap when the text colour comes in another sequence', () => {
    expect(paperCursor('\x1b[38;2;0;0;0m\x1b[48;2;255;255;255m x')).toBe('\x1b[38;2;0;0;0m\x1b[48;2;45;42;32m x')
  })
  it('passes everything else as sent', () => {
    const plain = '\x1b[38;2;215;119;87;49m✢ Beaming…\x1b[0m \x1b[48;2;40;80;40m+ added\x1b[0m'
    expect(paperCursor(plain)).toBe(plain)
    expect(paperCursor('255;255;255 is text, not a colour')).toBe('255;255;255 is text, not a colour')
  })
})
