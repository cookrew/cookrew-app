import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { keyboardInset } from './keyboard-inset'
import type { FieldMode } from './browser-stream'

/**
 * THE PHONE'S INPUT BOX FOR A PAGE IT ONLY SEES AS A PICTURE.
 *
 * While the phone keyboard is up for a browser card, this bar rides on top of
 * it: what the IME is composing (only the finished words go to the page —
 * useRemoteKeyboard), and the three things a picture cannot offer — paste
 * from this phone, copy what is selected on the page, and select all.
 *
 * Its buttons never take focus (pointerdown is cancelled), so the keyboard
 * stays up under them. Portaled to <body> and fixed above the keyboard: the
 * zoomed card sits in transformed layers, where `fixed` would not be the
 * screen's.
 */

const MODE_WORDS: Record<FieldMode, string> = {
  text: 'Typing into the page',
  numeric: 'A number for the page',
  decimal: 'A number for the page',
  tel: 'A phone number for the page',
  email: 'An email for the page',
  url: 'An address for the page',
  search: 'Searching the page',
  password: 'A password for the page'
}

function useKeyboardTop(): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const apply = (): void => setInset(keyboardInset(window.innerHeight, vv.height, vv.offsetTop))
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
    }
  }, [])
  return inset
}

const keep = (event: React.PointerEvent | React.MouseEvent): void => {
  // The key field keeps its focus, and with it the keyboard.
  event.preventDefault()
  event.stopPropagation()
}

export function RemoteKeyBar({
  composition,
  mode,
  note,
  onPaste,
  onCopy,
  onSelectAll,
  onHide
}: {
  composition: string
  mode: FieldMode
  note: string | null
  onPaste: () => void
  onCopy: () => void
  onSelectAll: () => void
  onHide: () => void
}): React.JSX.Element {
  const inset = useKeyboardTop()
  const button = (label: string, title: string, action: () => void): React.JSX.Element => (
    <button type="button" className="remote-keybar-btn" title={title} aria-label={title} onPointerDown={keep} onMouseDown={keep} onClick={action}>
      {label}
    </button>
  )
  return createPortal(
    <div className="remote-keybar" style={{ bottom: inset }} data-remote-keybar="open" onPointerDown={keep}>
      <span className={`remote-keybar-text${composition ? ' composing' : ''}`} aria-live="polite">
        {note ?? (composition || MODE_WORDS[mode])}
      </span>
      {button('Paste', 'Paste from this phone into the page', onPaste)}
      {button('Copy', 'Copy what is selected on the page', onCopy)}
      {button('All', 'Select all in the page’s field', onSelectAll)}
      {button('⌄', 'Hide the keyboard', onHide)}
    </div>,
    document.body
  )
}
