// The translate control in the card header: one button, one language menu.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  const btnRef = useRef<HTMLButtonElement>(null)
  /**
   * FIXED, not absolute, and placed from the button's rect.
   *
   * The card root is `overflow: hidden`, so an absolutely-positioned menu
   * inside the header is clipped by the card the moment it drops below the
   * header line — it opens, and nothing appears. .cr-cardmenu already solves
   * this the same way: position: fixed, coordinates measured from the anchor.
   */
  const [at, setAt] = useState<{ top: number; right: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const r = btnRef.current?.getBoundingClientRect()
      if (!r) return
      setAt({ top: Math.round(r.bottom + 6), right: Math.round(window.innerWidth - r.right) })
    }
    place()
    // A fixed menu does not travel with its anchor, so anything that moves the
    // anchor has to close or re-place it rather than leave it stranded.
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  // Close on an outside click or Escape. Capture phase, because the canvas pane
  // under this eats mousedown before it bubbles.
  useEffect(() => {
    if (!open) return
    const onDown = (e: Event): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    // pointerdown, not mousedown: on a phone a tap outside must close this, and
    // touch does not reliably deliver a mousedown to the document first.
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
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
        ref={btnRef}
        onMouseDown={onMouseDown}
        onClick={() => setOpen((v) => !v)}
      >
        <CrIcon name="translate" />
      </button>
      {open && at !== null && (
        <div className="cr-translate-menu" role="menu" style={{ top: at.top, right: at.right }}>
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
