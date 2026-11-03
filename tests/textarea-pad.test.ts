// On a phone the keyboard's field is the truth (textarea-pad.ts): what reaches
// the agent is what changed in it — a DEL per character taken back, then the
// new text — and xterm sends only its keys.
//
// The regression (phone report 2026-11-01, Samsung Keyboard, pinyin): the box
// read stray Latin letters and one hanzi four times — every composition update appended, pinyin
// letters through. Samsung finishes the composing word on every key and takes
// it back on the next as a composing region, without a compositionstart; xterm
// sent field.substring(stale start) per letter, and on fresh padding appended
// each longer word and turned the candidate into one DEL. Measured with a real
// xterm in headless Chromium (scratchpad/ime-samsung): dev sent
// "c ch chu chun ⌫ f fa fan ...", this sends "c h u n", four DELs and the hanzi — the agent's
// line equals the field in every scenario, Samsung's both ways.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PAD,
  attachPhoneField,
  editToSend,
  fieldEdit,
  muteXtermFieldSends,
  needsSeed,
  withoutEcho
} from '../src/renderer/src/textarea-pad'

const DEL = '\x7f'

class FakeArea extends EventTarget {
  value = ''
  cursor = -1
  setSelectionRange(start: number): void {
    this.cursor = start
  }
}

/** What the agent's line holds after these sends: DEL takes back one character. */
function line(sent: readonly string[]): string {
  const out: string[] = []
  for (const ch of Array.from(sent.join(''))) {
    if (ch === DEL) out.pop()
    else out.push(ch)
  }
  return out.join('')
}

function harness(start = '') {
  const area = new FakeArea()
  area.value = start
  const container = new EventTarget()
  const sent: string[] = []
  let queue: (() => void)[] = []
  let clock = 1000
  const later = (fn: () => void): (() => void) => {
    queue.push(fn)
    return () => {
      queue = queue.filter((f) => f !== fn)
    }
  }
  const field = attachPhoneField(area, container, { send: (d) => sent.push(d), later, now: () => clock })
  const fire = (type: string, init: Record<string, unknown> = {}): Event => {
    const ev = Object.assign(new Event(type, { bubbles: true, cancelable: true }), init)
    container.dispatchEvent(ev)
    return ev
  }
  const flush = (): void => {
    while (queue.length) queue.shift()!()
  }
  const tick = (ms: number): void => {
    clock += ms
  }
  /** The keyboard writes `text` over the `back` characters before the caret (the field's end). */
  const write = (text: string, back = 0): void => {
    area.value = area.value.slice(0, area.value.length - back) + text
  }
  return { area, container, field, sent, fire, flush, tick, write }
}

describe('fieldEdit', () => {
  it('a word typed at the end', () => {
    expect(fieldEdit(PAD, PAD + '修复')).toEqual({ deleted: 0, inserted: '修复' })
  })
  it('a longer word written over the composing one', () => {
    expect(fieldEdit(PAD + 'ch', PAD + 'chu')).toEqual({ deleted: 0, inserted: 'u' })
    expect(fieldEdit(PAD + 'chun', PAD + '纯')).toEqual({ deleted: 4, inserted: '纯' })
  })
  it('padding the keyboard wrote over: characters it took back', () => {
    expect(fieldEdit(PAD, PAD.slice(2) + 'age')).toEqual({ deleted: 2, inserted: 'age' })
  })
  it('a "," before the caret made "，": taken back and typed again', () => {
    expect(fieldEdit(PAD + '修复,', PAD + '修复，输入')).toEqual({ deleted: 1, inserted: '，输入' })
  })
  it('counts characters, not UTF-16 units: an emoji is one Backspace', () => {
    expect(fieldEdit(PAD + '😀', PAD)).toEqual({ deleted: 1, inserted: '' })
  })
})

describe('a key xterm sent itself is not sent again', () => {
  it('the same text landing in the field right after', () => {
    expect(withoutEcho('A', [{ at: 100, text: 'A' }], 101)).toBe('')
  })
  it("the phrase a dictation keyboard commits after the letter it sent as a key (\"VVery good\")", () => {
    expect(withoutEcho('Very good', [{ at: 100, text: 'V' }], 101)).toBe('ery good')
  })
  it('but a key long gone is a person typing it again', () => {
    expect(withoutEcho('A', [{ at: 100, text: 'A' }], 400)).toBe('A')
  })
  it('the line form: DELs first, then the text', () => {
    expect(editToSend({ deleted: 2, inserted: 'age' }, [], 0)).toBe(DEL + DEL + 'age')
  })
})

