// RENAME BY HAND: THE FIELD (owner, 2026-11-04). A card's name, wherever it is
// drawn — the crew card, the floating card, the full view's head, the phone's
// bar, a note's title — becomes a field in place (name-edit.ts has the rules).
// The save is the main process's one rename path (api.renameNode ·
// main/agent-rename.ts): a clash is answered in the words `cookrew rename`
// uses, and the name is pinned so Sous never names over it.
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type { RenameOutcome } from '../../../shared/rename-plan'
import { cookrew } from '../api'
import { IDLE_EDIT, SAY_MS, SHOW_MS, clickOrDouble, nameEditKey, nameEditReducer, planCommit } from './name-edit'
import { onRenameRequest } from './rename-request'
import './name-edit.css'

/** A refusal, said where the name is. */
function NameAlert({ error }: { error: string }): React.JSX.Element {
  return (
    <span className="cr-name-error" role="alert">
      {error}
    </span>
  )
}

const stop = (e: { stopPropagation: () => void }): void => e.stopPropagation()

/**
 * The field itself. Its keys never reach the card around it (a name that is
 * also a button would open on Enter); its clicks and presses neither.
 */
export function NameField({
  label,
  draft,
  saving,
  error,
  composing,
  inputRef,
  onDraft,
  onCommit,
  onCancel
}: {
  /** The name it had, for the field's label. */
  label: string
  draft: string
  saving: boolean
  error: string | null
  /** Set while an IME composes (compositionstart → compositionend). */
  composing: { current: boolean }
  inputRef?: React.Ref<HTMLInputElement>
  onDraft: (text: string) => void
  onCommit: (how: 'enter' | 'blur') => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <>
      <input
        ref={inputRef}
        className="cr-name-input"
        value={draft}
        size={Math.max(6, Array.from(draft).length + 2)}
        autoFocus
        readOnly={saving}
        aria-label={`Rename ${label}`}
        aria-invalid={error ? true : undefined}
        enterKeyHint="done"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => onDraft(e.target.value)}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={() => {
          composing.current = false
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          const k = nameEditKey(e, composing.current)
          if (k === null) return
          e.preventDefault()
          if (k === 'commit') onCommit('enter')
          else onCancel()
        }}
        onBlur={() => onCommit('blur')}
        onClick={stop}
        onDoubleClick={stop}
        onPointerDown={stop}
        onMouseDown={stop}
      />
      {error && <NameAlert error={error} />}
    </>
  )
}

