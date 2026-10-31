// THE ROUTE: the left of the header, device / workspace / agent.
//
// One line that says where you are: the desktop (the phone's dot says how it
// is reached), the workspace, and the agent whose terminal is open.
//
//   device    → only a name: this desktop. Its devices and workspaces
//               overview went with the levels code (2026-10-31).
//   workspace → the stage at the workspace: back to following what needs you.
//   agent     → nothing; it is where you are. Only its name — the card keeps
//               its own head and its own buttons.
import { useEffect, useState } from 'react'
import { cookrew, isRemoteMode } from './api'
import type { MainView } from './Header'
import { CrIcon } from './icons'
import { PathDot } from './PathBadge'
import type { PathBadgeView } from '../../shared/path-badge'
import { useActiveWorkspace } from './WorkspaceSwitcher'
import { stageSelect } from './stage/stage-select'

/** "drej-mbp.local" → "drej-mbp": the `.local` is mDNS plumbing, not a name. */
export function deviceLabel(name: string | null): string {
  return (name ?? 'This desktop').replace(/\.local$/i, '')
}

/** The workspace step is current when nothing is zoomed: the stage is at the workspace. */
export function routeAgent(view: MainView, zoomedAgent: string | null): string | null {
  return view === 'agents' ? null : zoomedAgent
}

/** This desktop's name, asked of main once (machine:name); the phone names its desktop from the path. */
function useMachineName(): string | null {
  const [name, setName] = useState<string | null>(null)
  useEffect(() => {
    const ask = cookrew().machineName
    if (!ask) return
    let live = true
    void ask()
      .then((answer) => live && setName(answer))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  return name
}

interface HeaderRouteProps {
  view: MainView
  workspaceName: string
  dir: string
  /** The phone's path, worn as a dot on the device step. */
  path: PathBadgeView
  /** The agent zoomed on the stage, if any. */
  zoomedAgent: string | null
  /** The stage's agent's workspace, when it is not the loaded one. */
  stageWorkspace?: string | null
  onViewChange: (view: MainView) => void
}

export function HeaderRoute({ view, workspaceName, dir, path, zoomedAgent, stageWorkspace = null, onViewChange }: HeaderRouteProps): React.JSX.Element {
  const active = useActiveWorkspace(workspaceName, dir)
  const workspace = stageWorkspace !== null && stageWorkspace !== active.name ? { name: stageWorkspace, icon: '🗂', dir: '' } : active
  const remote = isRemoteMode()
  const machine = useMachineName()
  const device = deviceLabel(remote ? path.desktopName : machine)
  const agent = routeAgent(view, zoomedAgent)

  const toWorkspace = (): void => {
    stageSelect.clear()
    onViewChange('stage')
  }

  return (
    <nav className="cr-route" aria-label="Route">
      <span className="cr-route-step cr-route-device">
        <span className="cr-route-here" title={device}>
          {remote && <PathDot view={path} />}
          <CrIcon name="device" />
          <span className="cr-route-label">{device}</span>
        </span>
      </span>
      <span className="cr-route-step cr-route-workspace">
        <span className="cr-route-sep" aria-hidden="true">
          /
        </span>
        <button
          type="button"
          className="cr-route-btn"
          title={`${workspace.dir ? `${workspace.dir} — ` : ''}back to the workspace`}
          aria-current={view === 'stage' && agent === null ? 'page' : undefined}
          onClick={toWorkspace}
        >
          <span className="cr-route-emoji">{workspace.icon}</span>
          <span className="cr-route-label">{workspace.name}</span>
        </button>
      </span>
      {agent !== null && (
        <span className="cr-route-step cr-route-agent">
          <span className="cr-route-sep" aria-hidden="true">
            /
          </span>
          <span className="cr-route-here" aria-current="page" title={agent}>
            <CrIcon name="agent" />
            <span className="cr-route-label">{agent}</span>
          </span>
        </span>
      )}
    </nav>
  )
}
