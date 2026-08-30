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
