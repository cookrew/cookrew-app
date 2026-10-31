/**
 * On a phone, xterm's hidden textarea is the keyboard's field, and the field is
 * the truth: what reaches the agent is what CHANGED in it, as a line editor
 * hears a change — a DEL for every character taken back, then the new text.
 *
 * Three phone reports, one lesson — xterm reads the field with assumptions a
 * soft keyboard breaks:
 *
 *   - Backspace sent nothing (2026-11-01). A soft keyboard deletes in the field
 *     it types into; an EMPTY field has nothing to delete, Android changes
 *     nothing and iOS fires no event. Hence the padding before the caret, as the
 *     streamed browser's keyboard does it (useRemoteKeyboard.ts).
 *   - Every word went out again with the padding (Samsung, pinyin). xterm's
 *     "what changed" is new.replace(old, ''): once the keyboard touched anything
 *     before the caret, old was no longer inside new and xterm sent the field.
 *   - Every composition update was appended, pinyin and all (Samsung, same
 *     day: the box read stray Latin letters, then one hanzi four times).
 *     Samsung Keyboard FINISHES the composing word on every key
 *     (compositionend) and takes it back on the next as a composing region,
 *     with no compositionstart. xterm sends field.substring(start) at
 *     each compositionend, with `start` set only at a compositionstart: stale,
 *     it sent the whole field once per letter; on fresh padding the keyboard
 *     wrote the longer word over spaces and xterm appended it, then turned the
 *     candidate replacing "chun" into one DEL — pinyin kept, hanzi lost.
 *
 * So on a phone xterm sends nothing it read from the field (muteXtermFieldSends,
 * and its insertText path never sees an input event), and this sends the edit:
 * the keyboard's own view of the field decides, whatever order its events come
 * in. An update that rewrites the composing word REPLACES it (DELs, then the
 * word); a candidate replacing its pinyin takes the pinyin back; a "," the
 * keyboard turns full-width before the caret is taken back and retyped. Typed
 * text may stay in the field, so the keyboard keeps its word and its view
 * matches the agent's line; the field is padded again only when it runs low or
 * grows long, never mid-composition.
 *
 * xterm's KEY path is untouched: Enter, a hardware key, a letter iOS delivers as
 * a key event. A key xterm sent can still land in the field as well (keypress is
 * not cancelled); the same text arriving within ECHO_MS is not sent twice.
 */

/** Spaces: no word for a keyboard to predict on, nothing to autocorrect. */
export const PAD = ' '.repeat(32)

const DEL = '\x7f'

/** Backspace needs something before the caret to delete: below this, the field is padded again. */
const LOW = PAD.length / 2

/** Past this the field is wiped back to padding — between words, never mid-composition. */
const FULL = 512

/**
 * How far back a key xterm sent itself can reappear in the field: the owner's
 * "VVery good" (a dictation keyboard sends the first letter as a key, then the
 * phrase with that letter in it). Measured ~1 ms apart; far below a human's
 * second keystroke.
 */
const ECHO_MS = 50

/** keyCode 229 is the IME's own; Shift, Ctrl and Alt do not end a composition (CompositionHelper.keydown). */
const COMPOSING_KEYS = new Set([229, 16, 17, 18])

/** A send of plain text, no control character: what a key can leave in the field. */
const PRINTABLE = /^[^\x00-\x1f\x7f]+$/

/** Whether the field should be padded again: too little before the caret for Backspace, or too much kept. */
export function needsSeed(value: string): boolean {
  return value.length < LOW || value.length > FULL
}

/** One change to the field, caret at the end: how many characters were taken back, and what came after. */
export interface FieldEdit {
  deleted: number
  inserted: string
}

/** From `before` to `after`, by code point: a hanzi or an emoji is one Backspace in the agent's line. */
export function fieldEdit(before: string, after: string): FieldEdit {
  const was = Array.from(before)
  const now = Array.from(after)
  let same = 0
  while (same < was.length && same < now.length && was[same] === now[same]) same += 1
  return { deleted: was.length - same, inserted: now.slice(same).join('') }
}

/** One send xterm made itself, and when. */
export interface KeyEcho {
  at: number
  text: string
}

/** `inserted` without a head xterm already sent as keys within ECHO_MS of `at`. */
export function withoutEcho(inserted: string, echoes: readonly KeyEcho[], at: number): string {
  const recent = echoes
    .filter((e) => e.at <= at && at - e.at <= ECHO_MS)
    .map((e) => e.text)
    .join('')
  if (recent.length === 0 || !inserted.startsWith(recent)) return inserted
  return inserted.slice(recent.length)
}

/** The line editor's form of an edit, echoes removed. */
export function editToSend(edit: FieldEdit, echoes: readonly KeyEcho[], at: number): string {
  return DEL.repeat(edit.deleted) + withoutEcho(edit.inserted, echoes, at)
}

/**
 * Stop xterm sending what it reads out of the field: its CompositionHelper
 * (compositionend and the keyCode-229 diff) sends only through its own core
 * service, so that one reference is swapped for a sink. Its composition view —
 * the pinyin drawn at the cursor — keeps working. Private to xterm 5.5.0
 * (pinned, and checked by tests/textarea-pad.test.ts): false when the shape is
 * not there, and the caller must then leave the field to xterm.
 */
