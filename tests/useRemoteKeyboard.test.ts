import { describe, expect, it } from 'vitest'
import { desktopKeyAction, keyMsgsForInput, type DesktopKeyEvent } from '../src/renderer/src/useRemoteKeyboard'

// The mobile keyboard bridge forwards typing to the remote field via the SAME
// whitelisted key vocabulary as hardware keys (keyMsg → Input.dispatchKeyEvent).
// beforeinput is the reliable mobile signal (soft keyboards skip per-key keydown).
describe('keyMsgsForInput — mobile beforeinput → whitelisted key vocab', () => {
  it('one typed character is a key (the page sees keydown, text carried)', () => {
    expect(keyMsgsForInput('insertText', 'a')).toEqual([{ t: 'key', key: 'a', code: '', text: 'a' }])
  })
  it('a suggestion, an autocorrect or an emoji goes in whole as text, never split into keys', () => {
    expect(keyMsgsForInput('insertText', 'hello')).toEqual([{ t: 'text', text: 'hello' }])
    expect(keyMsgsForInput('insertText', '😀')).toEqual([{ t: 'text', text: '😀' }])
    expect(keyMsgsForInput('insertFromPaste', '你好世界')).toEqual([{ t: 'text', text: '你好世界' }])
  })
  it('composition is NOT forwarded from beforeinput — each update sent per character typed garbage (n, ni, then the word)', () => {
    expect(keyMsgsForInput('insertCompositionText', '你好')).toEqual([])
    expect(keyMsgsForInput('insertFromComposition', '你好')).toEqual([])
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

const key = (over: Partial<DesktopKeyEvent>): DesktopKeyEvent => ({
  key: 'a',
  code: 'KeyA',
  keyCode: 65,
  isComposing: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...over
})

describe('desktopKeyAction — a desktop keydown in the hidden field', () => {
  it('a plain letter is one key with its text', () => {
    expect(desktopKeyAction(key({}))).toEqual({ kind: 'send', msg: { t: 'key', key: 'a', code: 'KeyA', text: 'a' } })
  })
  it('⌘A goes as a key with the Meta bit and no text (the server adds selectAll)', () => {
    expect(desktopKeyAction(key({ metaKey: true }))).toEqual({
      kind: 'send',
      msg: { t: 'key', key: 'a', code: 'KeyA', mods: 4 }
    })
  })
  it('⇧ + arrow keeps the Shift bit so the selection extends', () => {
    expect(desktopKeyAction(key({ key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, shiftKey: true }))).toEqual({
      kind: 'send',
      msg: { t: 'key', key: 'ArrowLeft', code: 'ArrowLeft', mods: 8 }
    })
  })
  it('an IME composing (229, Process, isComposing) or a dead key is left to the field', () => {
    expect(desktopKeyAction(key({ keyCode: 229 })).kind).toBe('ime')
    expect(desktopKeyAction(key({ key: 'Process' })).kind).toBe('ime')
    expect(desktopKeyAction(key({ isComposing: true })).kind).toBe('ime')
    expect(desktopKeyAction(key({ key: 'Dead', code: 'KeyE', altKey: true })).kind).toBe('ime')
  })
  it('⌘V and Ctrl+V let the native paste happen (it carries this Mac’s clipboard)', () => {
    expect(desktopKeyAction(key({ key: 'v', code: 'KeyV', metaKey: true })).kind).toBe('paste')
    expect(desktopKeyAction(key({ key: 'v', code: 'KeyV', ctrlKey: true })).kind).toBe('paste')
  })
  it('Escape stays the app’s; a modifier alone rides on the next key', () => {
    expect(desktopKeyAction(key({ key: 'Escape', code: 'Escape', keyCode: 27 })).kind).toBe('bubble')
    expect(desktopKeyAction(key({ key: 'Shift', code: 'ShiftLeft', keyCode: 16, shiftKey: true })).kind).toBe('ignore')
    expect(desktopKeyAction(key({ key: 'Meta', code: 'MetaLeft', keyCode: 91, metaKey: true })).kind).toBe('ignore')
  })
})
