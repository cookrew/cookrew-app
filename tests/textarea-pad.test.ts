// Phone report (2026-11-01): typing into LIVE works, Backspace does not.
//
// A soft keyboard deletes inside xterm's hidden textarea and xterm turns the
// shorter field into DEL. An empty field has nothing to delete, so nothing is
// sent — and the field is empty whenever a terminal opens. Measured over CDP
// with Android-style keyCode-229 events: letters, digits, hanzi and Enter
// arrive, Backspace on an empty field sends nothing.
//
// These pin the padding that keeps the field from running dry, and what it must
// NOT do: touch the field mid-composition (xterm reads the committed text out of
// it) or before xterm's own timers have read it.

import { describe, expect, it } from 'vitest'
import { PAD, attachTextareaPad, needsSeed, withoutPad } from '../src/renderer/src/textarea-pad'

class FakeArea extends EventTarget {
  value = ''
  cursor = -1
  setSelectionRange(start: number): void {
    this.cursor = start
  }
  fire(type: string): void {
    this.dispatchEvent(new Event(type))
  }
}

function harness(): { area: FakeArea; flush: () => void; detach: () => void } {
  const area = new FakeArea()
  let queue: (() => void)[] = []
  const later = (fn: () => void): (() => void) => {
    queue.push(fn)
    return () => {
      queue = queue.filter((f) => f !== fn)
    }
  }
  const detach = attachTextareaPad(area, later)
  const flush = (): void => {
    const run = queue
    queue = []
    for (const fn of run) fn()
  }
  return { area, flush, detach }
}

describe('needsSeed', () => {
  it('an empty or nearly empty field', () => {
    expect(needsSeed('')).toBe(true)
    expect(needsSeed('   ')).toBe(true)
  })
  it('bare padding', () => {
    expect(needsSeed(PAD)).toBe(false)
  })
  // Phone report (2026-11-01, Samsung keyboard, pinyin): every word went out
  // again with all the words before it and the padding — the sentence so far,
  // 32 spaces, the sentence one word longer, ... The field kept every word typed since the last
  // Enter; when the keyboard touched anything before the caret, xterm's
  // "what changed" (new.replace(old, '')) found nothing and sent the whole
  // field. Typed text never stays in the field now, as the streamed browser's
  // keyboard does it (useRemoteKeyboard.ts: re-seed after every edit).
  it('any typed text, a word or a page', () => {
    expect(needsSeed(PAD + 'hello')).toBe(true)
    expect(needsSeed(PAD + '修复')).toBe(true)
    expect(needsSeed(PAD + 'x'.repeat(600))).toBe(true)
  })
})

describe('the field never runs dry', () => {
  it('is padded the moment it is attached, cursor at the end', () => {
    const { area } = harness()
    expect(area.value).toBe(PAD)
    expect(area.cursor).toBe(PAD.length)
  })

  it('is padded again when focused empty', () => {
    const { area } = harness()
    area.value = ''
    area.fire('focus')
    expect(area.value).toBe(PAD)
  })

  it('tops up after Backspaces eat into it — but only after the input has settled', () => {
    const { area, flush } = harness()
    area.value = '  '
    area.fire('input')
    // xterm reads the field on a timer queued before ours; it must see '  '.
    expect(area.value).toBe('  ')
    flush()
    expect(area.value).toBe(PAD)
  })

  it('takes typed text back out once xterm has read it, so no later edit can send it again', () => {
    const { area, flush } = harness()
    area.value = PAD + '修复'
    area.fire('input')
    // xterm's timer, queued at keydown, reads the field first.
    expect(area.value).toBe(PAD + '修复')
    flush()
    expect(area.value).toBe(PAD)
    expect(area.cursor).toBe(PAD.length)
  })
})

describe('what it must not touch', () => {
  it('a field mid-composition, even a dry one', () => {
    const { area, flush } = harness()
    area.fire('compositionstart')
    area.value = 'a'
    area.fire('input')
    flush()
    area.fire('focus')
    expect(area.value).toBe('a')
  })

  // Measured (headless xterm, CDP compositions, 2026-11-01): every input of a
  // composition queued a re-seed BEFORE compositionend, so they ran before
  // xterm's own commit timer (queued AT compositionend) and the committed word
  // was gone when xterm read the field: nothing sent at all.
  it('the committed word until xterm has read it, though the composition typed into it', () => {
    const area = new FakeArea()
    const queue: (() => void)[] = []
    const later = (fn: () => void): (() => void) => {
      queue.push(fn)
      return () => undefined
    }
    // xterm's CompositionHelper: on compositionend it reads the field on its own timer.
    let xtermRead: string | null = null
    area.addEventListener('compositionend', () => void later(() => (xtermRead = area.value)))
    attachTextareaPad(area, later)
    area.fire('compositionstart')
    area.value = PAD + 'x'
    area.fire('input')
    area.value = PAD + '修复'
    area.fire('input')
    area.fire('compositionend')
    while (queue.length) queue.shift()!()
    expect(xtermRead).toBe(PAD + '修复')
    expect(area.value).toBe(PAD)
  })

  it('a re-seed queued before a composition began, once it has', () => {
    const { area, flush } = harness()
    area.value = PAD + 'a'
    area.fire('input')
    area.fire('compositionstart')
    area.value = PAD + 'a' + 'x'
    area.fire('compositionend')
    // The input's timer runs first; the composition overtook it, so it stands down.
    flush()
    expect(area.value).toBe(PAD)
  })

  it('tops up once the composition has been committed', () => {
    const { area, flush } = harness()
    area.fire('compositionstart')
    area.value = 'a'
    area.fire('compositionend')
    expect(area.value).toBe('a')
    flush()
    expect(area.value).toBe(PAD)
  })

  it('anything after detach', () => {
    const { area, flush, detach } = harness()
    area.value = ''
    area.fire('input')
    detach()
    flush()
    area.fire('focus')
    expect(area.value).toBe('')
  })
})

describe('the padding is never sent', () => {
  it('a send of the whole field loses the padding and keeps what was typed', () => {
    expect(withoutPad(PAD + '输入')).toBe('输入')
    // A Backspace or two may have eaten into it first.
    expect(withoutPad(PAD.slice(3) + '输入')).toBe('输入')
  })
  it('a send of nothing but padding is nothing', () => {
    expect(withoutPad(PAD)).toBe('')
    expect(withoutPad(PAD.slice(5))).toBe('')
  })
  it('leaves what a person types alone: a space, a few, an indented line, a paste', () => {
    expect(withoutPad(' ')).toBe(' ')
    expect(withoutPad('    if (x) {')).toBe('    if (x) {')
    expect(withoutPad('\x1b[200~' + PAD + 'x\x1b[201~')).toBe('\x1b[200~' + PAD + 'x\x1b[201~')
    expect(withoutPad('\x7f')).toBe('\x7f')
  })
})
