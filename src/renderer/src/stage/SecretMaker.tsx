// 🔒+ ON THE AGENT'S SHEET (owner, 2026-11-05): a note made as a secret. It
// asks for the name alone, because the name is what the note keeps and what
// agents type; the value is then given to the slot's own field in the note
// (nodes/SecretSlot.tsx), the one way a value reaches the store. Nothing here
// holds a value, so nothing here can leak one.

import { useEffect, useRef, useState } from 'react'
import { secretNameFrom } from '../../../shared/secret-slot'
import { CrIcon } from '../icons'

export function SecretMaker({
  agentName,
  busy,
  onMake
}: {
  agentName: string
  busy: boolean
  /** Makes the note; false leaves the box open, for the name to be fixed. */
  onMake: (name: string) => Promise<boolean>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [raw, setRaw] = useState('')
  const root = useRef<HTMLSpanElement>(null)
  const name = secretNameFrom(raw)
  const close = (): void => {
    setOpen(false)
    setRaw('')
  }
  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent): void => {
      if (!root.current?.contains(e.target as Node)) close()
    }
    // Capture: the stage swallows pointerdown before it bubbles.
    document.addEventListener('pointerdown', onPointer, true)
    return () => document.removeEventListener('pointerdown', onPointer, true)
  }, [open])

  const submit = async (): Promise<void> => {
    if (name === null || busy) return
    if (await onMake(raw)) close()
  }

  return (
    <span className="zv-fv-arts-secret" ref={root}>
      <button
        type="button"
        className="zv-fv-arts-btn"
        title={`New secret for ${agentName} — the value is sealed, the note keeps only its name`}
        aria-label={`New secret for ${agentName}`}
        aria-expanded={open}
        disabled={busy}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <CrIcon name="lock" />
        <b aria-hidden="true">+</b>
      </button>
      {open && (
        <form
          className="zv-fv-arts-secret-box"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <input
            type="text"
            aria-label="The secret's name"
            placeholder="secret name"
            autoFocus
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={(e) => {
              // Keys typed here are this box's, not the terminal's or the zoom's.
              e.stopPropagation()
              if (e.key === 'Escape') close()
            }}
          />
          <button type="submit" className="cr-btn sm" disabled={name === null || busy}>
            MAKE
          </button>
          <small>{raw.trim() === '' ? 'the value goes in next, sealed' : name === null ? 'letters, digits and dashes' : `agents read it as ${name}`}</small>
        </form>
      )}
    </span>
  )
}
