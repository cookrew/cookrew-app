// THE ROUTE: the left of the header, device / workspace / agent.
//
// One line that says where you are, in the order the levels nest: the desktop
// (the phone's dot says how it is reached), the workspace, and the agent whose
// terminal is open. Every view draws it — the canvas and the board name the
// canvas's workspace, the levels name their own path — and every step is a
// way out to its level:
//
//   device    → every device (the stage's devices level)
//   workspace → every workspace, as thumbnails (the stage's workspaces level)
//   agent     → nothing; it is where you are: the terminal zoomed on the
//               canvas, or open at the levels' last level. Only its name —
//               the card keeps its own head and its own buttons.
import { isRemoteMode } from './api'
import type { MainView } from './Header'
import { CrIcon } from './icons'
import { useLevelsRoute, WORKSPACES_PATH, type LevelsRouteState } from './levels/levels-history'
import { PathDot } from './PathBadge'
import type { PathBadgeView } from '../../shared/path-badge'
import type { StrataPath } from '../../shared/strata'
import { useActiveWorkspace, type ActiveWorkspace } from './WorkspaceSwitcher'
import { LOCAL_MACHINE_ID } from './levels/local-fleet'
import { stageLevel, useStageLevel, type StageLevel } from './stage/stage-select'

/**
 * The stage's levels said as a levels path, so the route draws them the way
 * it draws the levels: devices → this device's workspaces → one workspace →
 * one card.
 */
export function stageRouteState(input: {
  level: StageLevel
  machine: string | null
  workspace: { name: string; icon: string | null }
  zoomed: string | null
}): LevelsRouteState {
  const { level, machine, workspace, zoomed } = input
  const path: StrataPath =
    level === 'devices'
      ? {}
      : level === 'workspaces'
        ? { machine: LOCAL_MACHINE_ID }
        : zoomed !== null
          ? { machine: LOCAL_MACHINE_ID, workspace: 'loaded', agent: 'zoomed' }
          : { machine: LOCAL_MACHINE_ID, workspace: 'loaded' }
  return { path, names: { machine, workspace, agent: zoomed }, find: 0 }
}

export interface RouteStep {
  key: 'device' | 'workspace'
  label: string
  /** The workspace's icon; the device step draws the device glyph. */
  emoji: string | null
  title: string
  to: StrataPath
  current: boolean
}

/**
 * The steps before the agent's. In the levels they follow the levels' own
 * path; elsewhere they name this desktop and the canvas's workspace. Either
 * way the device step goes to the devices and the workspace step to the
 * workspace choice — never "into" the workspace, which is what the levels
 * themselves are for.
 */
export function routeSteps(input: {
  inLevels: boolean
  levels: LevelsRouteState
  canvasWorkspace: ActiveWorkspace
  device: string
}): RouteStep[] {
  const { inLevels, levels, canvasWorkspace, device } = input
  const atDevices = inLevels && !levels.path.machine
  const workspace = inLevels
    ? levels.path.workspace
      ? { name: levels.names.workspace?.name ?? '…', icon: levels.names.workspace?.icon ?? '🗂', dir: '' }
      : null
    : canvasWorkspace
  const deviceStep: RouteStep = {
    key: 'device',
    label: atDevices ? 'Devices' : device,
    emoji: null,
    title: atDevices ? 'All devices' : `${device} — all devices`,
    to: {},
    current: inLevels && !workspace
  }
  if (!workspace) return [deviceStep]
  return [
    deviceStep,
    {
      key: 'workspace',
      label: workspace.name,
      emoji: workspace.icon,
      title: `${workspace.dir ? `${workspace.dir} — ` : ''}choose a workspace`,
      to: WORKSPACES_PATH,
      current: inLevels && !levels.path.agent
    }
  ]
}

interface HeaderRouteProps {
  view: MainView
  workspaceName: string
  dir: string
  /** The phone's path, worn as a dot on the device step. */
  path: PathBadgeView
  /** The agent zoomed on the canvas (or on the stage), if any. */
  zoomedAgent: string | null
  /** The stage's agent's workspace: it can be any workspace, not the canvas's. */
  stageWorkspace?: string | null
  onViewChange: (view: MainView) => void
}

/** The route's last step: the open agent, by the view's own account of it. */
export function routeAgent(inLevels: boolean, levels: LevelsRouteState, zoomedAgent: string | null): string | null {
  if (!inLevels) return zoomedAgent
  return levels.path.agent ? (levels.names.agent ?? '…') : null
}

export function HeaderRoute({ view, workspaceName, dir, path, zoomedAgent, stageWorkspace = null, onViewChange }: HeaderRouteProps): React.JSX.Element {
  const levels = useLevelsRoute()
  const active = useActiveWorkspace(workspaceName, dir)
  const canvasWorkspace = stageWorkspace !== null && stageWorkspace !== active.name ? { name: stageWorkspace, icon: '🗂', dir: '' } : active
  const remote = isRemoteMode()
  // "drej-mbp.local" → "drej-mbp": the `.local` is mDNS plumbing, not a name.
  const device = (levels.names.machine ?? (remote ? path.desktopName : null) ?? 'This desktop').replace(/\.local$/i, '')
  const level = useStageLevel()
  // The stage reads its own levels; the deprecated views keep theirs.
  const route =
    view === 'stage'
      ? stageRouteState({ level, machine: device, workspace: { name: canvasWorkspace.name, icon: canvasWorkspace.icon }, zoomed: zoomedAgent })
      : levels
  const inLevels = view === 'levels' || view === 'stage'
  const steps = routeSteps({ inLevels, levels: route, canvasWorkspace, device })
  const agent = view === 'agents' ? null : routeAgent(inLevels, route, zoomedAgent)

  // Every step goes to the stage: the device to every device, the workspace
  // to every workspace — wherever you are, the same three places.
  const go = (step: RouteStep): void => {
    stageLevel.set(step.key === 'device' ? 'devices' : 'workspaces')
    onViewChange('stage')
  }

  return (
    <nav className="cr-route" aria-label="Route">
      {steps.map((step, i) => (
        <span key={step.key} className={`cr-route-step cr-route-${step.key}`}>
          {i > 0 && (
            <span className="cr-route-sep" aria-hidden="true">
              /
            </span>
          )}
          <button
            type="button"
            className="cr-route-btn"
            title={step.title}
            aria-current={step.current ? 'page' : undefined}
            onClick={() => go(step)}
          >
            {step.key === 'device' ? (
              <>
                {remote && <PathDot view={path} />}
                <CrIcon name="device" />
              </>
            ) : (
              <span className="cr-route-emoji">{step.emoji}</span>
            )}
            <span className="cr-route-label">{step.label}</span>
          </button>
        </span>
      ))}
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
