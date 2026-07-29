import { useCallback, useRef, useState } from 'react'
import { keyMsg, type CastInputMsg } from './browser-stream'

/**
 * Mobile keyboard bridge for the streamed browser.
 *
 * The phone renders the page as an IMAGE, so tapping a remote text field focuses
 * it server-side but never raises the phone's soft keyboard — there is no real
 * focused input on the phone. This bridges that: a hidden <textarea> (a genuine
 * focusable element) is focused INSIDE the user's tap gesture — the only way
 * iOS/Android will show the keyboard — and whatever the user types is forwarded
 * to the remote page's focused field via the EXISTING whitelisted key vocabulary
 * (keyMsg → Input.dispatchKeyEvent). No new CDP method, no server change.
 *
 * PHANTOM BUFFER: the field is kept pre-filled with padding and the cursor in the
 * middle, then re-seeded after every edit. This is why Backspace works — on an
 * empty field iOS fires NO delete event (nothing to delete locally), so a plain
 * backspace was silently dropped. With padding on both sides, Backspace always
 * deletes a pad char → fires deleteContentBackward → forwards a real Backspace;
 * the padding is never itself forwarded (we forward the beforeinput data / event
 * type, not the buffer contents).
 *
 * Known limits (follow-ups): IME composition (CJK) and paste are only partial via
 * per-char keys — a dedicated CDP Input.insertText path would be more faithful
 * but adds to the whitelist.
 */

/** Pure: map one beforeinput (inputType, data) to whitelisted key messages. */
export function keyMsgsForInput(inputType: string, data: string | null): CastInputMsg[] {
  switch (inputType) {
    case 'insertText':
    case 'insertCompositionText':
      return data ? [...data].map((ch) => keyMsg(ch, '')) : []
    case 'insertLineBreak':
    case 'insertParagraph':
      return [keyMsg('Enter', 'Enter')]
    case 'deleteContentBackward':
    case 'deleteWordBackward':
      return [keyMsg('Backspace', 'Backspace')]
    case 'deleteContentForward':
    case 'deleteWordForward':
      return [keyMsg('Delete', 'Delete')]
    default:
      return [] // unknown inputType → forward nothing (fail closed)
  }
}

export interface RemoteKeyboard {
  open: boolean
  /** Toggle the phone keyboard — MUST be called from a user gesture (button tap). */
  toggle: () => void
  close: () => void
  inputRef: React.RefObject<HTMLTextAreaElement>
  onBeforeInput: (e: React.FormEvent<HTMLTextAreaElement>) => void
  onInput: (e: React.FormEvent<HTMLTextAreaElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onBlur: () => void
}

/** Padding chars on each side of the cursor. Spaces avoid word-prediction. */
const PAD = ' '.repeat(24)

/** Fill the capture field with padding and drop the cursor in the middle. */
function seed(el: HTMLTextAreaElement): void {
  el.value = PAD + PAD
  el.setSelectionRange(PAD.length, PAD.length)
}

// Pure navigation keys that do NOT fire beforeinput (so they need keydown to be
// forwarded). Backspace / Delete / Enter are NOT here — with the phantom buffer
// they fire beforeinput and go through onBeforeInput, so forwarding them via
// keydown too would double them.
const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Escape', 'Tab'])

export function useRemoteKeyboard(send: (msg: CastInputMsg) => void): RemoteKeyboard {
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const close = useCallback((): void => {
    inputRef.current?.blur()
    setOpen(false)
  }, [])

  const toggle = useCallback((): void => {
    const el = inputRef.current
    if (!el) return
    if (open) {
      close()
      return
    }
    // Focus synchronously in the gesture so the OS raises the soft keyboard, then
    // seed the phantom buffer so the first Backspace has something to delete.
    el.focus()
    seed(el)
    setOpen(true)
  }, [open, close])

  const onBeforeInput = useCallback(
    (e: React.FormEvent<HTMLTextAreaElement>): void => {
      const ie = e.nativeEvent as InputEvent
      for (const msg of keyMsgsForInput(ie.inputType, ie.data)) send(msg)
    },
    [send]
  )

  // Re-seed after every edit so the buffer never depletes or grows — Backspace
  // always has padding to delete and typing always has room.
  const onInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>): void => {
    seed(e.currentTarget)
  }, [])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      if (!NAV_KEYS.has(e.key)) return // text + Backspace/Enter go via onBeforeInput
      e.preventDefault() // keep the local buffer cursor put; only the remote moves
      e.stopPropagation() // do not also trip the frame's own key handler
      send(keyMsg(e.key, e.code || e.key))
    },
    [send]
  )

  const onBlur = useCallback((): void => setOpen(false), [])

  return { open, toggle, close, inputRef, onBeforeInput, onInput, onKeyDown, onBlur }
}
