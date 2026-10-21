// LEVEL 0 — every machine of the account, drawn from its hardware, each
// holding its workspaces in miniature in its portal (the L1 layout mapped
// uniformly, so the zoom in lands exactly). Pins dive from here; the loupe
// picks agents whose dots are far smaller than a hit target.
import type { StrataMachine } from '../../shared/strata'
import { useLevels } from './env'
import { Figure, rectStyle } from './Figure'
import { agentCount, isDimmed, machineState, stateWords, waitingCount } from './link'
import { Loupe } from './Loupe'
import type { LevelModel, Miniature } from './model'
import { Avatar } from './Avatar'
import { Pins, waitingPins } from './Pins'
import { pathKey, samePath } from './selection'
import type { MachineCell } from './layout'
import { MIN_TARGET } from './layout'

type Model = Extract<LevelModel, { level: 'machines' }>

export function MachinesLevel({ model, openFinder }: { model: Model; openFinder: (query?: string) => void }) {
  const env = useLevels()
  if (env.fleet.length === 0) return <EmptyAccount />
  return (
    <div className="level level-machines" role="list" aria-label="Your machines">
      {model.cells.map((cell, i) => (
        <MachineItem key={cell.id} cell={cell} machine={env.fleet[i]} mini={model.minis.get(cell.id) ?? null} openFinder={openFinder} />
      ))}
    </div>
  )
}

function EmptyAccount() {
  return (
    <div className="level level-empty">
      <div className="empty-ghost" aria-hidden="true" />
      <h2>No machines yet</h2>
      <p>Open Cookrew on a computer and sign in as you. It appears here within seconds.</p>
      <a className="cta" href="https://cookrew.dev/download">
        Download Cookrew
      </a>
    </div>
  )
}

function PortalPlate({ machine }: { machine: StrataMachine }) {
  const state = machineState(machine)
  if (state === 'connecting' && !machine.levels) return <div className="plate">connecting…</div>
  if (state === 'unpaired')
    return (
      <div className="plate">
        <span>🔒 Pair this browser</span>
        <a className="plate-btn" href={machine.base} target="_blank" rel="noreferrer">
          Pair
        </a>
      </div>
    )
  if (state === 'outdated')
    return (
      <div className="plate">
        <span>Update Cookrew for levels</span>
        <a className="plate-btn" href={machine.base} target="_blank" rel="noreferrer">
          OPEN
        </a>
      </div>
    )
  if (state === 'never') return <div className="plate">never connected</div>
  if (!machine.levels) return <div className="plate">offline</div>
  return null
}

function MachineItem({ cell, machine, mini, openFinder }: { cell: MachineCell; machine: StrataMachine; mini: Miniature | null; openFinder: (query?: string) => void }) {
  const env = useLevels()
  const target = { machine: machine.id }
  const highlighted = samePath(env.highlight, target)
  const state = machineState(machine)
  const offline = state !== 'live' && state !== 'connecting'
  const hits = env.glow ? (mini?.seats.filter((s) => env.glow?.has(s.key)).length ?? 0) : 0
  const tiny = (mini?.seats[0]?.hit.w ?? Infinity) < (env.touch ? MIN_TARGET.touch : MIN_TARGET.pointer)
  const label = `${machine.name}, ${machine.profile?.label ?? machine.profile?.kind ?? 'unknown machine'}, ${stateWords(machine, env.now())}, ${machine.levels?.workspaces.length ?? 0} workspaces, ${agentCount(machine)} agents, ${waitingCount(machine)} waiting`
  return (
    <div role="listitem" className={`machine state-${state}${isDimmed(machine) ? ' dimmed' : ''}`}>
      <button
        type="button"
        ref={env.useAnchor(`machine:${machine.id}`)}
        className={`machine-figure${highlighted ? ' hl' : ''}`}
        style={rectStyle(cell.rect)}
        data-path={pathKey(target)}
        tabIndex={highlighted ? 0 : -1}
        aria-label={label}
        onPointerEnter={() => env.setHighlight(target, 'pointer')}
        onClick={() => env.go(target)}
      >
        <Figure art={cell.art} />
      </button>
      <div className="portal" ref={env.useAnchor(`portal:${machine.id}`)} style={rectStyle(cell.portal)}>
        <PortalPlate machine={machine} />
      </div>
      {mini && (
        <div className={`mini${machine.stale ? ' stale' : ''}`} aria-hidden="true">
          {mini.cells.map((c) => (
            <Figure key={c.id} art={c.art} rect={c.rect} className="mini-box" />
          ))}
        </div>
      )}
      {mini?.seats.map((seat) => <Avatar key={seat.key} seat={seat} size="dot" interactive={false} offline={offline} />)}
      {mini && tiny && <Loupe region={cell.portal} seats={mini.seats} boxes={mini.cells} onGoIn={() => env.go(target)} label={`Agents on ${machine.name}`} />}
      <div className="machine-label" style={rectStyle(cell.label)}>
        <b>{machine.name}</b>
        <span className="muted">{stateWords(machine, env.now())}</span>
        {hits > 0 && <span className="hits">{hits}</span>}
      </div>
      <Pins pins={waitingPins(machine)} strip={cell.pins} onMore={() => openFinder('')} />
    </div>
  )
}
