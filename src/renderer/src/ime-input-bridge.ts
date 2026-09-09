/**
 * Recover the text an iOS IME commits that xterm throws away.
 *
 * xterm 5.5.0 forwards a committed `insertText` only when
 *
 *     ev.data && ev.inputType === 'insertText' &&
 *     (!ev.composed || !this._keyDownSeen)
 *
 * (Terminal.ts). A real user event always has `composed === true`, so this
 * reduces to "no keydown was seen first". `_keyDownSeen` is set in _keyDown and
 * cleared only in _keyUp — and an iOS soft keyboard DOES fire a keydown before
 * the input event (with `Unidentified` or keyCode 229, see terminal-key-intent),
 * while its keyup arrives late or not at all. So the condition is false and the
 * text is dropped on the floor.
 *
 * Two reports, one mechanism:
 *
 *   - The iOS Chinese keyboard's number/punctuation layer types nothing. Hanzi
 *     survive because they arrive through real composition events, which take a
 *     different path entirely; digits and punctuation are plain insertText.
 *   - Typeless (dictation) commits a whole phrase as one insertText, and only a
 *     single leading character — whatever leaked through composition — arrives.
 *
 * xterm's own composition handler has a branch for exactly this case, but it is
 * reached only via `keydown` with keyCode === 229, which iOS does not reliably
 * deliver. Hence a bridge in our layer rather than a patch to theirs.
 */

/** Input types we claim. Deliberately just the one. */
const FORWARDED = 'insertText'

/**
 * The text to send to the PTY for one input event, or null to stay out of it.
 *
 * Fails closed, like keyMsgsForInput: an unrecognised inputType forwards
 * nothing. That is not caution for its own sake — every other inputType here
 * already has an owner, and claiming one twice is worse than claiming none:
 *
 *   - insertCompositionText belongs to xterm's CompositionHelper, which reads
 *     the textarea on compositionend. Forwarding it too would double every
 *     hanzi, the one thing that currently works.
 *   - insertFromPaste belongs to the overlay's single paste listener, which
 *     already had a double-insert bug of its own.
 *   - insertLineBreak / insertParagraph and the deletes are keydown's, and
 *     xterm handles them before an input event is ever considered.
 */
export function imeTextToForward(
  inputType: string,
  data: string | null,
  xtermAlreadySent: boolean
): string | null {
  // xterm got there first — its _inputEvent fired and emitted. Sending again
  // would double the character.
  if (xtermAlreadySent) return null
  if (inputType !== FORWARDED) return null
  if (data === null || data.length === 0) return null
  return data
}

/** One thing xterm sent to the PTY, and when. */
export interface XtermEmit {
  at: number
  text: string
}

/** What the bridge is told about xterm's output: a running count plus a recent log. */
export interface XtermEmitted {
  count: number
  log: readonly XtermEmit[]
}

/**
 * How far back "xterm just sent this" reaches.
 *
 * The owner's "VVery good" / "FFirst letter": a dictation keyboard delivers
 * the first letter as a KEY event — which xterm emits itself, via keypress,
 * BEFORE any input event exists — and that same key also fires an
 * input/insertText for the letter, then the whole phrase, first letter
 * included, as a second insertText. A count comparison is blind to both: the
 * emit landed before the input event, so the snapshot already includes it.
 * Measured in the harness at ~1ms between the emit and the input events.
 * 50ms is generous for that and far below anything a human types twice.
 */
const RECENT_EMIT_MS = 50

/** The slice of an EventTarget the bridge needs; a test can fake it. */
export interface ImeBridgeTarget {
  addEventListener(type: string, listener: (ev: Event) => void, capture?: boolean): void
  removeEventListener(type: string, listener: (ev: Event) => void, capture?: boolean): void
}

/**
 * Wire the rescue onto a terminal container. Returns a cleanup function.
 *
 * The ORDERING is what makes "never double-send" true, and it is why both
 * listeners sit on the container rather than the textarea. Capture runs
 * ancestor-first, so ours fires BEFORE xterm's own capture listener on the
 * textarea and can snapshot the emit count. Bubble runs last, after xterm has
 * had its turn.
 *
 * The bubble listener ALWAYS runs — xterm's cancel() is a no-op unless
 * options.cancelEvents is set (it defaults false and the overlay does not set
 * it), so there is no stopPropagation shielding us. The emit-count comparison
 * is the ONLY thing preventing a double-send on the synchronous path; nothing
 * can interleave mid-dispatch, which is what makes it sound. Do not remove it
 * on the strength of an imagined event-cancellation defense.
 */
/**
 * Strip from `text` whatever xterm itself emitted just before the input event
 * it came from. Returns '' when the whole thing is a duplicate.
 *
 * Content, not count, because the count cannot see an emit that PRECEDED the
 * input event. Two shapes, both from the owner's device:
 *   - the letter itself: xterm sent "V" via keypress, then the key's own
 *     input/insertText "V" arrives — a pure duplicate, forward nothing;
 *   - the phrase: Typeless then commits "Very good", first letter included,
 *     so the head xterm already sent is stripped and "ery good" goes out.
 * Only a HEAD is stripped, and only one that xterm sent within the window: a
 * genuine repeated letter typed by a human is seconds apart, not ~1ms.
 */
