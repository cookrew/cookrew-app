import { useCallback, useRef, useState } from 'react'
import { composeMsg, keyMsg, modsOf, pasteMsg, textMsg, type CastInputMsg, type FieldMode } from './browser-stream'

/**
 * Keyboard bridge for the streamed browser: one hidden <textarea> that takes
 * the keys and hands them to the remote page.
 *
 * The page is a PICTURE, so nothing in it can hold focus or raise a keyboard.
 * This field is the real focused element on this side, in both of its modes:
 *
 *   DESKTOP — focused by the first click into the page. Each key goes out as a
 *   key, modifiers included, so ⌘A selects and ⌘Z undoes in the remote field
 *   (cast-input.ts derives the editing command). An IME is left alone to
 *   compose here: its in-progress text is mirrored live into the page
 *   (Input.imeSetComposition) and its result goes in whole (Input.insertText),
 *   which is the only way Chinese, Japanese or a dead-key accent can arrive.
 *   ⌘V pastes this Mac's clipboard as text.
 *
 *   TOUCH — the phone. The field is focused INSIDE a tap (the only way
 *   iOS/Android will show the soft keyboard): the ⌨ button's, or a tap on a
 *   text field of the page (raise, from MobileBrowserFrame's hit test against
 *   the page's own field report). Soft keyboards speak in beforeinput, not
 *   keys. An IME composes HERE, shown in the bar above the keyboard
 *   (RemoteKeyBar), and only the finished words go to the page — over the
 *   relay that is one message per word, and a page's search-as-you-type never
 *   sees half-typed pinyin.
 *
 * PHANTOM BUFFER (touch): the field is kept pre-filled with padding and the
 * cursor in the middle, re-seeded after every edit — never mid-composition,
 * which would cancel the IME. This is why Backspace works: on an empty field
 * iOS fires NO delete event, so a plain backspace was silently dropped. The
 * padding is never itself forwarded (the beforeinput data is, not the buffer).
 */

export type KeyboardMode = 'desktop' | 'touch'

