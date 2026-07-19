import { isDemoMode, isRemoteMode } from './api'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'

interface HeaderProps {
  workspaceName: string
  dir: string
  terminalCount: number
  busyCount: number
  attentionCount: number
}

/** Cookrew-style top bar: pixel logo, workspace id, agent LED count. */
export function Header({
  workspaceName,
  dir,
  terminalCount,
  busyCount,
  attentionCount
}: HeaderProps): React.JSX.Element {
  return (
    <header className="cr-header">
      <div className="cr-header-brand">
        <span className="cr-logo">COOKREW</span>
        <span className="cr-chip amber">CANVAS</span>
        {isDemoMode() && <span className="cr-chip violet">DEMO</span>}
        {isRemoteMode() && <span className="cr-chip violet">MOBILE</span>}
      </div>
      <div className="cr-header-meta">
        <WorkspaceSwitcher fallbackName={workspaceName} fallbackDir={dir} />
      </div>
      <div className="cr-header-status">
        {attentionCount > 0 && (
          <>
            <span className="cr-led red" />
            <span className="cr-kicker attention">{attentionCount} NEED YOU</span>
          </>
        )}
        <span className={`cr-led ${busyCount > 0 ? 'busy' : 'on'}`} />
        <span className="cr-kicker">
          {busyCount}/{terminalCount} WORKING
        </span>
      </div>
    </header>
  )
}