export function muteXtermFieldSends(term: unknown): boolean {
  const core = (term as { _core?: { _compositionHelper?: Record<string, unknown> } } | null)?._core
  const helper = core?._compositionHelper
  if (!helper || typeof helper !== 'object' || !('_coreService' in helper)) return false
  // Patching a library's internals in place: there is no public way to keep the view and drop the send.
  helper._coreService = { triggerDataEvent: (): void => undefined }
  return true
}

type Listener = (ev: Event) => void

/** The slice of a DOM node the field needs; a test can fake it. */
export interface ListenTarget {
  addEventListener(type: string, listener: Listener, capture?: boolean): void
  removeEventListener(type: string, listener: Listener, capture?: boolean): void
}

/** The slice of xterm's textarea the field needs. */
export interface PadTarget extends ListenTarget {
  value: string
  setSelectionRange(start: number, end: number): void
}

export interface PhoneFieldOptions {
  /** What goes to the agent. */
  send: (data: string) => void
  now?: () => number
  /** Runs `fn` after the events in flight; returns a cancel. */
  later?: (fn: () => void) => () => void
}

export interface PhoneField {
  /** Every send xterm makes itself: a key it sent may land in the field too, and Enter or Ctrl+C empties the field. */
  xtermSent(data: string): void
  detach(): void
}

const nextTask = (fn: () => void): (() => void) => {
  const timer = setTimeout(fn, 0)
  return () => clearTimeout(timer)
}

/**
 * Wire the field. Container listeners run in CAPTURE, so before xterm's own on
 * the textarea: a commit is sent before the key that ended it, and xterm's
 * insertText path never sees an input event. The textarea's blur listener runs
 * after xterm's, which empties the field on blur.
 */
export function attachPhoneField(
  textarea: PadTarget,
  container: ListenTarget,
  { send, now = Date.now, later = nextTask }: PhoneFieldOptions
): PhoneField {
  /** The field as the agent has it. */
  let base = textarea.value
  let composing = false
  let echoes: KeyEcho[] = []
  const pending = new Set<() => void>()

  const sync = (): void => {
    if (composing) return
    const value = textarea.value
    if (value === base) return
    const data = editToSend(fieldEdit(base, value), echoes, now())
    base = value
    if (data.length > 0) send(data)
  }
  const seed = (): void => {
    textarea.value = PAD
    textarea.setSelectionRange(PAD.length, PAD.length)
    base = PAD
  }
  const tidy = (): void => {
    if (composing) return
    sync()
    if (needsSeed(textarea.value)) seed()
  }
  const tidyLater = (): void => {
    const cancel = later(() => {
      pending.delete(cancel)
      tidy()
    })
    pending.add(cancel)
  }
  /** xterm wrote the field itself (blur, a long press, a paste): the agent's line did not change. */
  const rebase = (): void => {
    base = textarea.value
  }

  const onInput = (ev: Event): void => {
    // xterm's own input handler sends an insertText it saw no keydown for: field text, ours to send.
    ev.stopPropagation()
    // A composing region taken back opens a composition without a compositionstart.
    if ((ev as InputEvent).inputType === 'insertCompositionText') composing = true
    sync()
    tidyLater()
  }
  const onCompositionStart = (): void => {
    sync()
    composing = true
  }
  const onCompositionEnd = (): void => {
    composing = false
    sync()
    tidyLater()
  }
  const onKeyDown = (ev: Event): void => {
    // A real key ends a composition (Enter, an arrow): the word goes out before the key does.
    if (composing && !COMPOSING_KEYS.has((ev as KeyboardEvent).keyCode)) {
      composing = false
      sync()
    }
  }
  const onBlur = (): void => {
    composing = false
    rebase()
  }

  const onContainer: [string, Listener][] = [
    ['input', onInput],
    ['compositionstart', onCompositionStart],
    ['compositionend', onCompositionEnd],
    ['keydown', onKeyDown]
  ]
  for (const [type, fn] of onContainer) container.addEventListener(type, fn, true)
  // Bubble: after xterm's handlers, which write the field for these.
  container.addEventListener('contextmenu', rebase, false)
  container.addEventListener('paste', rebase, false)
  textarea.addEventListener('blur', onBlur)
  textarea.addEventListener('focus', tidy)
  tidy()

  return {
    xtermSent(data) {
      if (/[\r\x03]/.test(data)) {
        echoes = []
        rebase()
        tidyLater()
        return
      }
      if (PRINTABLE.test(data)) echoes = [...echoes.slice(-15), { at: now(), text: data }]
    },
    detach() {
      for (const cancel of pending) cancel()
      pending.clear()
      for (const [type, fn] of onContainer) container.removeEventListener(type, fn, true)
      container.removeEventListener('contextmenu', rebase, false)
      container.removeEventListener('paste', rebase, false)
      textarea.removeEventListener('blur', onBlur)
      textarea.removeEventListener('focus', tidy)
    }
  }
}
