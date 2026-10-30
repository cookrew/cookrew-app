// THE TWO SIDE COLUMNS: the workspace's browsers and notes on the left, its
// agents on the right — one card frame for both, so the two read as one
// kind of thing. Each column says when it is filtered, and by what, with the
// way out next to it.
import { useEffect, useRef, useState } from 'react'
import { AgentRow } from '../AgentRow'
import type { AgentRow as Row } from '../agent-rows'
import { CrIcon } from '../icons'
import { AgentAvatar } from '../nodes/AgentAvatar'
import type { TurnPhase } from '../../../shared/turn'
import type { StageItemCard } from './stage-select'

const AVATAR_PHASE: Record<Row['phase'], TurnPhase> = {
  working: 'thinking',
  waiting: 'waiting',
  done: 'replied',
  offline: 'idle',
  quiet: 'idle'
}

const PHASE_WORD: Record<Row['phase'], string> = {
  waiting: 'Needs you',
  working: 'Working',
  done: 'Done',
  quiet: 'Quiet',
  offline: 'Offline'
}

/** The board card outlives the pointer by this long, so it can be reached; and waits this long to appear. */
const LEAVE_MS = 220
const ENTER_MS = 350

interface ColumnHead {
  title: string
  total: number
  /** Filtered: the name it is filtered by. */
  filter: string | null
  onClear: () => void
}

function Head({ title, total, filter, onClear }: ColumnHead): React.JSX.Element {
  return (
    <div className={`stg-head${filter ? ' filtered' : ''}`}>
      {filter ? (
        <>
          <span className="stg-head-title" title={`Only what is wired to ${filter}`}>
            For {filter}
          </span>
          <span className="stg-head-count">{total}</span>
          <button type="button" className="stg-head-clear" title="Show all" aria-label="Show all" onClick={onClear}>
            <CrIcon name="close" />
          </button>
        </>
      ) : (
        <>
          <span className="stg-head-title">{title}</span>
          <span className="stg-head-count">{total}</span>
        </>
      )}
    </div>
  )
}

