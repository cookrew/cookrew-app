// THE ROUTE: the left of the header, device / workspace / agent.
//
// One line that says where you are: the desktop (the phone's dot says how it
// is reached), the workspace, and the agent whose terminal is open.
//
//   device    → the way out: the workspaces of this Mac (zoom −1), and again
//               every device (−2). See zoom/.
//   workspace → the stage at the workspace, at its crew (zoom 1).
//   agent     → nothing; it is where you are. Only its name — the card keeps
//               its own head and its own buttons.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { cookrew, isRemoteMode } from './api'
import type { MainView } from './Header'
import { CrIcon } from './icons'
import { PathDot } from './PathBadge'
import type { PathBadgeView } from '../../shared/path-badge'
import { useActiveWorkspace } from './WorkspaceSwitcher'
import { stageSelect } from './stage/stage-select'
import { useZoomFull, zoomStore } from './zoom/zoom-store'
import { placeWords } from './zoom/full-return'
import { setFullRouteSlot } from './route-slot'
import { remotePlace, type RemotePlace } from './zoom/remote-machine-store'
import { reportGuestRoute } from './guest/guest-bridge'

/** "drej-mbp.local" → "drej-mbp": the `.local` is mDNS plumbing, not a name. */
export function deviceLabel(name: string | null): string {
  return (name ?? 'This desktop').replace(/\.local$/i, '')
}

/**
 * The workspace step is current when nothing is zoomed: the stage is at the
 * workspace. The stage is the only view now (the board drops under the bar
 * instead of replacing the stage), so the agent step follows the zoom alone.
 */
export function routeAgent(_view: MainView, zoomedAgent: string | null): string | null {
  return zoomedAgent
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

export interface RemoteRoute {
  readonly device: string
  readonly workspace: string | null
  readonly agent: string | null
}

/**
 * INSIDE ANOTHER MACHINE THE TITLE IS ITS (owner 2026-11-12): that machine where
 * this one's name was, then its workspace and agent as the machine's own app
 * names them (zoom/MachineGuestView.tsx: the guest says, and draws no title line
 * of its own); null outside every machine.
 */
export function remoteRoute(place: RemotePlace): RemoteRoute | null {
  if (!place.machine) return null
  return { device: place.machine.name, workspace: place.crumbs?.workspace ?? null, agent: place.crumbs?.agent ?? null }
}

const readPlace = (): RemotePlace => remotePlace.get()
/** Where the phone bar's ‹ goes from a full view (zoom-store.ts · back), in the bar's words. */
const backTitleNow = (): string => {
  const to = zoomStore.get().full !== null ? zoomStore.backTarget() : null
  return `Back to ${to ? placeWords(to, () => null) : 'agents'}`
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
  const full = useZoomFull()
  const agent = full === 'agent' ? routeAgent(view, zoomedAgent) : null
  const inside = remoteRoute(useSyncExternalStore(remotePlace.subscribe, readPlace, readPlace))

  const toWorkspace = (): void => {
    stageSelect.clear()
    zoomStore.go(1, 'agents')
    onViewChange('stage')
  }
  const toDevice = (): void => {
    zoomStore.go(zoomStore.get().v <= -1 ? -2 : -1, zoomStore.get().dir)
  }
  // The full view's way out, the round ‹'s own step (ZoomView · stepBack): where it was opened from.
  const back = (): void => {
    zoomStore.back('route')
  }
  // The agent's own name is beside it on this bar: a full view is named by its kind here.
  const backTitle = useSyncExternalStore(zoomStore.subscribe, backTitleNow, backTitleNow)
  // A guest machine's line is drawn by the window holding it: what this one would say is said to it
  // (guest/guest-bridge.ts). Nothing anywhere else.
  useEffect(() => reportGuestRoute(workspace.name, agent), [workspace.name, agent])

  if (inside) {
    // Its steps are the guest's own (guest/GuestMachine.tsx · runGuestCommand), in its colour.
    return (
      <nav className="cr-route cr-route-remote" aria-label="Route">
        <span className="cr-route-step cr-route-device">
          <button type="button" className="cr-route-here" title={`${inside.device}: its workspaces, and again every device`} onClick={() => remotePlace.command({ kind: 'device' })}>
            {remote && <PathDot view={path} />}
            <CrIcon name="device" />
            <span className="cr-route-label">{inside.device}</span>
          </button>
        </span>
        {inside.workspace !== null && (
          <span className="cr-route-step cr-route-workspace">
            <span className="cr-route-sep" aria-hidden="true">/</span>
            <button type="button" className="cr-route-btn" title="back to the workspace" aria-current={inside.agent === null ? 'page' : undefined} onClick={() => remotePlace.command({ kind: 'workspace' })}>
              <span className="cr-route-emoji">🗂</span>
              <span className="cr-route-label">{inside.workspace}</span>
            </button>
          </span>
        )}
        {inside.agent !== null && (
          <span className="cr-route-step cr-route-agent">
            <span className="cr-route-sep" aria-hidden="true">/</span>
            <span className="cr-route-here" aria-current="page" title={inside.agent}>
              <CrIcon name="agent" />
              <span className="cr-route-label">{inside.agent}</span>
            </span>
          </span>
        )}
      </nav>
    )
  }

  return (
    <nav className={`cr-route${agent !== null ? ' has-full' : ''}`} aria-label="Route">
      {/* AN AGENT'S FULL VIEW ON A PHONE (owner, 2026-11-02): the bar is
          "‹ face name · state" — the device and workspace steps fold into ‹,
          and the full view draws who it is into the slot (route-slot.ts).
          CSS shows these two at phone width only. */}
      {agent !== null && (
        <>
          <button type="button" className="cr-route-back" aria-label={backTitle} title={backTitle} onClick={back}>
            ‹
          </button>
          <span className="cr-route-full" ref={setFullRouteSlot} />
        </>
      )}
      <span className="cr-route-step cr-route-device">
        <button type="button" className="cr-route-here" title={device} onClick={toDevice}>
          {remote && <PathDot view={path} />}
          <CrIcon name="device" />
          <span className="cr-route-label">{device}</span>
        </button>
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
