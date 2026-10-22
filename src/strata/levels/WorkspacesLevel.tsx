// LEVEL 1 — one machine's workspaces: containers sized by crew (one seat size
// per machine), packed in order. The focused one reads "on screen"; the rest
// are background (agents running, browsers not). A machine that cannot answer
// shows why, with the one action that helps.
import { anchorOf, type LevelsWorkspace, type StrataMachine } from '../../shared/strata'
import { useLevels } from './env'
import { Figure, rectStyle } from './Figure'
import { lastSeenWords, machineState, stateWords, waitingCount } from './link'
import { Loupe } from './Loupe'
import type { LevelModel, SeatRef } from './model'
import { Avatar } from './Avatar'
import { Pins, waitingPins } from './Pins'
import { pathKey, samePath } from './selection'
import { MIN_TARGET, type ContainerCell } from './layout'
import { TrayCards } from './Tray'

const crewLine = (agents: number, waiting: number, unseated: number) =>
  [`${agents} agent${agents === 1 ? '' : 's'}`, waiting > 0 && `${waiting} waiting`, unseated > 0 && `${unseated} more with /`].filter(Boolean).join(' · ')

type Model = Extract<LevelModel, { level: 'workspaces' }>

export function WorkspacesLevel({ model, openFinder }: { model: Model; openFinder: (query?: string) => void }) {
  const env = useLevels()
  const machine = model.machine
  if (!machine) return <div className="level level-plate">This machine is not on your account any more.</div>
  if (!machine.levels) return <MachinePlate machine={machine} />
  const workspaces = machine.levels.workspaces
  const offline = machine.link !== 'live' && machine.link !== 'connecting'
  return (
    <div className="level level-workspaces" role="list" aria-label={`Workspaces on ${machine.name}`}>
      {machine.stale && <div className="banner" data-plane="screen">{`${stateWords(machine, env.now())} · read only`}</div>}
      {model.cells.map((cell, i) => (
        <WorkspaceItem
          key={cell.id}
          cell={cell}
          machine={machine}
          workspace={workspaces[i]}
          seats={model.seats.filter((s) => s.path.workspace === cell.id)}
          offline={offline}
          openFinder={openFinder}
        />
      ))}
      {workspaces.length === 0 && <div className="level-plate">No workspaces on {machine.name} yet.</div>}
    </div>
  )
}

function MachinePlate({ machine }: { machine: StrataMachine }) {
  const env = useLevels()
  const state = machineState(machine)
  const action =
    state === 'unpaired' ? { label: 'Pair this browser', href: machine.base } : state === 'outdated' ? { label: 'Open the classic view', href: machine.base } : null
  const why: Record<string, string> = {
    connecting: 'Connecting to this machine…',
    unpaired: 'This browser is not paired with this machine yet.',
    outdated: 'This machine runs an older Cookrew without levels. Update it, or open the classic view.',
    never: 'This machine has never connected. Open Cookrew on it once.',
    offline: `Offline${lastSeenWords(machine, env.now())}. Nothing from it is cached in this browser yet.`,
    error: 'This machine did not answer.'
  }
  return (
    <div className="level level-plate" role="status">
      <h2>{machine.name}</h2>
      <p>{why[state] ?? stateWords(machine, env.now())}</p>
      {action && (
        <a className="cta" href={action.href} target="_blank" rel="noreferrer">
          {action.label}
        </a>
      )}
    </div>
  )
}

function WorkspaceItem({
  cell,
  machine,
  workspace,
  seats,
  offline,
  openFinder
}: {
  cell: ContainerCell
  machine: StrataMachine
  workspace: LevelsWorkspace
  seats: SeatRef[]
  offline: boolean
  openFinder: (query?: string) => void
}) {
  const env = useLevels()
  const target = { machine: machine.id, workspace: workspace.id }
  const anchor = env.useAnchor(anchorOf(target))
  const highlighted = samePath(env.highlight, target)
  // A dive target only when DRAWN at ≥ MIN_TARGET for the input; smaller, a click goes to the container.
  const tiny = (seats[0]?.rect.w ?? Infinity) < (env.touch ? MIN_TARGET.touch : MIN_TARGET.pointer)
  const focused = workspace.state === 'focused'
  const hits = env.glow ? seats.filter((s) => env.glow?.has(s.key)).length : 0
  return (
    <div role="listitem" className={`workspace${machine.stale ? ' stale' : ''}`}>
      <button
        type="button"
        ref={anchor}
        className={`container-figure${highlighted ? ' hl' : ''}`}
        data-stage-focus={highlighted || undefined}
        style={rectStyle(cell.rect)}
        data-path={pathKey(target)}
        tabIndex={highlighted ? 0 : -1}
        aria-label={`${workspace.name}, ${focused ? 'on screen' : 'background'}, ${workspace.agents.length} agents, ${waitingCount(machine, workspace.id)} waiting`}
        onPointerEnter={() => env.setHighlight(target, 'pointer')}
        onClick={() => env.go(target)}
      >
        <Figure art={cell.art} />
      </button>
      {seats.map((seat) => (
        <Avatar key={seat.key} seat={seat} size="small" interactive={!tiny} offline={offline} />
      ))}
      {tiny && seats.length > 0 && <Loupe region={cell.rect} seats={seats} boxes={[cell]} onGoIn={() => env.go(target)} label={`Agents in ${workspace.name}`} />}
      {cell.tray && <TrayCards rect={cell.tray} items={workspace.loose} />}
      <div className={`container-label${highlighted ? ' on' : ''}`} data-plane="screen" style={{ left: cell.rect.x, top: cell.rect.y + cell.rect.h + 6, width: cell.rect.w }}>
        <span className="tag">
          {focused && <i className="tag-eye" title={`On ${machine.name}'s screen`} aria-hidden="true" />}
          <b>{workspace.name}</b>
          {hits > 0 && <span className="hits">{hits}</span>}
        </span>
        <span className="muted">{crewLine(workspace.agents.length, waitingCount(machine, workspace.id), workspace.agents.length - seats.length)}</span>
      </div>
      <Pins pins={waitingPins(machine, workspace.id)} strip={cell.pins} onMore={() => openFinder('')} />
    </div>
  )
}
