import { describe, expect, it } from 'vitest'
import { terminalKeyIntent } from '../src/renderer/src/terminal-key-intent'

/**
 * The handler this covers runs INSIDE xterm's key dispatch, so anything it
 * throws takes the keystroke with it — the character is simply never
 * forwarded. That is not hypothetical on a phone: an IME can deliver key
 * events whose `key` is absent, and `key.toLowerCase()` on those threw.
 */
describe('terminalKeyIntent — never throws on a partial key event', () => {
  const base = { type: 'keydown' as const, shiftKey: false, ctrlKey: false, metaKey: false }

  it('passes a key event with NO key through instead of throwing', () => {
    expect(terminalKeyIntent({ ...base, key: undefined }, { agent: true, hasSelection: false })).toBe('pass')
  })
  it('passes an IME key event (WebKit reports "Unidentified")', () => {
    expect(terminalKeyIntent({ ...base, key: 'Unidentified' }, { agent: true, hasSelection: false })).toBe('pass')
  })
  it('passes the digits and punctuation a CJK keyboard layer emits', () => {
    for (const key of ['1', '9', '，', '。', '“', '、', '？']) {
      expect(terminalKeyIntent({ ...base, key }, { agent: true, hasSelection: false })).toBe('pass')
    }
  })
})

describe('terminalKeyIntent — the bindings it does own', () => {
  const base = { type: 'keydown' as const, shiftKey: false, ctrlKey: false, metaKey: false }

  it('turns Shift+Enter into an agent newline', () => {
    expect(terminalKeyIntent({ ...base, key: 'Enter', shiftKey: true }, { agent: true, hasSelection: false })).toBe(
      'agent-newline'
    )
  })
  it('leaves Shift+Enter alone in a plain shell', () => {
    expect(terminalKeyIntent({ ...base, key: 'Enter', shiftKey: true }, { agent: false, hasSelection: false })).toBe(
      'pass'
    )
  })
  it('copies on Cmd+C and Ctrl+Shift+C only when there is a selection', () => {
    expect(terminalKeyIntent({ ...base, key: 'c', metaKey: true }, { agent: true, hasSelection: true })).toBe('copy')
    expect(
      terminalKeyIntent({ ...base, key: 'C', ctrlKey: true, shiftKey: true }, { agent: true, hasSelection: true })
    ).toBe('copy')
    expect(terminalKeyIntent({ ...base, key: 'c', metaKey: true }, { agent: true, hasSelection: false })).toBe('pass')
  })
  it('keeps bare Ctrl+C as SIGINT, never a copy', () => {
    expect(terminalKeyIntent({ ...base, key: 'c', ctrlKey: true }, { agent: true, hasSelection: true })).toBe('pass')
  })
  it('swallows the paste accelerator so it is not sent as raw bytes', () => {
    expect(terminalKeyIntent({ ...base, key: 'v', metaKey: true }, { agent: true, hasSelection: false })).toBe(
      'swallow-paste'
    )
    expect(
      terminalKeyIntent({ ...base, key: 'V', ctrlKey: true, shiftKey: true }, { agent: true, hasSelection: false })
    ).toBe('swallow-paste')
  })
})
