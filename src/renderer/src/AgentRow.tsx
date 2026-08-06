import { AgentAvatar } from './nodes/AgentAvatar'
import { TurnView } from './nodes/TurnView'
import { RoleAvatar } from './nodes/RoleAvatar'
import type { AgentPhase, AgentRow as Row } from './agent-rows'
import type { TurnPhase } from '../../shared/turn'

/**
 * One agent in the sidebar. The SAME field set the canvas card shows
 * (TerminalNode's TurnSummary) — recap title, the ask, the live tool call,
 * the latest status — plus the roster's identity fields.
 *
 * There is no level prop and no expanded variant: the sidebar's width drives
 * a --reveal scalar in CSS, and the turn block grows in continuously. Info and
 * trace are the two ends of one motion, not two modes.
 */

const PHASE_LABEL: Record<AgentPhase, string> = {
  working: 'WORKING',
  waiting: 'NEEDS YOU',
  done: 'DONE',
  offline: 'OFFLINE',
  quiet: 'QUIET',
}

/** The avatar speaks TurnPhase; the row speaks AgentPhase. */
const AVATAR_PHASE: Record<AgentPhase, TurnPhase> = {
  working: 'thinking',
  waiting: 'waiting',
  done: 'replied',
  offline: 'idle',
  quiet: 'idle',
}

function agoLabel(since: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - since) / 60000))
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

export function AgentRow({
  row,
  now,
  selected,
  recovering,
  canRecover,
  selectable = false,
  onOpen,
  onRecover,
}: {
  row: Row
  now: number
  selected: boolean
  recovering: boolean
  canRecover: boolean
  /** Edit mode: the row ticks instead of handing off to the canvas. */
  selectable?: boolean
  onOpen: (row: Row) => void
  onRecover: (row: Row) => void
}): React.JSX.Element {
  return (
    <div
      className={`ags-row${selected ? ' selected' : ''}${row.active ? '' : ' inactive'}${
        selectable ? ' selectable' : ''
      }`}
      aria-pressed={selectable ? selected : undefined}
      data-phase={row.phase}
      role="button"
      tabIndex={0}
      title={row.name}
      onClick={() => onOpen(row)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(row)
        }
      }}
    >
      {selectable && (
        <span className={`ags-tick${selected ? ' on' : ''}`} aria-hidden="true">
          {selected ? '✓' : ''}
        </span>
      )}
      <span className="ags-avatar">
        {row.role ? (
          <RoleAvatar name={row.role} className="ags-role-avatar" />
        ) : (
          <AgentAvatar phase={AVATAR_PHASE[row.phase]} preset={row.preset} />
        )}
      </span>

      <span className="ags-body">
        <span className="ags-nameline">
          <span className="ags-name">{row.name}</span>
          <span className="cr-chip">{row.preset}</span>
          {row.orch && <span className="cr-chip amber">ORCH</span>}
          {row.role && <span className="cr-chip">{row.role}</span>}
          <span className="cr-chip violet">{row.workspaceName}</span>
          {!row.active && <span className="cr-chip">INACTIVE</span>}
        </span>

        {/* Revealed by width, never by a mode switch (see agent-sidebar.css).
            The turn block is the SAME component the canvas card renders. */}
        <span className="ags-turn">
          {row.turn && <TurnView model={row.turn} />}
          <span className="ags-meta">
            <span className="ags-phase">{PHASE_LABEL[row.phase]}</span>
            {row.turnCount > 0 && <span className="ags-ck">{row.turnCount} CK</span>}
            <span className="ags-ago" title={new Date(row.lastActivityAt).toLocaleString()}>
              {agoLabel(row.lastActivityAt, now)}
            </span>
            <span className="ags-spacer" />
            {/* RECOVER is the one action that cannot hand off to the canvas:
                for an inactive agent the card to zoom to does not exist yet.
                One tap, no confirm — non-destructive and reversible. */}
            {canRecover && !row.active && (
              <button
                className="ags-recover"
                disabled={recovering}
                title={`Recover ${row.name} — resume its session as it was`}
                onClick={(e) => {
                  e.stopPropagation()
                  onRecover(row)
                }}
              >
                <span className="ags-recover-coin" aria-hidden="true" />
                {recovering ? 'RECOVERING…' : 'RECOVER'}
              </button>
            )}
          </span>
        </span>
      </span>
    </div>
  )
}
