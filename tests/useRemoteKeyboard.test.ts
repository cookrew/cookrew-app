import { describe, expect, it } from 'vitest'
import { keyMsgsForInput } from '../src/renderer/src/useRemoteKeyboard'

// The mobile keyboard bridge forwards typing to the remote field via the SAME
// whitelisted key vocabulary as hardware keys (keyMsg → Input.dispatchKeyEvent).
// beforeinput is the reliable mobile signal (soft keyboards skip per-key keydown).
describe('keyMsgsForInput — mobile beforeinput → whitelisted key vocab', () => {
  it('insertText forwards one key message per character (text carried)', () => {
    expect(keyMsgsForInput('insertText', 'ab')).toEqual([
      { t: 'key', key: 'a', code: '', text: 'a' },
      { t: 'key', key: 'b', code: '', text: 'b' }
    ])
  })
  it('composition text is forwarded per character too', () => {
    expect(keyMsgsForInput('insertCompositionText', '你好').map((m) => m.t)).toEqual(['key', 'key'])
  })
  it('line break / paragraph → Enter', () => {
    expect(keyMsgsForInput('insertLineBreak', null)).toEqual([{ t: 'key', key: 'Enter', code: 'Enter' }])
    expect(keyMsgsForInput('insertParagraph', null)).toEqual([{ t: 'key', key: 'Enter', code: 'Enter' }])
  })
  it('backspace / forward-delete → Backspace / Delete', () => {
    expect(keyMsgsForInput('deleteContentBackward', null)).toEqual([
      { t: 'key', key: 'Backspace', code: 'Backspace' }
    ])
    expect(keyMsgsForInput('deleteContentForward', null)).toEqual([
      { t: 'key', key: 'Delete', code: 'Delete' }
    ])
  })
  it('unknown inputType or empty data forwards nothing (fail closed)', () => {
    expect(keyMsgsForInput('formatBold', 'x')).toEqual([])
    expect(keyMsgsForInput('insertText', null)).toEqual([])
    expect(keyMsgsForInput('insertText', '')).toEqual([])
  })
})
