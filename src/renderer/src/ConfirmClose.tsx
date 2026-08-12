import { useEffect, useRef } from 'react'
import type { CanvasNode } from '../../shared/model'
import type { TurnPhase } from '../../shared/turn'
import { CrIcon } from './icons'
import { closePrompt } from './confirm-close'

/**
 * Confirmation for closing a card. One dialog for all three kinds, because
 * three near-identical prompts would drift apart; the copy that differs comes
 * from closePrompt (see there for why it names the cost instead of asking
 * "are you sure?").
 *
 * CANCEL takes focus, not the destructive button: the dialog appears because
 * of a click near other controls, so the safe option is the one a stray Enter
 * or Space should hit. Escape and a click on the scrim also cancel.
 */
export function ConfirmClose({
  node,
  activity,
  onCancel,
  onConfirm,
}: {
  node: CanvasNode
  activity?: { phase: TurnPhase } | null
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const prompt = closePrompt(node, activity)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onCancel])

  return (
    <div className="tf-scrim" onClick={onCancel}>
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
        <div className="confirm-close-actions">
          <button ref={cancelRef} className="cr-btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="cr-btn danger" onClick={onConfirm}>
            {prompt.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
