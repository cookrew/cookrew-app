// LEVEL 2 — one workspace: its agents seated evenly in creation order (never
// re-sorted; attention is a pin), each with its notes and browsers tucked
// behind and fanned on hover. Loose items sit in the container's tray.
import { useState } from 'react'
import { anchorOf, type LevelsAttachment } from '../../shared/strata'
import { Avatar } from './Avatar'
import { useLevels } from './env'
import { Fan } from './Fan'
import { Figure, rectStyle } from './Figure'
import { underTarget } from './layout'
import { stateWords } from './link'
import type { LevelModel } from './model'
import { PinBadge, waitingPins } from './Pins'
import { TrayCards } from './Tray'

type Model = Extract<LevelModel, { level: 'agents' }>

export function AgentsLevel({ model }: { model: Model; openFinder: (query?: string) => void }) {
  const env = useLevels()
  const { machine, workspace, cell } = model
  // The big container is this level's content rect, registered under the same id as its L1 box.
  const containerAnchor = env.useAnchor(anchorOf({ machine: machine?.id ?? '-', workspace: workspace?.id ?? '-' }))
  const [tray, setTray] = useState<LevelsAttachment | null>(null)
  // The seat a first tap picked (never the seat the level entered on), so only a second tap on it dives.
  const [picked, setPicked] = useState<string | null>(null)
  if (!machine || !workspace || !cell) return <div className="level level-plate">This workspace is not on {machine?.name ?? 'this machine'} any more.</div>
  const offline = machine.link !== 'live' && machine.link !== 'connecting'
  const background = workspace.state === 'background'
  const fanSeat = model.seats.find((s) => s.key === env.summaryKey) ?? null
  const hidden = workspace.agents.length - model.seats.length
  // The same table on every screen: on a phone its hits (a seat's pitch) fall under the touch target.
  const small = underTarget(model.seats[0]?.hit.w ?? Infinity, env.touch)
  return (
    <div className="level level-agents">
      {(offline || background) && (
        <div className="banner" data-plane="screen">
          {offline ? `${stateWords(machine, env.now())} · read only` : 'Background workspace · its browsers are paused'}
        </div>
      )}
      <div ref={containerAnchor} className="container-figure static" style={rectStyle(cell.rect)}>
        <Figure art={cell.art} />
      </div>
      {/* L2: the avatar is the only target (the container is static), so its hit takes the whole seat pitch. */}
      <div className="seats" role="group" aria-label={`Agents in ${workspace.name}`}>
        {model.seats.map((seat) => (
          <Avatar
            key={seat.key}
            seat={seat}
            size="full"
            interactive
            grow
            pick={small ? { picked: picked === seat.key, onPick: () => setPicked(seat.key) } : null}
            offline={offline}
          />
        ))}
      </div>
      {model.seats.map((seat) => waitingPins(machine, workspace.id, seat.agent.id).length > 0 && <PinBadge key={seat.key} seat={seat.rect} />)}
      {fanSeat && <Fan seat={fanSeat} background={background} />}
      {cell.tray && <TrayCards rect={cell.tray} items={workspace.loose} onOpen={setTray} />}
      {tray && (
        <div className="tray-viewer" role="dialog" aria-label={tray.title}>
          <Figure art={env.kit.attachment({ kind: tray.kind, shared: tray.shared })} className="tray-viewer-card" />
          <div className="tray-viewer-text">
            <b>{tray.title}</b>
            <span className="muted">{tray.host ? `${tray.host} · ` : ''}not wired to an agent</span>
          </div>
          <a className="cta small" href={machine.base} target="_blank" rel="noreferrer">
            Open in the canvas
          </a>
          <button type="button" className="close" aria-label="Close" onClick={() => setTray(null)}>
            ×
          </button>
        </div>
      )}
      {hidden > 0 && <div className="banner bottom" data-plane="screen">{hidden} more agents than seats · find them with /</div>}
    </div>
  )
}