export function withoutWhatXtermJustSent(
  text: string,
  log: readonly XtermEmit[],
  inputAt: number
): string {
  const recent = log
    .filter((e) => e.at >= inputAt - RECENT_EMIT_MS && e.at <= inputAt)
    .map((e) => e.text)
    .join('')
  if (recent.length === 0) return text
  if (text === recent) return ''
  if (text.startsWith(recent)) return text.slice(recent.length)
  return text
}

/**
 * How long the just-committed window may stay open.
 *
 * The window used to be "one macrotask", which is a scheduling event and not a
 * duration: under a blocked main thread — and the overlay blocks it, xterm
 * renders and fits on this thread — the clearing timer is delayed by the length
 * of the blocking task, and every insertText arriving meanwhile is dropped. A
 * dropped character is the ORIGINAL bug, so the window is bounded in wall clock
 * as well. 50ms is far below the gap between human keystrokes and far above the
 * same-tick commit follow-up this exists to swallow.
 */
const COMMIT_WINDOW_MS = 50

export function attachImeBridge(
  container: ImeBridgeTarget,
  emitted: () => XtermEmitted,
  send: (text: string) => void,
  now: () => number = () => Date.now()
): () => void {
  const xtermEmitCount = (): number => emitted().count
  let countBeforeInput = 0
  let inComposition = false
  let commitPending = false
  let commitAt = 0
  let countAtCommit = 0
  const timers = new Set<ReturnType<typeof setTimeout>>()

  const later = (fn: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, 0)
    timers.add(timer)
  }

  const onCompositionStart = (): void => {
    inComposition = true
  }
  const onCompositionEnd = (): void => {
    inComposition = false
    // xterm's _finalizeComposition(true) sends the committed text on a
    // setTimeout(0), so a synchronous emit-count comparison cannot see it —
    // the send is scheduled, not made. Any insertText in this window is the
    // same commit arriving through the second door; forwarding it is the
    // first-character doubling that got b08fbb6 reverted.
    commitPending = true
    commitAt = now()
    countAtCommit = xtermEmitCount()
  }

  /**
   * Is the commit still undelivered? Two ways to answer no, because "one
   * macrotask" was not an answer at all (MEDIUM-1):
   *   - xterm has emitted since the commit, so the text is already out; or
   *   - the window has simply been open too long.
   * Closing on the emit is the precise signal; the clock is the backstop for a
   * commit that never arrives.
   */
  const stillAwaitingCommit = (): boolean => {
    if (!commitPending) return false
    if (xtermEmitCount() !== countAtCommit) {
      commitPending = false
      return false
    }
    if (now() - commitAt >= COMMIT_WINDOW_MS) {
      commitPending = false
      return false
    }
    return true
  }

  let inputAt = 0
  const onInputCapture = (): void => {
    countBeforeInput = xtermEmitCount()
    inputAt = now()
  }
  const onInputBubble = (event: Event): void => {
    const ie = event as InputEvent
    // A composition owns its text, open or just-committed; xterm delivers it.
    if (inComposition || stillAwaitingCommit()) return
    const text = imeTextToForward(ie.inputType, ie.data, xtermEmitCount() !== countBeforeInput)
    if (text === null) return

    // DEFER, then re-check. The synchronous comparison above catches only a
    // send xterm makes DURING dispatch, and xterm has two paths that merely
    // SCHEDULE one: _finalizeComposition(true) at compositionend, and
    // _handleAnyTextareaChanges() from the keyCode-229 keydown — the latter with
    // no composition at all, so no window covers it. Both were measured to
    // double a synchronous bridge (CDP harness, digit case 3/3).
    //
    // The ordering that makes this sound is FIFO: xterm queues its timer at
    // keydown or at compositionend, both strictly BEFORE the input event where
    // this one is queued, so xterm's callback runs first and this re-check sees
    // its emit. Honest caveat: that argument assumes compositionend never
    // arrives AFTER the insertText it belongs to. No trace has shown that
    // ordering, but it is not proven impossible — if it happens, the commit is
    // forwarded twice and this comment is where to start.
    const countAtQueue = xtermEmitCount()
    const at = inputAt
    later(() => {
      if (xtermEmitCount() !== countAtQueue) return
      const remainder = withoutWhatXtermJustSent(text, emitted().log, at)
      if (remainder.length > 0) send(remainder)
    })
  }
  container.addEventListener('compositionstart', onCompositionStart, false)
  container.addEventListener('compositionend', onCompositionEnd, false)
  container.addEventListener('input', onInputCapture, true)
  container.addEventListener('input', onInputBubble, false)
  return () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    container.removeEventListener('compositionstart', onCompositionStart, false)
    container.removeEventListener('compositionend', onCompositionEnd, false)
    container.removeEventListener('input', onInputCapture, true)
    container.removeEventListener('input', onInputBubble, false)
  }
}
