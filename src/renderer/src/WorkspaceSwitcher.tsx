import { useEffect, useState } from 'react'
import type { WorkspaceList } from '../../shared/model'
import { cookrew } from './api'

interface WorkspaceSwitcherProps {
  fallbackName: string
  fallbackDir: string
  /** Opens the screen wall (WorkspaceWall.tsx) — the whole workspace surface. */
  onWall: () => void
}

/**
 * The workspace identity in the header: one chip, one door.
 *
 * It used to be two — the name opened the screen wall and a caret opened a
 * dropdown that was also where a workspace was made, given directories or
 * removed. Two doors to one place is one too many, and on a phone the caret
 * was a sliver nobody could hit. The wall does all of it now; the chip only
 * says which workspace this is and opens the wall on a tap.
 */
export function WorkspaceSwitcher({
  fallbackName,
  fallbackDir,
  onWall
}: WorkspaceSwitcherProps): React.JSX.Element {
  const [list, setList] = useState<WorkspaceList | null>(null)

  useEffect(() => {
    void cookrew().listWorkspaces().then(setList)
    return cookrew().onWorkspaceList(setList)
  }, [])

  const active = list?.workspaces.find((w) => w.id === list.activeId)
  const name = active?.name ?? fallbackName
  const icon = active?.icon ?? '🗂'
  const dir = active?.dir ?? fallbackDir

  return (
    <div className="cr-ws">
      <button
        type="button"
        className="cr-ws-current"
        onClick={onWall}
        title={`${dir} — switch, make or manage workspaces`}
        aria-label="Workspaces"
        aria-haspopup="dialog"
      >
        <span className="cr-ws-icon">{icon}</span>
        <span className="cr-kicker cr-ws-name">{name}</span>
      </button>
    </div>
  )
}
