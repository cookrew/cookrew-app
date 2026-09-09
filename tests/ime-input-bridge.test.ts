// Two phone reports, one cause.
//
//   1. Typeless (dictation) — a whole dictated phrase is committed and only a
//      single leading character reaches the prompt.
//   2. The iOS native Chinese keyboard's number/punctuation layer types
//      nothing at all, while hanzi from the same keyboard work fine.
//
// xterm 5.5.0 forwards a committed insertText only when
//
//     ev.data && ev.inputType === 'insertText' && (!ev.composed || !_keyDownSeen)
//
// Real user events always have composed === true, so it needs "no keydown
// first" — and an iOS soft keyboard always fires one, with its keyup arriving
// late or never. The text is dropped. Hanzi survive only because composition
// events take a different path.
//
// These pin the bridge that recovers it, and they lean hardest on what it must
// NOT claim: every other inputType already has an owner, and claiming one twice
// doubles characters — which would break the input that currently works.

import { describe, expect, it } from 'vitest'
import { imeTextToForward, withoutWhatXtermJustSent } from '../src/renderer/src/ime-input-bridge'

const NOT_SENT = false
const XTERM_SENT = true

describe('what the bridge recovers', () => {
  it('the CJK keyboard punctuation that typed nothing', () => {
    // Verbatim from the reported layer: full-width comma, period, the enclosing
    // brackets, and the digits along the top row.
    for (const ch of ['，', '。', '、', '？', '！', '（', '）', '￥', '@', '“', '”']) {
      expect(imeTextToForward('insertText', ch, NOT_SENT)).toBe(ch)
    }
    for (const digit of [...'0123456789']) {
      expect(imeTextToForward('insertText', digit, NOT_SENT)).toBe(digit)
    }
  })

  it("Typeless's whole dictated phrase, not just its first character", () => {
    // The screenshot showed one hanzi at the prompt and the rest of the
    // sentence stranded in the keyboard's own panel.
    const dictated = '端到端进行 P0 到 P4 的修复之后，派 QA 进行 evaluate'
    expect(imeTextToForward('insertText', dictated, NOT_SENT)).toBe(dictated)
    expect(imeTextToForward('insertText', dictated, NOT_SENT)).toHaveLength(dictated.length)
  })

  it('ordinary latin text an IME commits the same way', () => {
    expect(imeTextToForward('insertText', 'evaluate', NOT_SENT)).toBe('evaluate')
  })
})

describe('what it must not claim — doubling is worse than dropping', () => {
  it('anything xterm already sent', () => {
    // Desktop typing, and any phone event where xterm's own _inputEvent won.
    expect(imeTextToForward('insertText', 'a', XTERM_SENT)).toBeNull()
    expect(imeTextToForward('insertText', '，', XTERM_SENT)).toBeNull()
  })

  it('composition text — that is the path hanzi already work by', () => {
    // Claiming this would double every Chinese character, breaking the one
    // thing that was NOT reported as broken.
    expect(imeTextToForward('insertCompositionText', '端', NOT_SENT)).toBeNull()
  })

  it('paste — the overlay has a single paste listener already', () => {
    expect(imeTextToForward('insertFromPaste', 'hello', NOT_SENT)).toBeNull()
    expect(imeTextToForward('insertFromDrop', 'hello', NOT_SENT)).toBeNull()
  })

  it('newlines and deletes — keydown owns those', () => {
    for (const type of [
      'insertLineBreak',
      'insertParagraph',
      'deleteContentBackward',
      'deleteContentForward',
      'deleteWordBackward'
    ]) {
      expect(imeTextToForward(type, null, NOT_SENT)).toBeNull()
    }
  })

  it('an unknown inputType, whatever it turns out to be', () => {
    expect(imeTextToForward('insertTranspose', 'x', NOT_SENT)).toBeNull()
    expect(imeTextToForward('', 'x', NOT_SENT)).toBeNull()
  })

  it('an insertText carrying nothing', () => {
    expect(imeTextToForward('insertText', null, NOT_SENT)).toBeNull()
    expect(imeTextToForward('insertText', '', NOT_SENT)).toBeNull()
  })
})

describe('withoutWhatXtermJustSent — content, not count', () => {
  const T = 1000
  it('a pure duplicate of what xterm just sent forwards nothing', () => {
    expect(withoutWhatXtermJustSent('V', [{ at: T - 1, text: 'V' }], T)).toBe('')
  })
  it('strips the head xterm just sent, keeps the rest', () => {
    expect(withoutWhatXtermJustSent('Very good', [{ at: T - 1, text: 'V' }], T)).toBe('ery good')
  })
  it('ignores an emit outside the window', () => {
    expect(withoutWhatXtermJustSent('Very good', [{ at: T - 5000, text: 'V' }], T)).toBe('Very good')
  })
  it('ignores an emit AFTER the input event', () => {
    // Only what came before this input can be its duplicate.
    expect(withoutWhatXtermJustSent('Very good', [{ at: T + 1, text: 'V' }], T)).toBe('Very good')
  })
  it('strips only a head, never an interior match', () => {
    expect(withoutWhatXtermJustSent('Very good', [{ at: T - 1, text: 'good' }], T)).toBe('Very good')
  })
  it('with nothing recent, forwards untouched', () => {
    expect(withoutWhatXtermJustSent('Very good', [], T)).toBe('Very good')
  })
})
