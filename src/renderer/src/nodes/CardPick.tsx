import { CrIcon } from '../icons'
import { useCanvasUi } from '../canvas-ui'

/**
 * The clipboard checkbox, top-right on every card. Rendered only while the
 * clipboard toggle is on; a WORKING agent's box is disabled — a busy
 * session cannot be cloned mid-turn, and the disabled box says so before
 * the backend has to. Pointer events stop here so a tap can never fall
 * through to the card's own click (which would zoom on the resting hand).
 */
export function CardPick({ id }: { id: string }): React.JSX.Element | null {
  const { clipping, picked, togglePick, activities } = useCanvasUi()
  if (!clipping) return null
  const activity = activities[id]
  const working = activity?.phase === 'thinking'
  const shell = activity !== undefined && !activity.agent
  const on = picked.has(id)
  // Working blocks ADDING only. A picked card must always be unpickable —
  // otherwise a selection containing an agent that started a turn can
  // never satisfy the copy guard and deadlocks.
  const blocked = working && !on
  return (
    <button
      className={`card-pick nodrag${on ? ' on' : ''}`}
      role="checkbox"
      aria-checked={on}
      disabled={blocked}
      title={
        blocked
          ? 'Working — wait for the turn to finish'
          : on
            ? 'Deselect'
            : shell
              ? 'Select — a copy re-runs this shell fresh; mind running programs'
              : 'Select'
      }
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        togglePick(id)
      }}
    >
      {on && <CrIcon name="check" />}
    </button>
  )
}
