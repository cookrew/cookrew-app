import { useState } from 'react'
import { removeLines, type WorkspaceRemovePlan } from '../../shared/workspace-door'
import { useSheetEscape, wordsOf } from './workspace-sheet'

export interface WorkspaceRemoveSheetProps {
  /** Null while the Mac looks: nothing can be confirmed unseen. */
  plan: WorkspaceRemovePlan | null
  onConfirm: (options: { worktree: boolean }) => Promise<void>
  onCancel: () => void
}

/**
 * REMOVING A WORKSPACE SAYS WHAT IT DOES (box user test 2, bug 11). The whole
 * question used to be a button reading REMOVE? YES, with a running Shell behind
 * it and no undo. This names the agents it stops and what is left on disk, and
 * a fork's worktree and branch go only if asked, and only when clean.
 */
export function WorkspaceRemoveSheet({ plan, onConfirm, onCancel }: WorkspaceRemoveSheetProps): React.JSX.Element {
  const [worktree, setWorktree] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  useSheetEscape(onCancel)

  const confirm = (): void => {
    if (removing || !plan) return
    setRemoving(true)
    onConfirm({ worktree })
      .catch((error: unknown) => setRefused(wordsOf(error)))
      .finally(() => setRemoving(false))
  }

  const offer = plan?.forks.some((fork) => fork.removable) ?? false
  return (
    <div className="cr-ws-new" role="dialog" aria-label="Remove workspace">
      <div className="cr-ws-new-head">{plan ? `Remove "${plan.name}"?` : 'Remove workspace?'}</div>
      {plan ? (
        <ul className="cr-ws-lines">
          {removeLines(plan, false, worktree).map((line) => (
            <li key={line}>{line}</li>
          ))}
          <li>This cannot be undone.</li>
        </ul>
      ) : (
        <p className="cr-ws-say">Looking at what is in it…</p>
      )}
      {offer && (
        <label className="cr-ws-check">
          <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
          <span>Also remove the worktree and branch. They hold nothing that is not kept elsewhere.</span>
        </label>
      )}
      {refused && <p className="cr-ws-say refused" role="alert">{refused}</p>}
      <div className="cr-ws-new-foot">
        <button type="button" className="cr-ws-cancel" autoFocus onClick={onCancel}>
          CANCEL
        </button>
        <button type="button" className="cr-ws-create danger" disabled={!plan || removing} onClick={confirm}>
          REMOVE
        </button>
      </div>
    </div>
  )
}
