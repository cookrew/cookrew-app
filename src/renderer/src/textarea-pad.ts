/**
 * Keep xterm's hidden textarea from running dry, so a phone's Backspace deletes.
 *
 * A soft keyboard deletes in the field it is typing into: Android sends a
 * keyCode-229 keydown and removes a character, and xterm turns "the field got
 * shorter" into DEL (CompositionHelper._handleAnyTextareaChanges). On an EMPTY
 * field there is nothing to remove — Android changes nothing and iOS fires no
 * event at all — so Backspace never reaches the agent. The field IS empty
 * whenever a terminal opens, and again once a few Backspaces have eaten
 * whatever was typed in it: "I can't delete in LIVE".
 *
 * The streamed browser's keyboard hit the same wall (useRemoteKeyboard.ts) and
 * the cure is the same: padding before the cursor. Here it goes only BEFORE —
 * xterm assumes the cursor sits at the end of the field (a composition starts
 * at value.length) — and is topped up only when it runs low or the field has
 * grown long, never mid-composition and never before xterm has read the field:
 * the re-seed is queued after the input event, behind the timers xterm queued
 * at keydown and compositionend. The padding is never sent; xterm sends what
 * changed, not what is there.
 */

/** Spaces: no word for a keyboard to predict on, nothing to autocorrect. */
export const PAD = ' '.repeat(32)

/** Fewer than this left and the next few Backspaces could find the field empty. */
const LOW = 8

/** Typed text piles up in the field; past this it is cleared back to padding. */
const HIGH = 512

/** Whether the field should be put back to bare padding. */
export function needsSeed(value: string): boolean {
  return value.length < LOW || value.length > HIGH
}

/** The slice of a textarea the pad needs; a test can fake it. */
export interface PadTarget {
  value: string
  setSelectionRange(start: number, end: number): void
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

export function attachTextareaPad(
  textarea: PadTarget,
  later: (fn: () => void) => () => void = (fn) => {
    const timer = setTimeout(fn, 0)
    return () => clearTimeout(timer)
  }
): () => void {
  let composing = false
  const pending = new Set<() => void>()

  const seedIfDry = (): void => {
    if (composing || !needsSeed(textarea.value)) return
    textarea.value = PAD
    textarea.setSelectionRange(PAD.length, PAD.length)
  }
  const seedLater = (): void => {
    const cancel = later(() => {
      pending.delete(cancel)
      seedIfDry()
    })
    pending.add(cancel)
  }
  const onCompositionStart = (): void => {
    composing = true
  }
  const onCompositionEnd = (): void => {
    composing = false
    seedLater()
  }

  textarea.addEventListener('focus', seedIfDry)
  textarea.addEventListener('input', seedLater)
  textarea.addEventListener('compositionstart', onCompositionStart)
  textarea.addEventListener('compositionend', onCompositionEnd)
  seedIfDry()
  return () => {
    for (const cancel of pending) cancel()
    pending.clear()
    textarea.removeEventListener('focus', seedIfDry)
    textarea.removeEventListener('input', seedLater)
    textarea.removeEventListener('compositionstart', onCompositionStart)
    textarea.removeEventListener('compositionend', onCompositionEnd)
  }
}