describe('Samsung: every key finishes the composition and takes the word back', () => {
  // One key: keydown(229), the word written over the region, an
  // insertCompositionText input, compositionend — no compositionstart after
  // the first.
  const key = (h: ReturnType<typeof harness>, word: string, back: number, start: boolean): void => {
    h.fire('keydown', { keyCode: 229 })
    if (start) h.fire('compositionstart')
    h.write(word, back)
    h.fire('input', { inputType: 'insertCompositionText', data: word })
    h.fire('compositionend', { data: word })
  }

  it('each update replaces the word; the candidate replaces the pinyin', () => {
    const h = harness()
    const py = 'chun'
    for (let i = 1; i <= py.length; i++) key(h, py.slice(0, i), i - 1, i === 1)
    key(h, '纯', py.length, false)
    h.flush()
    expect(h.sent).toEqual(['c', 'h', 'u', 'n', DEL.repeat(4) + '纯'])
    expect(line(h.sent)).toBe('纯')
  })

  it('a word taken back is composing until its compositionend, though no compositionstart said so', () => {
    const h = harness()
    key(h, 'c', 0, true)
    h.fire('keydown', { keyCode: 229 })
    h.write('ch', 1)
    h.fire('input', { inputType: 'insertCompositionText', data: 'ch' })
    // The tidy queued by the input runs before the keyboard finishes the word.
    h.flush()
    expect(h.sent).toEqual(['c'])
    h.fire('compositionend', { data: 'ch' })
    expect(h.sent).toEqual(['c', 'h'])
  })

  it('the same on fresh padding, where the keyboard writes over spaces it thinks are its word', () => {
    const h = harness()
    key(h, 'c', 0, true)
    h.flush()
    // The field went back to bare padding between keys (a blur, then focus):
    // the keyboard still believes "c" is before the caret.
    h.area.value = ''
    h.area.dispatchEvent(new Event('blur'))
    h.area.dispatchEvent(new Event('focus'))
    expect(h.area.value).toBe(PAD)
    key(h, 'ch', 1, false)
    key(h, '纯', 2, false)
    h.flush()
    expect(line(h.sent)).toBe('纯')
  })

  it('a whole sentence ends as the field reads, never longer', () => {
    const h = harness()
    for (const [py, out] of [
      ['chun', '纯'],
      ['codex', 'codex'],
      ['jiaogei', '交给']
    ]) {
      for (let i = 1; i <= py.length; i++) key(h, py.slice(0, i), i - 1, i === 1)
      if (out !== py) key(h, out, py.length, false)
      h.flush()
    }
    expect(line(h.sent)).toBe('纯codex交给')
    expect(h.area.value.trimStart()).toBe('纯codex交给')
  })
})

describe('a composition', () => {
  it('sends nothing while it is open: pinyin never reaches the agent', () => {
    const h = harness()
    h.fire('compositionstart')
    for (const w of ['x', 'xi', 'xiu']) {
      h.write(w, w.length - 1)
      h.fire('input', { inputType: 'insertCompositionText', data: w })
    }
    h.flush()
    expect(h.sent).toEqual([])
    h.write('修', 3)
    h.fire('compositionend')
    expect(h.sent).toEqual(['修'])
  })

  it('goes out before the key that ended it', () => {
    const h = harness()
    h.fire('compositionstart')
    h.write('xiao')
    h.fire('input', { inputType: 'insertCompositionText' })
    h.fire('keydown', { keyCode: 13 })
    expect(h.sent).toEqual(['xiao'])
  })

  it('is not ended by Shift or by the IME key', () => {
    const h = harness()
    h.fire('compositionstart')
    h.write('x')
    h.fire('keydown', { keyCode: 16 })
    h.fire('keydown', { keyCode: 229 })
    expect(h.sent).toEqual([])
  })
})

describe('xterm never sees the field change', () => {
  it('an input event stops at the container, before xterm on the textarea', () => {
    const h = harness()
    h.write('1')
    const ev = h.fire('input', { inputType: 'insertText', data: '1' })
    expect(ev.cancelBubble).toBe(true)
    expect(h.sent).toEqual(['1'])
  })
})

describe('when xterm writes the field itself, the agent line is unchanged', () => {
  it('Enter empties it: no DEL for the typed line, padding again after', () => {
    const h = harness()
    h.write('hi')
    h.fire('input', { inputType: 'insertText' })
    h.area.value = ''
    h.field.xtermSent('\r')
    h.flush()
    expect(h.area.value).toBe(PAD)
    h.write('ok')
    h.fire('input', { inputType: 'insertText' })
    expect(h.sent).toEqual(['hi', 'ok'])
  })

  it('a blur empties it', () => {
    const h = harness()
    h.write('hi')
    h.fire('input', { inputType: 'insertText' })
    h.area.value = ''
    h.area.dispatchEvent(new Event('blur'))
    h.area.dispatchEvent(new Event('focus'))
    expect(h.area.value).toBe(PAD)
    expect(h.sent).toEqual(['hi'])
  })

  it('a long press puts the selection in it', () => {
    const h = harness()
    h.area.value = 'selected text'
    h.fire('contextmenu')
    h.write('!')
    h.fire('input', { inputType: 'insertText' })
    expect(h.sent).toEqual(['!'])
  })
})

