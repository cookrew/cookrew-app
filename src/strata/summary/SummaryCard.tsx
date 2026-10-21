// THE HOVER SUMMARY: one pre-mounted, fixed-size overlay (no layout shift),
// placed from the pure layout rect of the agent it describes — above it, or
// below when there is no room. Elapsed time ticks through a text node, not
// React state.
import { useEffect, useRef } from 'react'
import type { Rect, StrataMachine } from '../../shared/strata'
import type { SeatRef } from '../levels/model'
import { attachmentCounts, formatElapsed, modelLine, phaseLine, replyLine, statusLine, taskLine } from './format'

export const CARD = { w: 288, h: 206, gap: 12, margin: 8 } as const

export const placeCard = (anchor: Rect, viewport: Rect): Rect => {
  const x = Math.max(viewport.x + CARD.margin, Math.min(viewport.x + viewport.w - CARD.w - CARD.margin, anchor.x + anchor.w / 2 - CARD.w / 2))
  const above = anchor.y - CARD.gap - CARD.h
  const below = anchor.y + anchor.h + CARD.gap
  const y = above >= viewport.y + CARD.margin ? above : Math.min(below, viewport.y + viewport.h - CARD.h - CARD.margin)
  return { x, y, w: CARD.w, h: CARD.h }
}

function Elapsed({ since, suffix }: { since: number | null; suffix: string }) {
  const node = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const tick = () => {
      if (node.current) node.current.textContent = `${formatElapsed(since === null ? null : Date.now() - since)}${suffix}`
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [since, suffix])
  return <span ref={node} />
}

export function SummaryCard({
  seat,
  machine,
  viewport,
  onHold,
  onRelease
}: {
  seat: SeatRef | null
  machine: StrataMachine | null
  viewport: Rect
  onHold: () => void
  onRelease: () => void
}) {
  const hidden = !seat
  const rect = seat ? placeCard(seat.rect, viewport) : { x: -9999, y: -9999, w: CARD.w, h: CARD.h }
  const offline = !!machine && machine.link !== 'live'
  const agent = seat?.agent
  const phase = agent ? phaseLine(agent, Date.now(), offline) : null
  const counts = agent ? attachmentCounts(agent) : null
  return (
    <div
      className={`summary${hidden ? ' hidden' : ''}`}
      style={{ left: rect.x, top: rect.y, width: CARD.w, height: CARD.h }}
      role="tooltip"
      aria-hidden={hidden}
      onPointerEnter={onHold}
      onPointerLeave={onRelease}
    >
      {agent && phase && counts && (
        <>
          <div className="sum-name">
            <span className={`sum-dot ph-${offline ? 'offline' : agent.phase}${phase.live ? '' : ' guess'}`} />
            <b>{agent.name}</b>
            {agent.orch && <span className="chip">orch</span>}
          </div>
          <div className="sum-line muted">{modelLine(agent)}</div>
          <div className="sum-line">
            <b>{phase.label}</b> · <Elapsed since={agent.phaseSince} suffix={phase.label === 'last turn' ? ' ago' : ''} /> · <span className={`chip${phase.live ? ' ok' : ''}`}>{phase.source}</span>
          </div>
          <div className="sum-line">📌 {taskLine(agent)}</div>
          <div className="sum-line muted">↩ {replyLine(agent)}</div>
          <div className="sum-line muted">⏳ {statusLine(agent, offline)}</div>
          <div className="sum-counts">
            <span>📝 {counts.notes}</span>
            <span>🌐 {counts.browsers}</span>
            {counts.shared > 0 && <span>🔗 {counts.shared} shared</span>}
            <span>{agent.turns} turns</span>
          </div>
        </>
      )}
    </div>
  )
}
