import { isDemoMode, isRemoteMode } from './api'
import { CrLogoMark } from './CrLogoMark'
import { CrIcon } from './icons'
import { StatusCoin } from './nodes/AgentAvatar'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'

/** The two things the stage can be showing. */
export type MainView = 'canvas' | 'agents'

interface HeaderProps {
  workspaceName: string
  dir: string
  terminalCount: number
  busyCount: number
  attentionCount: number
  /** Which view the stage is showing — drives the pressed state of the switch. */
  view: MainView
  onViewChange: (view: MainView) => void
  /** Opens the activity metrics / history panel (workspace popout item). */
  onActivity: () => void
  /** Re-pull the canvas and re-establish the push channel (the brand mark). */
  onResync: () => void
}

/**
 * The brand mark doubles as REFRESH. A phone whose link to the desktop went
 * quiet has no way to say so — the canvas simply stops changing, or comes back
 * from a reload empty — and reaching a browser's reload from a home-screen web
 * app is awkward. The mark is the one control always on screen, so tapping it
 * asks for everything again. Styled inline rather than through the stylesheet:
 * it must look EXACTLY like the plain mark it replaces, with no button chrome.
 */
const RESYNC_BUTTON: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  margin: 0,
  font: 'inherit',
  color: 'inherit',
  lineHeight: 0,
  cursor: 'pointer'
}

/**
 * Cookrew-style top bar, one line.
 *
 * The row is ordered by how often it is used, not by what exists: brand, the
 * CANVAS ⇄ AGENTS switch, live status, then the workspace. The inline tool
 * group that used to sit before the workspace (activity + fork) is gone:
 * saving/duplicating the team lives on the dock — you save the canvas FROM
 * the canvas — and activity is an option inside the workspace popout, since
 * history is a property of the workspace, not a top-level destination.
 *
 * ATTENTION LIVES ON THE SWITCH. It used to be a second coin plus "N NEED YOU"
 * in the status block — a passive label next to the button you would then have
 * to find. As a badge on AGENTS it says the same thing in less room and is
 * itself the way to go and look.
 */
export function Header({
  workspaceName,
  dir,
  terminalCount,
  busyCount,
  attentionCount,
  view,
  onViewChange,
  onActivity,
  onResync
}: HeaderProps): React.JSX.Element {
  return (
    <header className="cr-header">
      <div className="cr-header-brand">
        <button
          type="button"
          style={RESYNC_BUTTON}
          title="Refresh — pull the canvas from the desktop again"
          aria-label="Refresh the canvas"
          onClick={onResync}
        >
          <CrLogoMark />
        </button>
        <span className="cr-logo">COOKREW</span>
        {isDemoMode() && (
          <span className="cr-chip violet icon" title="Demo data">
            <CrIcon name="demo" />
          </span>
        )}
        {isRemoteMode() && (
          <span className="cr-mode-icon" title="Mobile companion">
            <CrIcon name="mobile" />
          </span>
        )}
      </div>

      <div className="cr-viewseg" role="group" aria-label="View">
        <button
          type="button"
          aria-pressed={view === 'canvas'}
          title="The canvas"
          onClick={() => onViewChange('canvas')}
        >
          <CrIcon name="canvas" />
          <span className="cr-viewseg-label">Canvas</span>
        </button>
        <button
          type="button"
          className={attentionCount > 0 ? 'attention' : undefined}
          aria-pressed={view === 'agents'}
          title={
            attentionCount > 0
              ? `The board — ${attentionCount} need you`
              : 'The board (agents + elements, every workspace)'
          }
          onClick={() => onViewChange('agents')}
        >
          <CrIcon name="agent" />
          <span className="cr-viewseg-label">Board</span>
          {attentionCount > 0 && <span className="cr-viewseg-badge">{attentionCount}</span>}
        </button>
      </div>

      <div className="cr-header-status">
        <StatusCoin phase={busyCount > 0 ? 'thinking' : 'idle'} />
        <span className="cr-kicker">
          {busyCount}/{terminalCount}
          <span className="cr-kicker-word"> WORKING</span>
        </span>
      </div>

      <WorkspaceSwitcher fallbackName={workspaceName} fallbackDir={dir} onActivity={onActivity} />
    </header>
  )
}