describe('a key xterm sent that lands in the field', () => {
  it('goes out once', () => {
    const h = harness()
    h.field.xtermSent('A')
    h.tick(1)
    h.write('A')
    h.fire('input', { inputType: 'insertText', data: 'A' })
    expect(h.sent).toEqual([])
  })
})

describe('the field never runs dry', () => {
  it('is padded the moment it is attached, cursor at the end', () => {
    const { area } = harness()
    expect(area.value).toBe(PAD)
    expect(area.cursor).toBe(PAD.length)
  })

  it('a Backspace eats a pad space and sends DEL', () => {
    const h = harness()
    h.write('修复')
    h.fire('input', { inputType: 'insertText' })
    h.area.value = h.area.value.slice(0, -1)
    h.fire('input', { inputType: 'deleteContentBackward' })
    h.area.value = h.area.value.slice(0, -2)
    h.fire('input', { inputType: 'deleteContentBackward' })
    expect(line(h.sent)).toBe('')
    expect(h.sent.slice(1)).toEqual([DEL, DEL + DEL])
  })

  it('tops up once Backspaces have eaten it low — after the input has been sent', () => {
    const h = harness()
    h.area.value = '  '
    h.fire('input', { inputType: 'deleteContentBackward' })
    expect(h.sent.join('')).toBe(DEL.repeat(PAD.length - 2))
    h.flush()
    expect(h.area.value).toBe(PAD)
  })

  it('keeps typed text, so the keyboard keeps its word', () => {
    const h = harness()
    h.write('修复')
    h.fire('input', { inputType: 'insertText' })
    h.flush()
    expect(h.area.value).toBe(PAD + '修复')
  })

  it('never mid-composition, even a dry field', () => {
    const h = harness()
    h.fire('compositionstart')
    h.area.value = 'a'
    h.fire('input', { inputType: 'insertCompositionText' })
    h.flush()
    h.area.dispatchEvent(new Event('focus'))
    expect(h.area.value).toBe('a')
  })

  it('nothing after detach', () => {
    const h = harness()
    h.area.value = ''
    h.fire('input', { inputType: 'insertText' })
    const before = h.sent.length
    h.field.detach()
    h.flush()
    h.area.dispatchEvent(new Event('focus'))
    h.write('x')
    h.fire('input', { inputType: 'insertText' })
    expect(h.area.value).toBe('x')
    expect(h.sent.length).toBe(before)
  })
})

describe('needsSeed', () => {
  it('too little before the caret for Backspace, or too much kept', () => {
    expect(needsSeed('')).toBe(true)
    expect(needsSeed('   ')).toBe(true)
    expect(needsSeed(PAD + 'x'.repeat(600))).toBe(true)
  })
  it('padding, with or without a word after it', () => {
    expect(needsSeed(PAD)).toBe(false)
    expect(needsSeed(PAD + '修复')).toBe(false)
  })
})

describe('muteXtermFieldSends', () => {
  it('swaps the composition helper core service for a sink', () => {
    const triggered: string[] = []
    const helper = { _coreService: { triggerDataEvent: (d: string) => triggered.push(d) } }
    expect(muteXtermFieldSends({ _core: { _compositionHelper: helper } })).toBe(true)
    ;(helper._coreService as { triggerDataEvent: (d: string) => void }).triggerDataEvent('x')
    expect(triggered).toEqual([])
  })
  it('refuses a shape it does not know, so the caller leaves the field to xterm', () => {
    expect(muteXtermFieldSends({})).toBe(false)
    expect(muteXtermFieldSends(null)).toBe(false)
    expect(muteXtermFieldSends({ _core: { _compositionHelper: {} } })).toBe(false)
  })

  // The mute leans on xterm 5.5.0's private shape. If an upgrade moves it,
  // this fails here rather than doubling every word on a phone.
  it('matches the xterm the app ships', () => {
    const root = path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm')
    const helper = readFileSync(path.join(root, 'src', 'browser', 'input', 'CompositionHelper.ts'), 'utf8')
    const sends = helper.match(/[\w.]*triggerDataEvent\(/g) ?? []
    expect(sends.length).toBeGreaterThan(0)
    expect(sends.every((s) => s === 'this._coreService.triggerDataEvent(')).toBe(true)
    const lib = readFileSync(path.join(root, 'lib', 'xterm.js'), 'utf8')
    expect(lib).toContain('_compositionHelper')
    expect(lib).toContain('this._coreService.triggerDataEvent')
  })
})
