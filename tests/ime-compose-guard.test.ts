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

// The empty-commit case USED to be explained here as "safe because
// _finalizeComposition(true) re-reads textarea.value at timer time". That
// explanation is wrong and would have become load-bearing. Terminal.ts:1067
// clears the textarea on Enter, so the deferred read returns '' and would send
// NOTHING. What actually saves it is CompositionHelper.keydown: a non-229 key
// arriving while _isComposing || _isSendingComposition calls
// _finalizeComposition(FALSE), which sends synchronously and clears
// _isSendingComposition, so the queued timer finds nothing left to do. That
// mechanism is now pinned by a test below rather than by a paragraph.
//
// The keydown-229-without-composition path IS modeled now (it was the CRITICAL
// this branch was blocked on): _handleAnyTextareaChanges() schedules its send on
// a setTimeout(0) with no composition anywhere, so no window covers it and only
// the deferred re-check does.

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
  scheduleTextareaDiffSend: (text: string) => void
  finalizeNow: (text: string) => void
} {
  let count = 0
  let pendingCommit: string | null = null
  const emit = (text: string): void => {
    count += 1
    pty.push(text)
  }
  return {
    emitCount: () => count,
    emit,
    // _finalizeComposition(true): the commit goes out on a timer, NOT now.
    scheduleCommitSend: (text: string) => {
      pendingCommit = text
      setTimeout(() => {
        if (pendingCommit === null) return // _isSendingComposition was cleared
        pendingCommit = null
        emit(text)
      }, 0)
    },
    // _handleAnyTextareaChanges(): the keyCode-229 branch. ALSO a timer, and
    // with no composition in flight — the gap that doubled the previous tip.
    scheduleTextareaDiffSend: (text: string) => {
      setTimeout(() => emit(text), 0)
    },
    // _finalizeComposition(false): a non-229 keydown during the send window
    // flushes synchronously and cancels the queued timer.
    finalizeNow: (text: string) => {
      pendingCommit = null
      emit(text)
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
    clock: { t: number }
  } {
    const pty: string[] = []
    const { target, dispatch, listenerCount } = fakeContainer()
    const xterm = fakeXterm(pty)
    const clock = { t: 1_000_000 }
    const detach = attachImeBridge(
      target,
      xterm.emitCount,
      (text) => pty.push(text),
      () => clock.t
    )
    return { pty, dispatch, xterm, detach, listenerCount, clock }
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
    // MUST flush: the bridge's send is deferred, so asserting before the timers
    // run makes this pass whether or not it would double. It did exactly that
    // for one revision of this branch.
    vi.runAllTimers()
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

  it('CRITICAL-1: keydown 229 with NO composition is not doubled', () => {
    // The path that blocked the previous tip. CompositionHelper.keydown sees
    // keyCode 229 outside a composition and calls _handleAnyTextareaChanges(),
    // whose whole body is inside setTimeout(0). No compositionstart, no
    // compositionend, so neither window applies — a synchronous emit-count check
    // sees nothing sent and forwards, then xterm's timer forwards again.
    const r = rig()
    r.xterm.scheduleTextareaDiffSend('7')
    r.dispatch('input', { inputType: 'insertText', data: '7' })
    vi.runAllTimers()
    expect(r.pty).toEqual(['7'])
  })

  it('CRITICAL-1: the same for CJK punctuation', () => {
    const r = rig()
    r.xterm.scheduleTextareaDiffSend('，')
    r.dispatch('input', { inputType: 'insertText', data: '，' })
    vi.runAllTimers()
    expect(r.pty).toEqual(['，'])
  })

  it('CRITICAL-1: and still rescues when xterm schedules NOTHING', () => {
    // The other half — if the deferred re-check declined unconditionally it
    // would pass the two cases above by dropping every character instead.
    const r = rig()
    r.dispatch('input', { inputType: 'insertText', data: '7' })
    vi.runAllTimers()
    expect(r.pty).toEqual(['7'])
  })

  it('MEDIUM-1: the commit window closes as soon as xterm delivers', () => {
    // Precise signal: once the commit is out, a following insertText is a NEW
    // character and must be rescued, not swallowed as part of the commit.
    const r = rig()
    r.xterm.scheduleCommitSend('端')
    r.dispatch('compositionend')
    vi.runAllTimers() // xterm's commit lands, closing the window
    r.dispatch('input', { inputType: 'insertText', data: '。' })
    vi.runAllTimers()
    expect(r.pty).toEqual(['端', '。'])
  })

  it('MEDIUM-1: the window is bounded in wall clock, not by a macrotask', () => {
    // A blocked main thread used to hold the window open for the length of the
    // blocking task, silently eating real keystrokes — the ORIGINAL bug. Here
    // xterm never delivers and the clock advances past the cap; the character
    // must still be rescued.
    const r = rig()
    r.dispatch('compositionend') // commit pending, nothing scheduled
    r.clock.t += 500 // main thread blocked half a second
    r.dispatch('input', { inputType: 'insertText', data: '。' })
    vi.runAllTimers()
    expect(r.pty).toEqual(['。'])
  })

  it('MEDIUM-2: Enter during the send window flushes xterm synchronously', () => {
    // The REAL empty-commit mechanism, pinned. Terminal.ts clears the textarea
    // on Enter, so _finalizeComposition(true)'s deferred re-read would send ''.
    // What saves the text is CompositionHelper.keydown calling
    // _finalizeComposition(FALSE) — synchronous — and cancelling the timer.
    // The bridge must stay out of it either way: exactly one copy.
    const r = rig()
    r.xterm.scheduleCommitSend('端')
    r.dispatch('compositionend')
    r.dispatch('input', { inputType: 'insertText', data: '端' })
    r.xterm.finalizeNow('端') // Enter arrives; xterm flushes now, cancels timer
    vi.runAllTimers()
    expect(r.pty).toEqual(['端'])
  })

  it('detach removes every listener it added', () => {
    const r = rig()
    r.detach()
    expect(r.listenerCount()).toBe(0)
  })
})