/** The one rename path; a build whose preload predates it says so rather than renaming another way. */
async function saveName(id: string, name: string): Promise<RenameOutcome> {
  try {
    const api = cookrew()
    if (typeof api.renameNode !== 'function') return { ok: false, error: 'Restart Cookrew to rename here: this build cannot yet.' }
    return await api.renameNode(id, name)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export interface NameEditOptions {
  /** The name's own press (it opens something): a click still does it, after the double-click window. */
  onPress?: () => void
  /** The phone's bar: one tap renames. */
  tap?: boolean
  /** Answers ⋯ → Rename for this card (rename-request.ts), when it is on screen. */
  menu?: boolean
}

export interface NameEdit {
  editing: boolean
  /** For the element that draws the name: its click (press or rename) and its hint. */
  hostProps: { onClick: (e: React.MouseEvent) => void; title: string }
  /** What goes inside that element: the name, or the field, and a refusal. */
  view: React.ReactNode
}

/** A card's name that renames in place. The element stays the caller's (the zoom painter binds it). */
export function useNameEdit(id: string, name: string, options: NameEditOptions = {}): NameEdit {
  const [state, dispatch] = useReducer(nameEditReducer, IDLE_EDIT)
  // Read synchronously by the handlers: a blur can land in the same tick as Enter or Esc.
  const phase = useRef<'idle' | 'editing' | 'saving'>('idle')
  // Which edit a save belongs to: one that answers after a reset is the last card's, and is dropped.
  const generation = useRef(0)
  const draft = useRef('')
  const composing = useRef(false)
  const marker = useRef<HTMLSpanElement | null>(null)
  const input = useRef<HTMLInputElement | null>(null)
  const latest = useRef({ name, options })
  latest.current = { name, options }

  const start = useCallback(() => {
    if (phase.current !== 'idle') return
    phase.current = 'editing'
    generation.current += 1
    draft.current = latest.current.name
    composing.current = false
    dispatch({ type: 'start', name: latest.current.name })
  }, [])
  const clicker = useMemo(
    () => clickOrDouble(() => ({ press: latest.current.options.onPress, rename: start, tap: latest.current.options.tap === true })),
    [start]
  )
  useEffect(() => () => clicker.cancel(), [clicker])

  // The same field drawn for another card (the head follows the stage's pick): start over.
  const shownId = useRef(id)
  useEffect(() => {
    if (shownId.current === id) return
    shownId.current = id
    generation.current += 1
    phase.current = 'idle'
    clicker.cancel()
    dispatch({ type: 'reset' })
  }, [id, clicker])

  // ⋯ → Rename: only a field on screen answers (the head and the bar are both mounted; CSS shows one).
  const menu = options.menu === true
  useEffect(() => {
    if (!menu) return
    return onRenameRequest(id, () => {
      if (marker.current && marker.current.getClientRects().length > 0) start()
    })
  }, [id, menu, start])

  const commit = useCallback(
    (how: 'enter' | 'blur') => {
      if (phase.current !== 'editing') return
      const plan = planCommit(draft.current, latest.current.name)
      if (plan.kind === 'close') {
        phase.current = 'idle'
        dispatch({ type: 'cancel' })
        return
      }
      const keepOpen = how === 'enter'
      if (plan.kind === 'refuse') {
        if (!keepOpen) phase.current = 'idle'
        dispatch({ type: 'refused', error: plan.error, keepOpen })
        return
      }
      phase.current = 'saving'
      dispatch({ type: 'saving' })
      const mine = generation.current
      void saveName(id, plan.name).then((outcome) => {
        if (generation.current !== mine || phase.current !== 'saving') return
        if (outcome.ok) {
          phase.current = 'idle'
          dispatch({ type: 'saved', name: outcome.name })
          return
        }
        phase.current = keepOpen ? 'editing' : 'idle'
        dispatch({ type: 'refused', error: outcome.error, keepOpen })
        // Back into the field only if focus has not gone somewhere else meanwhile.
        const now = document.activeElement
        if (keepOpen && (now === null || now === document.body || now === input.current)) input.current?.focus()
      })
    },
    [id]
  )
  const cancel = useCallback(() => {
    // Idle: nothing to cancel. Saving: the save is out and its answer closes the field.
    if (phase.current !== 'editing') return
    phase.current = 'idle'
    dispatch({ type: 'cancel' })
  }, [])
  const onDraft = useCallback((text: string) => {
    draft.current = text
    dispatch({ type: 'type', draft: text })
  }, [])

  // Opened: the whole name selected, so typing replaces it.
  useEffect(() => {
    if (state.editing) input.current?.select()
  }, [state.editing])
  // The saved name until the card wears it; a refusal on a closed field for a moment.
  useEffect(() => {
    if (state.shown !== null && name === state.shown) dispatch({ type: 'settled' })
  }, [name, state.shown])
  useEffect(() => {
    if (state.editing || (state.shown === null && state.error === null)) return
    const timer = setTimeout(() => dispatch({ type: 'settled' }), state.error !== null ? SAY_MS : SHOW_MS)
    return () => clearTimeout(timer)
  }, [state.editing, state.shown, state.error])

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      // The name handles its own click: the press waits out the double-click window.
      e.stopPropagation()
      if (phase.current !== 'idle') return
      clicker.click(e.detail)
    },
    [clicker]
  )
  const view = state.editing ? (
    <NameField
      label={name}
      draft={state.draft}
      saving={state.saving}
      error={state.error}
      composing={composing}
      inputRef={input}
      onDraft={onDraft}
      onCommit={commit}
      onCancel={cancel}
    />
  ) : (
    <>
      <span className="cr-name-text" ref={marker}>
        {state.shown ?? name}
      </span>
      {state.error && <NameAlert error={state.error} />}
    </>
  )
  return { editing: state.editing, hostProps: { onClick, title: options.tap ? 'Tap to rename' : 'Double-click to rename' }, view }
}

/** A name element that renames in place, for a caller with no element of its own to bind. */
export function NameHost({ id, name, tap = false, menu = false, className }: { id: string; name: string; tap?: boolean; menu?: boolean; className?: string }): React.JSX.Element {
  const edit = useNameEdit(id, name, { tap, menu })
  return (
    <b className={`cr-name-host${edit.editing ? ' editing' : ''}${className ? ` ${className}` : ''}`} {...edit.hostProps}>
      {edit.view}
    </b>
  )
}
