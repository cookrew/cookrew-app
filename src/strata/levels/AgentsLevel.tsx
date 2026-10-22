// LEVEL 2 — one workspace: its agents seated evenly in creation order (never
// re-sorted; attention is a pin), each with its notes and browsers tucked
// behind and fanned on hover. Loose items sit in the container's tray.
import { useState } from 'react'
import { anchorOf, type LevelsAttachment } from '../../shared/strata'
import { Avatar } from './Avatar'
import { useLevels } from './env'
import { Fan } from './Fan'
import { Figure, rectStyle } from './Figure'
import { stateWords } from './link'
import type { LevelModel } from './model'
import { PinBadge, waitingPins } from './Pins'

type Model = Extract<LevelModel, { level: 'agents' }>

export function AgentsLevel({ model }: { model: Model; openFinder: (query?: string) => void }) {
  const env = useLevels()
  const { machine, workspace, cell } = model
  // The big container is this level's content rect, registered under the same id as its L1 box.
  const containerAnchor = env.useAnchor(anchorOf({ machine: machine?.id ?? '-', workspace: workspace?.id ?? '-' }))
  const [tray, setTray] = useState<LevelsAttachment | null>(null)
  if (!machine || !workspace || !cell) return <div className="level level-plate">This workspace is not on {machine?.name ?? 'this machine'} any more.</div>
  const offline = machine.link !== 'live' && machine.link !== 'connecting'
  const background = workspace.state === 'background'
  const fanSeat = model.seats.find((s) => s.key === env.summaryKey) ?? null
  const hidden = workspace.agents.length - model.seats.length
  return (
    <div className="level level-agents">
      <div className="banner subtle" data-plane="screen">
        {offline ? `${stateWords(machine, env.now())} · read only` : background ? 'background workspace · phases are last known · browsers not running' : 'on screen · live'}
      </div>
      <div ref={containerAnchor} className="container-figure static" style={rectStyle(cell.rect)}>
        <Figure art={cell.art} />
      </div>
      {/* L2: the avatar is the only target (the container is static), so its hit takes the whole seat pitch. */}
      <div role="grid" aria-label={`Agents in ${workspace.name}`} aria-rowcount={Math.ceil(model.seats.length / 8)}>
        {model.seats.map((seat) => (
          <Avatar key={seat.key} seat={seat} size="full" interactive grow offline={offline} />
        ))}
      </div>
      {model.seats.map((seat) => waitingPins(machine, workspace.id, seat.agent.id).length > 0 && <PinBadge key={seat.key} seat={seat.rect} />)}
      {fanSeat && <Fan seat={fanSeat} background={background} />}
      {cell.tray && workspace.loose.length > 0 && (
        <div className="tray" style={rectStyle(cell.tray)} aria-label="Loose notes and browsers">
          {workspace.loose.map((item) => (
            <button key={item.id} type="button" className={`tray-card ${item.kind}`} title={item.host ? `${item.title} · ${item.host}` : item.title} onClick={() => setTray(item)}>
              {item.kind === 'note' ? '📝' : '🌐'} {item.title}
            </button>
          ))}
        </div>
      )}
      {tray && (
        <div className="tray-viewer" role="dialog" aria-label={tray.title}>
          <b>{tray.title}</b>
          {tray.host && <span className="muted">{tray.host}</span>}
          <p className="muted">Wired to no agent. Its full view needs the loose-attachment endpoint (asked Revel).</p>
          <button type="button" onClick={() => setTray(null)}>
            Close
          </button>
        </div>
      )}
      {hidden > 0 && <div className="banner subtle bottom" data-plane="screen">+{hidden} more agents than seats · find them with /</div>}
    </div>
  )
}
