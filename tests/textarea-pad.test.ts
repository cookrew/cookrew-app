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
import { PAD, attachTextareaPad, needsSeed } from '../src/renderer/src/textarea-pad'

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
  it('a field with room to delete', () => {
    expect(needsSeed(PAD)).toBe(false)
    expect(needsSeed(PAD + 'hello')).toBe(false)
  })
  it('a field typed long', () => {
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

  it('leaves typed text alone while there is room', () => {
    const { area, flush } = harness()
    area.value = PAD + 'hey'
    area.fire('input')
    flush()
    expect(area.value).toBe(PAD + 'hey')
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
