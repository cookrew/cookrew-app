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
export function attachImeBridge(
  container: ImeBridgeTarget,
  xtermEmitCount: () => number,
  send: (text: string) => void
): () => void {
  let countBeforeInput = 0
  let inComposition = false
  let commitPending = false

  const onCompositionStart = (): void => {
    inComposition = true
  }
  const onCompositionEnd = (): void => {
    inComposition = false
    // xterm's _finalizeComposition(true) sends the committed text on a
    // setTimeout(0), so a synchronous emit-count comparison cannot see it —
    // the send is scheduled, not made. Any insertText in this window is the
    // same commit arriving through the second door; forwarding it is the
    // first-character doubling that got b08fbb6 reverted. xterm's handler ran
    // in the target phase, before this bubble listener, so its timer is
    // already queued and this one fires after it.
    commitPending = true
    setTimeout(() => {
      commitPending = false
    }, 0)
  }
  const onInputCapture = (): void => {
    countBeforeInput = xtermEmitCount()
  }
  const onInputBubble = (event: Event): void => {
    const ie = event as InputEvent
    // A composition owns its text, open or just-committed; xterm delivers it.
    if (inComposition || commitPending) return
    const text = imeTextToForward(ie.inputType, ie.data, xtermEmitCount() !== countBeforeInput)
    if (text === null) return
    send(text)
  }
  container.addEventListener('compositionstart', onCompositionStart, false)
  container.addEventListener('compositionend', onCompositionEnd, false)
  container.addEventListener('input', onInputCapture, true)
  container.addEventListener('input', onInputBubble, false)
  return () => {
    container.removeEventListener('compositionstart', onCompositionStart, false)
    container.removeEventListener('compositionend', onCompositionEnd, false)
    container.removeEventListener('input', onInputCapture, true)
    container.removeEventListener('input', onInputBubble, false)
  }
}
