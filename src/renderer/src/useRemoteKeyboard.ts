import { useCallback, useRef, useState } from 'react'
import { keyMsg, type CastInputMsg } from './browser-stream'

/**
 * Mobile keyboard bridge for the streamed browser (PROTOTYPE).
 *
 * The phone renders the page as an IMAGE, so tapping a remote text field focuses
 * it server-side but never raises the phone's soft keyboard — there is no real
 * focused input on the phone. This bridges that: a hidden <textarea> (a genuine
 * focusable element) is focused INSIDE the user's tap gesture — the only way
 * iOS/Android will show the keyboard — and whatever the user types is forwarded
 * to the remote page's focused field via the EXISTING whitelisted key vocabulary
 * (keyMsg → Input.dispatchKeyEvent). No new CDP method, no server change.
 *
 * Known prototype limits (follow-ups): IME composition (CJK) and paste are only
 * partially covered by per-char key events — a dedicated text-insert path
 * (CDP Input.insertText) would be more faithful but adds to the whitelist.
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
      return [keyMsg('Backspace', 'Backspace')]
    case 'deleteContentForward':
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
  onBlur: () => void
}

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
    el.value = ''
    // Focus synchronously in the gesture so the OS raises the soft keyboard.
    el.focus()
    setOpen(true)
  }, [open, close])

  const onBeforeInput = useCallback(
    (e: React.FormEvent<HTMLTextAreaElement>): void => {
      const ie = e.nativeEvent as InputEvent
      for (const msg of keyMsgsForInput(ie.inputType, ie.data)) send(msg)
    },
    [send]
  )

  // Keep the hidden field empty so it is a pure keystroke capture, not an editor.
  const onInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>): void => {
    e.currentTarget.value = ''
  }, [])

  const onBlur = useCallback((): void => setOpen(false), [])

  return { open, toggle, close, inputRef, onBeforeInput, onInput, onBlur }
}
