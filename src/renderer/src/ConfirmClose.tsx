import { useEffect, useRef, useState } from 'react'
import type { CanvasNode } from '../../shared/model'
import { secretSlotsOf } from '../../shared/secret-slot'
import type { TurnPhase } from '../../shared/turn'
import { cookrew } from './api'
import { CrIcon } from './icons'
import { closeLabel, closePrompt, noteSecrets, removeSecrets, type NoteSecrets } from './confirm-close'

/**
 * Confirmation for closing a card. One dialog for all three kinds, because
 * three near-identical prompts would drift apart; the copy that differs comes
 * from closePrompt (see there for why it names the cost instead of asking
 * "are you sure?").
 *
 * CANCEL takes focus, not the destructive button: the dialog appears because
 * of a click near other controls, so the safe option is the one a stray Enter
 * or Space should hit. Escape and a click on the scrim also cancel.
 *
 * A note holding sealed secrets also offers to take their values (owner,
 * 2026-11-05; confirm-close.ts · noteSecrets). The box starts unticked, so the
 * dialog does exactly what it did before unless the owner asks for more.
 */
export function ConfirmClose({
  node,
  activity,
  nodes = [],
  onCancel,
  onConfirm,
}: {
  node: CanvasNode
  activity?: { phase: TurnPhase } | null
  /** The canvas's cards: a value another note still has a slot for is held back. */
  nodes?: readonly CanvasNode[]
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const prompt = closePrompt(node, activity)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [sealed, setSealed] = useState<readonly string[]>([])
  const [ticked, setTicked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Names and dates only: no value reaches this page. A bridge that refuses
  // the listing (the read-only wall) offers nothing, and the values stay.
  const slotted = node.kind === 'note' && secretSlotsOf(node.content).length > 0
  useEffect(() => {
    const api = cookrew()
    if (!slotted || !api.secretList) return
    let live = true
    void api
      .secretList()
      .then((rows) => {
        if (live) setSealed(rows.map((row) => row.name))
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [slotted])

  const plan = noteSecrets(node, sealed, nodes)
  const taking = ticked ? plan.remove : []
  const confirm = async (): Promise<void> => {
    if (busy) return
    if (taking.length === 0) return onConfirm()
    const remove = cookrew().secretRemove
    if (!remove) return setError('This build cannot delete a secret.')
    setBusy(true)
    setError(null)
    const done = await removeSecrets(taking, remove)
    setBusy(false)
    if (done.ok) onConfirm()
    else setError(done.error)
  }
  // Halfway through the values there is no clean way back: the dialog holds.
  const cancel = (): void => {
    if (!busy) onCancel()
  }

  // Again after a failure: the pressed button was disabled while it worked, and focus fell out of the dialog.
  useEffect(() => {
    cancelRef.current?.focus()
  }, [error])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (!busy) onCancel()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onCancel, busy])

  return (
    <div className="tf-scrim" onClick={cancel}>
      <div
        className={`tf-panel confirm-close${prompt.danger ? ' danger' : ''}`}
        role="alertdialog"
        aria-modal="true"
        aria-label={prompt.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tf-head">
          <CrIcon name="close" />
          <span className="tf-title">{prompt.title}</span>
        </div>
        <div className="confirm-close-subject">{prompt.subject}</div>
        <div className="confirm-close-note">{prompt.consequence}</div>
        <SecretCloseChoice plan={plan} ticked={ticked} busy={busy} onTick={setTicked} />
        {error !== null && (
          <div className="confirm-close-note confirm-close-error" role="alert">
            {error}. The note was kept.
          </div>
        )}
        <div className="confirm-close-actions">
          <button ref={cancelRef} className="cr-btn" disabled={busy} onClick={cancel}>
            Cancel
          </button>
          <button className="cr-btn danger" disabled={busy} onClick={() => void confirm()}>
            {closeLabel(prompt.confirmLabel, taking.length)}
          </button>
        </div>
      </div>
    </div>
  )
}

/** The choice about a note's sealed values, and the ones held back for another note. */
export function SecretCloseChoice({
  plan,
  ticked,
  busy,
  onTick
}: {
  plan: NoteSecrets
  ticked: boolean
  busy: boolean
  onTick: (ticked: boolean) => void
}): React.JSX.Element | null {
  if (plan.remove.length === 0 && plan.shared.length === 0) return null
  const one = plan.remove.length === 1
  return (
    <div className="confirm-close-secrets">
      {plan.remove.length > 0 && (
        <label className="confirm-close-secret">
          <input type="checkbox" checked={ticked} disabled={busy} onChange={(e) => onTick(e.target.checked)} />
          <span>
            Also delete the sealed {one ? 'value' : 'values'}: <b>{plan.remove.join(', ')}</b>
            <small>
              {ticked
                ? `Agents can no longer read ${one ? 'it' : 'them'}. This cannot be undone.`
                : `Left unticked, ${one ? 'it stays' : 'they stay'} in the store and agents can still read ${one ? 'it' : 'them'}.`}
            </small>
          </span>
        </label>
      )}
      {plan.shared.map(({ name, by }) => (
        <div key={name} className="confirm-close-kept">
          <b>{name}</b> stays: {by} still has its slot.
        </div>
      ))}
    </div>
  )
}
