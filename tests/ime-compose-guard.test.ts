// The regression that got b08fbb6 reverted, pinned as a sequence.
//
// Phone report (IMG_3217, 2026-08-30 14:58): "有有 bug，首首字字会多打一遍" —
// every composition-committed first character arrived twice. The message text
// itself exhibits the bug.
//
// Mechanism: on compositionend, xterm's CompositionHelper calls
// _finalizeComposition(true), which sends the committed text on a
// setTimeout(…, 0). iOS then fires an `input` event (insertText) in the SAME
// tick. A synchronous emit-count snapshot sees nothing sent yet — the send is
// merely scheduled — so a bridge that only compares counts forwards the char
// itself, and xterm's timer forwards it again.
//
// The b08fbb6 unit tests passed while the phone bug was real because they only
// ever exercised the synchronous case. These tests replay the event SEQUENCE,
// timers included, against the real wiring in attachImeBridge. The guard under
// test: an insertText that follows a compositionend is xterm's to deliver; an
// insertText with no composition in flight is ours to rescue — that second half
// is the original dropped-punctuation bug and must keep working.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachImeBridge } from '../src/renderer/src/ime-input-bridge'

interface Listener {
  fn: (ev: Event) => void
  capture: boolean
}

/**
 * A container-shaped event target with real capture/bubble ordering.
 *
 * dispatch() runs capture listeners, then bubble listeners — the order the DOM
 * gives container-level listeners for an event targeting xterm's textarea
 * inside it. xterm's own textarea handlers run between the two phases, which a
 * test models by registering them as capture listeners here.
 */
function fakeContainer(): {
  target: {
    addEventListener: (type: string, fn: (ev: Event) => void, capture?: boolean) => void
    removeEventListener: (type: string, fn: (ev: Event) => void, capture?: boolean) => void
  }
  dispatch: (type: string, props?: Partial<InputEvent>) => void
  listenerCount: () => number
} {
  const listeners = new Map<string, Listener[]>()
  const list = (type: string): Listener[] => {
    const existing = listeners.get(type)
    if (existing) return existing
    const created: Listener[] = []
    listeners.set(type, created)
    return created
  }
  return {
    target: {
      addEventListener: (type, fn, capture = false) => {
        listeners.set(type, [...list(type), { fn, capture }])
      },
      removeEventListener: (type, fn, capture = false) => {
        listeners.set(
          type,
          list(type).filter((l) => l.fn !== fn || l.capture !== capture)
        )
      }
    },
    dispatch: (type, props = {}) => {
      const ev = { type, ...props } as unknown as Event
      for (const l of list(type).filter((l) => l.capture)) l.fn(ev)
      for (const l of list(type).filter((l) => !l.capture)) l.fn(ev)
    },
    listenerCount: () =>
      [...listeners.values()].reduce((sum, byType) => sum + byType.length, 0)
  }
}

/**
 * The xterm behaviors that matter here, nothing else.
 *
 * - emit(): the synchronous onData path (desktop echo) — count moves during
 *   the input event's dispatch, between our capture snapshot and our bubble.
 * - scheduleCommitSend(): what _finalizeComposition(true) really does — the
 *   committed text goes out on a setTimeout(0), NOT synchronously.
 */
function fakeXterm(pty: string[]): {
  emitCount: () => number
  emit: (text: string) => void
  scheduleCommitSend: (text: string) => void
} {
  let count = 0
  const emit = (text: string): void => {
    count += 1
    pty.push(text)
  }
  return {
    emitCount: () => count,
    emit,
    scheduleCommitSend: (text: string) => {
      setTimeout(() => emit(text), 0)
    }
  }
}

describe('composition commit — the doubling that got b08fbb6 reverted', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function rig(): {
    pty: string[]
    dispatch: (type: string, props?: Partial<InputEvent>) => void
    xterm: ReturnType<typeof fakeXterm>
    detach: () => void
    listenerCount: () => number
  } {
    const pty: string[] = []
    const { target, dispatch, listenerCount } = fakeContainer()
    const xterm = fakeXterm(pty)
    const detach = attachImeBridge(target, xterm.emitCount, (text) => pty.push(text))
    return { pty, dispatch, xterm, detach, listenerCount }
  }

  /** One committed composition, in the order iOS + xterm produce the events. */
  function commitViaComposition(
    r: ReturnType<typeof rig>,
    text: string
  ): void {
    r.dispatch('compositionstart')
    // xterm's compositionend handler lives on the textarea — target phase,
    // between container-capture and container-bubble — and only SCHEDULES the
    // send. Registering nothing for it here and calling it capture-side keeps
    // the real ordering: xterm's timer is queued before any the bridge queues.
    r.xterm.scheduleCommitSend(text)
    r.dispatch('compositionend')
    // Same tick: iOS follows the commit with an insertText input event.
    r.dispatch('input', { inputType: 'insertText', data: text })
    vi.runAllTimers()
  }

  it('a committed hanzi reaches the PTY exactly once', () => {
    const r = rig()
    commitViaComposition(r, '端')
    expect(r.pty).toEqual(['端'])
  })

  it('a dictated phrase reaches the PTY exactly once', () => {
    const r = rig()
    commitViaComposition(r, '端到端进行 P0 到 P4 的修复之后')
    expect(r.pty).toEqual(['端到端进行 P0 到 P4 的修复之后'])
  })

  it('punctuation typed after a commit settles still gets rescued', () => {
    // The original bug: xterm drops a bare insertText (keydown was seen, keyup
    // never came), so nothing is scheduled and the bridge must claim it.
    const r = rig()
    commitViaComposition(r, '端')
    r.dispatch('input', { inputType: 'insertText', data: '。' })
    vi.runAllTimers()
    expect(r.pty).toEqual(['端', '。'])
  })

  it('bare punctuation with no composition in flight is rescued', () => {
    const r = rig()
    r.dispatch('input', { inputType: 'insertText', data: '，' })
    vi.runAllTimers()
    expect(r.pty).toEqual(['，'])
  })

  it('the desktop synchronous path never doubles', () => {
    // xterm handles the event during dispatch: its textarea handler (modeled
    // capture-side, i.e. after the bridge's snapshot, before its bubble) emits
    // synchronously, so the count comparison alone must decline the event.
    const pty: string[] = []
    const c = fakeContainer()
    const x = fakeXterm(pty)
    attachImeBridge(c.target, x.emitCount, (text) => pty.push(text))
    c.target.addEventListener('input', () => x.emit('a'), true)
    c.dispatch('input', { inputType: 'insertText', data: 'a' })
    expect(pty).toEqual(['a'])
  })

  it('insertText DURING an open composition is left to xterm', () => {
    const r = rig()
    r.dispatch('compositionstart')
    r.dispatch('input', { inputType: 'insertText', data: '端' })
    // composition later commits through xterm's own path
    r.xterm.scheduleCommitSend('端')
    r.dispatch('compositionend')
    vi.runAllTimers()
    expect(r.pty).toEqual(['端'])
  })

  it('detach removes every listener it added', () => {
    const r = rig()
    r.detach()
    expect(r.listenerCount()).toBe(0)
  })
})