export function ItemColumn({
  items,
  head,
  selected,
  open,
  faces,
  hot = null,
  onPick
}: {
  items: readonly StageItemCard[]
  /** The card that needs you, at the workspace level. */
  hot?: string | null
  head: ColumnHead
  /** The item in the middle (item mode). */
  selected: string | null
  /** The item open in the terminal's lower half (agent mode). */
  open: string | null
  /** Agent id → its row, for the small faces at the foot of a card. */
  faces: ReadonlyMap<string, Row>
  onPick: (item: StageItemCard) => void
}): React.JSX.Element {
  return (
    <aside className="stg-col stg-items" aria-label="Browsers and notes">
      <Head {...head} />
      <div className="stg-list" role="list">
        {items.length === 0 && <div className="stg-empty">{head.filter ? 'Nothing wired to it.' : 'No browsers or notes here.'}</div>}
        {items.map((item) => {
          const owners = item.owners.map((id) => faces.get(id)).filter((r): r is Row => r !== undefined)
          return (
            <button
              key={item.id}
              type="button"
              role="listitem"
              className={`stg-card ${item.kind}${item.id === selected ? ' on' : ''}${item.id === open ? ' open' : ''}${item.id === hot ? ' hot' : ''}`}
              title={item.sub ? `${item.title}\n${item.sub}` : item.title}
              aria-current={item.id === selected || item.id === open ? 'true' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(item)}
            >
              <span className="stg-card-icon">
                <CrIcon name={item.kind} />
              </span>
              <span className="stg-card-body">
                <span className="stg-card-name">{item.title}</span>
                {item.sub && <span className="stg-card-line">{item.sub}</span>}
                {owners.length > 0 && (
                  <span className="stg-card-foot">
                    {owners.slice(0, 4).map((r) => (
                      <span key={r.id} className={`stg-mini ${r.phase}`} title={r.name}>
                        <AgentAvatar phase={AVATAR_PHASE[r.phase]} preset={r.preset} />
                      </span>
                    ))}
                    {owners.length > 4 && <span className="stg-more">+{owners.length - 4}</span>}
                  </span>
                )}
              </span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}

export function AgentColumn({
  rows,
  head,
  now,
  current,
  auto,
  counts,
  hot = null,
  onPick
}: {
  rows: readonly Row[]
  /** The agent that needs you, at the workspace level. */
  hot?: string | null
  head: ColumnHead
  now: number
  /** The agent whose terminal is in the middle. */
  current: string | null
  /** The middle is following what needs you, not your pick. */
  auto: boolean
  /** Agent id → how many browsers and notes are wired to it. */
  counts: ReadonlyMap<string, { browsers: number; notes: number }>
  onPick: (row: Row) => void
}): React.JSX.Element {
  // The board card, as a bubble beside the column, on a pointer's rest.
  const [bubble, setBubble] = useState<{ id: string; top: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const col = useRef<HTMLElement>(null)
  const stop = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => () => stop(), [])
  const row = bubble ? (rows.find((r) => r.id === bubble.id) ?? null) : null
  return (
    <aside
      className="stg-col stg-agents"
      aria-label="Agents"
      ref={col}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'mouse') return
        stop()
        timer.current = setTimeout(() => setBubble(null), LEAVE_MS)
      }}
    >
      <Head {...head} />
      <div className="stg-list" role="list" onScroll={() => setBubble(null)}>
        {rows.length === 0 && <div className="stg-empty">{head.filter ? 'No agent is wired to it.' : 'No agents here yet.'}</div>}
        {rows.map((r) => {
          const c = counts.get(r.id)
          const line = r.turn?.latest?.text ?? r.turn?.title ?? r.brief ?? r.turn?.ask ?? null
          return (
            <button
              key={r.id}
              type="button"
              role="listitem"
              className={`stg-card agent ${r.phase}${r.id === current ? (auto ? ' auto' : ' on') : ''}${r.id === hot ? ' hot' : ''}`}
              aria-current={r.id === current ? 'true' : undefined}
              onPointerEnter={(e) => {
                if (e.pointerType !== 'mouse') return
                stop()
                const el = e.currentTarget
                timer.current = setTimeout(() => {
                  const top = el.getBoundingClientRect().top - (col.current?.getBoundingClientRect().top ?? 0)
                  setBubble({ id: r.id, top })
                }, bubble ? 0 : ENTER_MS)
              }}
              onClick={() => {
                stop()
                setBubble(null)
                onPick(r)
              }}
            >
              <span className="stg-card-icon face">
                <AgentAvatar phase={AVATAR_PHASE[r.phase]} preset={r.preset} />
              </span>
              <span className="stg-card-body">
                <span className="stg-card-name">
                  {r.name}
                  {r.orch && <span className="stg-tag">orch</span>}
                </span>
                <span className="stg-card-phase">
                  {PHASE_WORD[r.phase]}
                  {r.id === current && auto && <span className="stg-tag">{r.id === hot ? 'needs a look' : 'on stage'}</span>}
                </span>
                {line && <span className="stg-card-line">{line}</span>}
                {c && (c.browsers > 0 || c.notes > 0) && (
                  <span className="stg-card-foot counts">
                    {c.browsers > 0 && (
                      <span title={`${c.browsers} browsers`}>
                        <CrIcon name="browser" /> {c.browsers}
                      </span>
                    )}
                    {c.notes > 0 && (
                      <span title={`${c.notes} notes`}>
                        <CrIcon name="note" /> {c.notes}
                      </span>
                    )}
                  </span>
                )}
              </span>
            </button>
          )
        })}
      </div>
      {row && bubble && (
        <div className="stg-bubble" style={{ top: Math.max(0, bubble.top) }} onPointerEnter={stop}>
          <div className="stg-bubble-body">
            <AgentRow
              row={row}
              now={now}
              selected={false}
              recovering={false}
              canRecover={false}
              onOpen={(r) => {
                setBubble(null)
                onPick(r)
              }}
              onRecover={() => undefined}
            />
          </div>
        </div>
      )}
    </aside>
  )
}
