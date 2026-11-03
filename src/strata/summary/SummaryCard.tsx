// THE HOVER SUMMARY: one pre-mounted, fixed-size overlay (no layout shift),
// placed from the pure layout rect of the agent it describes — above it, or
// below when there is no room. Elapsed time ticks through a text node, not
// React state.
import { useEffect, useRef } from 'react'
import type { Rect, StrataMachine } from '../../shared/strata'
import type { SeatRef } from '../levels/model'
import { attachmentCounts, formatElapsed, modelLine, phaseLine, replyLine, taskLine } from './format'

export const CARD = { w: 288, h: 206, gap: 12, margin: 8 } as const

export const placeCard = (anchor: Rect, viewport: Rect): Rect => {
  const x = Math.max(viewport.x + CARD.margin, Math.min(viewport.x + viewport.w - CARD.w - CARD.margin, anchor.x + anchor.w / 2 - CARD.w / 2))
  const above = anchor.y - CARD.gap - CARD.h
  const below = anchor.y + anchor.h + CARD.gap
  const y = above >= viewport.y + CARD.margin ? above : Math.min(below, viewport.y + viewport.h - CARD.h - CARD.margin)
  return { x, y, w: CARD.w, h: CARD.h }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const TASK = 'M3 2.5h7M3 6h7M3 9.5h4.5'
const REPLY = 'M5 3 2 6l3 3M2.5 6H8a3 3 0 0 1 3 3v1'

function Glyph({ d }: { d: string }) {
  return (
    <svg className="sum-glyph" viewBox="0 0 13 12" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
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
  return <span ref={node} className="elapsed" />
}

export function SummaryCard({
  seat,
  code,
  machine,
  viewport,
  onHold,
  onRelease
}: {
  seat: SeatRef | null
  /** Its jump code: type it anywhere, then Enter. */
  code?: string
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
            <b className="sum-title">{agent.name}</b>
            {agent.orch && <span className="chip">orch</span>}
            {code && (
              <kbd className="code-chip" title="Jump code: type it anywhere, then Enter">
                {code}
              </kbd>
            )}
          </div>
          <div className="sum-line muted small">{modelLine(agent)}</div>
          <div className={`sum-line sum-phase ph-text-${offline ? 'offline' : agent.phase}`}>
            <b>{phase.label}</b> · <Elapsed since={agent.phaseSince} suffix={phase.label === 'last turn' ? ' ago' : ''} />
            {agent.status && <span className="muted"> · {agent.status}</span>}
            {!phase.live && <span className="muted"> · estimated</span>}
          </div>
          <div className="sum-task">
            <Glyph d={TASK} />
            <span>{taskLine(agent)}</span>
          </div>
          <div className="sum-line muted">
            <Glyph d={REPLY} />
            {replyLine(agent)}
          </div>
          <div className="sum-counts">
            <span>{plural(counts.notes, 'note')}</span>
            <span>{plural(counts.browsers, 'browser')}</span>
            {counts.shared > 0 && <span>{counts.shared} shared</span>}
            <span className="sum-turns">{plural(agent.turns, 'turn')}</span>
          </div>
        </>
      )}
    </div>
  )
}
