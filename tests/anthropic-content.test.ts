import { describe, expect, it } from 'vitest'
import { textFromContent } from '../src/shared/anthropic-content'

describe('textFromContent', () => {
  it('returns the text block', () => {
    expect(textFromContent({ content: [{ type: 'text', text: 'こんにちは' }] })).toBe('こんにちは')
  })

  /**
   * The regression this exists for. The hosted qwen answers with a `thinking`
   * block FIRST and the translation after it, so joining the content array puts
   * the model's English deliberation at the top of a translated body — where a
   * reader has every reason to think it is part of the transcript.
   */
  it('drops a thinking block instead of pasting reasoning into the transcript', () => {
    const real = {
      content: [
        {
          type: 'thinking',
          thinking: 'We need to translate into Japanese. Keep the backticks unchanged.',
          signature: ''
        },
        { type: 'text', text: '`npm run build` を実行してください。' }
      ]
    }
    expect(textFromContent(real)).toBe('`npm run build` を実行してください。')
  })

  it('drops any non-text block, not just the first one', () => {
    expect(
      textFromContent({
        content: [
          { type: 'text', text: 'A' },
          { type: 'redacted_thinking' },
          { type: 'tool_use' },
          { type: 'text', text: 'B' }
        ]
      })
    ).toBe('AB')
  })

  it('is empty — not a crash — for a shape it does not recognise', () => {
    expect(textFromContent(null)).toBe('')
    expect(textFromContent(undefined)).toBe('')
    expect(textFromContent({})).toBe('')
    expect(textFromContent({ content: [] })).toBe('')
    expect(textFromContent({ content: [{ type: 'text' }] })).toBe('')
  })
})
