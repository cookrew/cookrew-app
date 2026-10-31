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
 * at value.length) — and, as there, the field is put back to bare padding
 * after EVERY edit: never mid-composition and never before xterm has read the
 * field (the re-seed is queued after the input event, behind the timers xterm
 * queued at keydown and compositionend).
 *
 * After every edit, not only when it ran low (phone report 2026-11-01, Samsung
 * keyboard, pinyin): kept, the typed text piled up in the field until Enter,
 * and each word went out again with every word before it and the padding.
 * xterm's "what changed" is new.replace(old, ''); once the keyboard touches
 * anything before the caret, old is no longer inside new and xterm sends the
 * whole field. With nothing but padding in it, there is nothing old to resend,
 * and withoutPad keeps the padding itself from ever reaching the agent.
 */

/** Spaces: no word for a keyboard to predict on, nothing to autocorrect. */
export const PAD = ' '.repeat(32)

/** Whether the field should be put back to bare padding: whenever it is anything else. */
export function needsSeed(value: string): boolean {
  return value !== PAD
}

/** A run of spaces this long at the head of one send is the padding (a few Backspaces may have eaten into it), never typing. */
const PAD_RUN = new RegExp(`^ {${PAD.length - 8},}`)

/** What xterm sends, without the padding, should a send ever carry the whole field. */
export function withoutPad(data: string): string {
  return data.replace(PAD_RUN, '')
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
  /** Counts compositions begun: a re-seed queued before one began stands down (seedLater). */
  let compositions = 0
  const pending = new Set<() => void>()

  const seedIfDry = (): void => {
    if (composing || !needsSeed(textarea.value)) return
    textarea.value = PAD
    textarea.setSelectionRange(PAD.length, PAD.length)
  }
  // Queued behind xterm's own read of the field. A composition's inputs queue
  // nothing: their timers would run before the one xterm queues AT
  // compositionend, and wipe the committed word before it is read. The
  // composition's re-seed is compositionend's own, queued after xterm's.
  const seedLater = (): void => {
    if (composing) return
    const at = compositions
    const cancel = later(() => {
      pending.delete(cancel)
      if (at === compositions) seedIfDry()
    })
    pending.add(cancel)
  }
  const onCompositionStart = (): void => {
    composing = true
    compositions += 1
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