/** Pure: map one beforeinput (inputType, data) to whitelisted messages. Composition is not here: it has its own events. */
export function keyMsgsForInput(inputType: string, data: string | null): CastInputMsg[] {
  switch (inputType) {
    case 'insertText': {
      if (!data) return []
      // One character is a key (the page sees keydown, as it would); more
      // than one — a suggestion, an autocorrect, an emoji's surrogate pair —
      // goes in whole.
      if (data.length === 1) return [keyMsg(data, '')]
      const text = textMsg(data)
      return text ? [text] : []
    }
    case 'insertFromPaste':
    case 'insertFromDrop': {
      // The page sees a paste, as it would from its own clipboard.
      const paste = data ? pasteMsg(data) : null
      return paste ? [paste] : []
    }
    case 'insertReplacementText': {
      const text = data ? textMsg(data) : null
      return text ? [text] : []
    }
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

export interface DesktopKeyEvent {
  key: string
  code: string
  keyCode: number
  isComposing: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/**
 * What a desktop keydown in the field becomes:
 *   ime    — an IME or a dead key is composing: let the field have it.
 *   bubble — Escape stays the app's (it backs out of the zoom).
 *   paste  — ⌘V/Ctrl+V: let the native paste happen, it carries the text.
 *   ignore — a modifier alone: it rides on the next key or click instead.
 *   send   — everything else, as one key with its modifiers.
 * Pure — unit-tested.
 */
export type DesktopKeyAction =
  | { kind: 'ime' | 'bubble' | 'paste' | 'ignore' }
  | { kind: 'send'; msg: CastInputMsg }

const MODIFIER_KEYS = new Set(['Shift', 'Meta', 'Control', 'Alt', 'AltGraph', 'CapsLock', 'Fn', 'OS'])

export function desktopKeyAction(e: DesktopKeyEvent): DesktopKeyAction {
  if (e.isComposing || e.keyCode === 229 || e.key === 'Process' || e.key === 'Dead') return { kind: 'ime' }
  if (e.key === 'Escape') return { kind: 'bubble' }
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'v') return { kind: 'paste' }
  if (MODIFIER_KEYS.has(e.key) || e.key === 'Unidentified') return { kind: 'ignore' }
  return { kind: 'send', msg: keyMsg(e.key, e.code || e.key, modsOf(e)) }
}

export interface RaiseOptions {
  /** The soft keyboard the page's field wants (numbers for a number field). */
  mode?: FieldMode
  /** Where in the frame's box the field is: the caret's neighbourhood, so nothing scrolls. */
  at?: { x: number; y: number }
  /** Raised for a page field (a tap on it); the page's focus leaving closes it again. */
  auto?: boolean
}

/** The textarea's inputmode for a field's mode: a number pad, an email keyboard. */
export function inputModeFor(mode: FieldMode | undefined): string {
  if (mode === 'numeric' || mode === 'decimal' || mode === 'tel' || mode === 'email' || mode === 'url' || mode === 'search') return mode
  return 'text'
}

export interface RemoteKeyboard {
  open: boolean
  /** Raised for a page field, not by the ⌨ button. */
  auto: boolean
  /** The IME's text being composed on the phone, not sent yet (the bar shows it). */
  composition: string
  /** Raise the keyboard — MUST be called synchronously from a tap's handler. */
  raise: (options?: RaiseOptions) => void
  /** Toggle the phone keyboard — MUST be called from a user gesture (button tap). */
  toggle: () => void
  close: () => void
  /** Desktop: take the keys, with the IME's window near (x, y) in the frame's box. */
  focusAt: (x: number, y: number) => void
  /** Finish a composition in progress (the field commits it on blur), before input moves elsewhere. */
  endComposition: () => void
  inputRef: React.RefObject<HTMLTextAreaElement>
  onBeforeInput: (e: React.FormEvent<HTMLTextAreaElement>) => void
  onInput: (e: React.FormEvent<HTMLTextAreaElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onCompositionStart: () => void
  onCompositionUpdate: (e: React.CompositionEvent<HTMLTextAreaElement>) => void
  onCompositionEnd: (e: React.CompositionEvent<HTMLTextAreaElement>) => void
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  /** Desktop: a copy/cut that reached the field itself (the Edit menu) is the page's copy. */
  onCopy: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  onCut: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
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
/** ⌘ — the desktop is a Mac; cast-input maps Meta+C/X to the copy/cut commands. */
const MOD_META = 4

const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Escape', 'Tab'])

export function useRemoteKeyboard(send: (msg: CastInputMsg) => void, mode: KeyboardMode = 'touch'): RemoteKeyboard {
  const [open, setOpen] = useState(false)
  const [auto, setAuto] = useState(false)
  const [composition, setComposition] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const composingRef = useRef(false)

  /** Back to the resting buffer: padded on touch, empty on desktop. */
  const settle = useCallback(
    (el: HTMLTextAreaElement): void => {
      if (mode === 'touch') seed(el)
      else el.value = ''
    },
    [mode]
  )

  const close = useCallback((): void => {
    inputRef.current?.blur()
    setOpen(false)
  }, [])

  const raise = useCallback((options: RaiseOptions = {}): void => {
    const el = inputRef.current
    if (!el) return
    if (options.at) {
      el.style.left = `${Math.max(0, Math.round(options.at.x))}px`
      el.style.top = `${Math.max(0, Math.round(options.at.y))}px`
    }
    el.setAttribute('inputmode', inputModeFor(options.mode))
    el.setAttribute('enterkeyhint', options.mode === 'search' ? 'search' : 'enter')
    // Focus synchronously in the gesture so the OS raises the soft keyboard, then
    // seed the phantom buffer so the first Backspace has something to delete.
    if (document.activeElement !== el) {
      el.focus({ preventScroll: true })
      seed(el)
    }
    if (document.activeElement !== el) return // no gesture to raise it with (iOS outside a tap)
    setAuto(options.auto === true)
    setOpen(true)
  }, [])

  const toggle = useCallback((): void => {
    if (open) close()
    else raise()
  }, [open, close, raise])

  const focusAt = useCallback((x: number, y: number): void => {
    const el = inputRef.current
    if (!el) return
    // The IME's candidate window opens at the caret: put it where the owner clicked.
    el.style.left = `${Math.max(0, Math.round(x))}px`
    el.style.top = `${Math.max(0, Math.round(y))}px`
    if (document.activeElement !== el) el.focus({ preventScroll: true })
  }, [])

  const endComposition = useCallback((): void => {
    const el = inputRef.current
    if (!composingRef.current || !el) return
    // Blur ends the IME: compositionend commits (onCompositionEnd sends it), or
    // onBlur clears a composition that was dropped instead.
    el.blur()
  }, [])

  const onBeforeInput = useCallback(
    (e: React.FormEvent<HTMLTextAreaElement>): void => {
      if (mode !== 'touch') return
      const ie = e.nativeEvent as InputEvent
      if (ie.isComposing || composingRef.current) return
      for (const msg of keyMsgsForInput(ie.inputType, ie.data)) send(msg)
    },
    [send, mode]
  )

  // Re-seed after every edit so the buffer never depletes or grows — but never
  // mid-composition, which would cancel what the IME is building.
  const onInput = useCallback(
    (e: React.FormEvent<HTMLTextAreaElement>): void => {
      if (composingRef.current || (e.nativeEvent as InputEvent).isComposing) return
      settle(e.currentTarget)
    },
    [settle]
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      if (mode === 'touch') {
        if (!NAV_KEYS.has(e.key) || e.nativeEvent.isComposing) return // text + Backspace/Enter go via onBeforeInput
        e.preventDefault() // keep the local buffer cursor put; only the remote moves
        e.stopPropagation() // do not also trip the frame's own key handler
        send(keyMsg(e.key, e.code || e.key))
        return
      }
      const action = desktopKeyAction({
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        isComposing: e.nativeEvent.isComposing || composingRef.current,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey
      })
      if (action.kind !== 'send') return
      e.preventDefault()
      e.stopPropagation()
      send(action.msg)
    },
    [send, mode]
  )

  const onCompositionStart = useCallback((): void => {
    composingRef.current = true
  }, [])

  const onCompositionUpdate = useCallback(
    (e: React.CompositionEvent<HTMLTextAreaElement>): void => {
      composingRef.current = true
      // Desktop mirrors the composition into the page (its field is where the
      // owner looks); the phone shows it in its own bar and sends only words.
      if (mode === 'desktop') send(composeMsg(e.data ?? ''))
      else setComposition(e.data ?? '')
    },
    [send, mode]
  )

  const onCompositionEnd = useCallback(
    (e: React.CompositionEvent<HTMLTextAreaElement>): void => {
      composingRef.current = false
      setComposition('')
      // The result replaces the composition in the page; none (Escape) clears
      // a desktop's mirrored one (the phone never sent one).
      const result = textMsg(e.data ?? '')
      if (result) send(result)
      else if (mode === 'desktop') send(composeMsg(''))
      settle(e.currentTarget)
    },
    [send, settle, mode]
  )

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
      e.preventDefault()
      e.stopPropagation()
      const msg = pasteMsg(e.clipboardData.getData('text/plain'))
      if (msg) send(msg)
    },
    [send]
  )

  const pageCopy = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>, key: 'c' | 'x'): void => {
      if (mode !== 'desktop') return
      e.preventDefault()
      e.stopPropagation()
      send(keyMsg(key, key === 'c' ? 'KeyC' : 'KeyX', MOD_META))
    },
    [send, mode]
  )
  const onCopy = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>): void => pageCopy(e, 'c'), [pageCopy])
  const onCut = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>): void => pageCopy(e, 'x'), [pageCopy])

  const onBlur = useCallback((): void => {
    if (composingRef.current) {
      composingRef.current = false
      if (mode === 'desktop') send(composeMsg(''))
    }
    setComposition('')
    setOpen(false)
    setAuto(false)
  }, [send, mode])

  return {
    open,
    auto,
    composition,
    raise,
    toggle,
    close,
    focusAt,
    endComposition,
    inputRef,
    onBeforeInput,
    onInput,
    onKeyDown,
    onCompositionStart,
    onCompositionUpdate,
    onCompositionEnd,
    onPaste,
    onCopy,
    onCut,
    onBlur
  }
}
