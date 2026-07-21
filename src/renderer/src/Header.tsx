import { isDemoMode, isRemoteMode } from './api'
import { CrLogoMark } from './CrLogoMark'
import { CrIcon } from './icons'
import { StatusCoin } from './nodes/AgentAvatar'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'

interface HeaderProps {
  workspaceName: string
  dir: string
  terminalCount: number
  busyCount: number
  attentionCount: number
  /** Opens the team-fork picker overlay (fork / save the whole canvas). */
  onTeamFork: () => void
  /** Opens the global agent roster panel (all workspaces). */
  onRoster: () => void
  /** Opens the activity metrics / history panel. */
  onMetrics: () => void
}

/**
 * Cookrew-style top bar, one line: pixel logo + thin mode icons on the
 * left, agent LED count, and the workspace switcher pinned to the right.
 * The working directory lives in the switcher's dropdown, not the bar.
 */
export function Header({
  workspaceName,
  dir,
  terminalCount,
  busyCount,
  attentionCount,
  onTeamFork,
  onRoster,
  onMetrics
}: HeaderProps): React.JSX.Element {
  return (
    <header className="cr-header">
      <div className="cr-header-brand">
        <CrLogoMark />
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
      <div className="cr-header-status">
        {attentionCount > 0 && (
          <>
            <StatusCoin phase="waiting" />
            <span className="cr-kicker attention">{attentionCount} NEED YOU</span>
          </>
        )}
        <StatusCoin phase={busyCount > 0 ? 'thinking' : 'idle'} />
        <span className="cr-kicker">
          {busyCount}/{terminalCount} WORKING
        </span>
      </div>
      <button
        className="cr-btn sm icon"
        title="Activity & history"
        aria-label="Activity and history"
        onClick={onMetrics}
      >
        <CrIcon name="search" />
      </button>
      <button
        className="cr-btn sm icon"
        title="All agents (every workspace)"
        aria-label="All agents"
        onClick={onRoster}
      >
        <CrIcon name="agent" />
      </button>
      <button
        className="cr-btn sm icon"
        title="Fork or save this team"
        aria-label="Fork or save this team"
        onClick={onTeamFork}
      >
        <CrIcon name="fork" />
      </button>
      <WorkspaceSwitcher fallbackName={workspaceName} fallbackDir={dir} />
    </header>
  )
}
