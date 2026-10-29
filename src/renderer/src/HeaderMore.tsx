// THE MORE MENU: everything on the bar that is not a way to move or a button
// of the open terminal — how many agents are working, the path, routing, the
// workspace wall, the finder, a refresh — behind one ⋯ at the end of the
// function bar. Each row opens its own sheet or panel, as its chip did.
//
// A row closes the menu from the menu's own React onClick, which runs after
// the row's: closing from a native listener instead unmounts the menu before
// React sees a trusted click, and the row would never act.
import { useCallback, useEffect, useRef, useState } from 'react'
import { CrIcon } from './icons'
import { StatusCoin } from './nodes/AgentAvatar'
import { PathBadge } from './PathBadge'
import { RoutingEntry } from './routing/RoutingPanel'
import type { RouteStatus } from '../../shared/route'
import type { PathBadgeView } from '../../shared/path-badge'

interface HeaderMoreProps {
  busyCount: number
  terminalCount: number
  /** The phone's path: a Connection row that refreshes and opens its sheet. */
  connection: PathBadgeView | null
  onConnection: () => void
  onRouting?: () => void
  routeStatus: RouteStatus | null
  onWall: () => void
  /** Present in the levels view: the shell's finder. */
  onFind?: () => void
  onResync: () => void
  demo: boolean
}

export function HeaderMore({
  busyCount,
  terminalCount,
  connection,
  onConnection,
  onRouting,
  routeStatus,
  onWall,
  onFind,
  onResync,
  demo
}: HeaderMoreProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent): void => {
      if (!root.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // The menu's Esc, not the canvas's zoom-back.
        e.stopPropagation()
        close()
        return
      }
      // Keys pressed in the menu stay there: `/` and the arrows must not reach
      // the levels behind it. A button's Enter and Space still press it.
      if (root.current?.contains(e.target as Node)) e.stopPropagation()
    }
    // Tab out of the menu closes it, like a click outside.
    const onFocusOut = (e: FocusEvent): void => {
      const next = e.relatedTarget as Node | null
      if (next !== null && !root.current?.contains(next)) close()
    }
    // Capture: the canvas pane swallows mousedown before it bubbles.
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    root.current?.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
      root.current?.removeEventListener('focusout', onFocusOut)
    }
  }, [open, close])

  return (
    <div className="cr-more" ref={root}>
      <button
        type="button"
        className={`cr-more-btn${open ? ' on' : ''}${busyCount > 0 ? ' busy' : ''}`}
        aria-label="More"
        aria-expanded={open}
        aria-controls="cr-more-menu"
        title="More"
        onClick={() => setOpen((now) => !now)}
      >
        <CrIcon name="more" />
      </button>
      {open && (
        <div
          className="cr-more-menu"
          id="cr-more-menu"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('button, a')) close()
          }}
        >
          <div className="cr-more-status" role="presentation">
            <StatusCoin phase={busyCount > 0 ? 'thinking' : 'idle'} />
            <span className="cr-kicker">
              {busyCount}/{terminalCount} working
            </span>
            {demo && (
              <span className="cr-chip violet icon" title="Demo data">
                <CrIcon name="demo" />
              </span>
            )}
          </div>
          {connection && (
            <button type="button" className="cr-more-item" onClick={onConnection}>
              <PathBadge view={connection} />
              <span className="cr-more-label">Connection</span>
            </button>
          )}
          {onRouting && (
            <div className="cr-more-row" role="presentation">
              <RoutingEntry status={routeStatus} onOpen={onRouting} />
            </div>
          )}
          <button type="button" className="cr-more-item" onClick={onWall} aria-haspopup="dialog">
            <CrIcon name="canvas" />
            <span className="cr-more-label">Workspaces…</span>
          </button>
          {onFind && (
            <button type="button" className="cr-more-item" onClick={onFind}>
              <CrIcon name="search" />
              <span className="cr-more-label">Find an agent</span>
              <kbd>/</kbd>
            </button>
          )}
          <button type="button" className="cr-more-item" onClick={onResync}>
            <CrIcon name="expand" />
            <span className="cr-more-label">Refresh</span>
          </button>
        </div>
      )}
    </div>
  )
}
