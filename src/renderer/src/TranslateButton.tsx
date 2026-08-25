// The translate control in the card header: one button, one language menu.

import { useEffect, useRef, useState } from 'react'
import { CrIcon } from './icons'
import { TRANSLATE_LANGUAGES } from '../../shared/translate'

export function TranslateButton({
  active,
  working,
  language,
  disabled,
  disabledReason,
  onPick,
  onClear,
  onMouseDown
}: {
  /** True when a translated body is currently on screen. */
  active: boolean
  working: boolean
  /** Code of the language being shown, for the tick. */
  language: string | null
  /** No checkpoint selected, or its text is not loaded yet. */
  disabled: boolean
  disabledReason: string
  onPick: (code: string) => void
  onClear: () => void
  onMouseDown?: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Close on an outside click or Escape. Capture phase, because the canvas pane
  // under this eats mousedown before it bubbles.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const title = working
    ? 'Translating this checkpoint…'
    : disabled
      ? disabledReason
      : active
        ? 'Showing a translation — pick another language, or show the original'
        : 'Translate this checkpoint'

  return (
    <div className="cr-translate" ref={wrapRef}>
      <button
        className={`cr-btn sm icon${active ? ' on' : ''}${working ? ' busy' : ''}`}
        aria-label={title}
        aria-expanded={open}
        title={title}
        disabled={disabled || working}
        onMouseDown={onMouseDown}
        onClick={() => setOpen((v) => !v)}
      >
        <CrIcon name="translate" />
      </button>
      {open && (
        <div className="cr-translate-menu" role="menu">
          {/* Leaving is a menu item, not a second button: "show me the original"
              is the same kind of choice as "show me Japanese", and it only
              exists once there is a translation to leave. */}
          {active && (
            <button
              className="cr-translate-item original"
              role="menuitem"
              onMouseDown={onMouseDown}
              onClick={() => {
                setOpen(false)
                onClear()
              }}
            >
              Show the original
            </button>
          )}
          {TRANSLATE_LANGUAGES.map((l) => (
            <button
              key={l.code}
              className={`cr-translate-item${l.code === language ? ' picked' : ''}`}
              role="menuitem"
              onMouseDown={onMouseDown}
              onClick={() => {
                setOpen(false)
                onPick(l.code)
              }}
            >
              <span className="cr-translate-name">{l.name}</span>
              <span className="cr-translate-label">{l.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
