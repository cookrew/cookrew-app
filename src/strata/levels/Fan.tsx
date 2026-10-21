// The attachment fan: an agent's notes and browsers, tucked behind it at rest,
// fanned above it on hover intent or press-and-hold. Connection order, capped
// (6 pointer, 4 touch) with a +N card; a click dives with that item focused.
import type { LevelsAttachment, Rect } from '../../shared/strata'
import { center } from './geometry'
import { useLevels } from './env'
import { fanLayout } from './layout'
import type { SeatRef } from './model'

export const FAN_CAP = { pointer: 6, touch: 4 } as const

/** How far the fan reaches from the avatar's centre (card centres sit on this radius). */
export const fanRadius = (seatW: number, touch: boolean) => seatW / 2 + (touch ? 44 : 36)

/** The seat plus the fan's arc: what the summary card must not cover. */
export const fanBounds = (seat: Rect, touch: boolean): Rect => {
  const reach = fanRadius(seat.w, touch) + 26
  const c = center(seat)
  return { x: c.x - reach, y: c.y - reach, w: reach * 2, h: reach + seat.h / 2 }
}

const glyph = (a: LevelsAttachment) => (a.kind === 'note' ? '📝' : '🌐')

const cardTitle = (a: LevelsAttachment, background: boolean) =>
  a.kind === 'note' ? a.title : `${a.title}${a.host ? ` · ${a.host}` : ''}${background ? ' · not running' : ''}`

export function Fan({ seat, background }: { seat: SeatRef; background: boolean }) {
  const env = useLevels()
  const list = seat.agent.attachments
  if (list.length === 0) return null
  const cap = env.touch ? FAN_CAP.touch : FAN_CAP.pointer
  const c = center(seat.rect)
  const { cards, more } = fanLayout(list.length, cap, fanRadius(seat.rect.w, env.touch))
  return (
    <div className="fan" onPointerEnter={() => env.hover.holdCard()} onPointerLeave={() => env.hover.releaseCard()}>
      {cards.map((card) => {
        const style = { left: c.x + card.x, top: c.y + card.y, transform: `translate(-50%, -50%) rotate(${card.angle}deg)` }
        if (card.item === 'more')
          return (
            <button key="more" type="button" className="fan-card more" style={style} aria-label={`${more} more attachments: open with every note and browser listed`} onClick={() => env.go(seat.path, { allAttachments: true })}>
              +{more}
            </button>
          )
        const a = list[card.item]
        const title = cardTitle(a, background)
        return (
          <button key={a.id} type="button" className={`fan-card ${a.kind}`} style={style} title={title} aria-label={`${a.kind}: ${title}${a.shared ? ', shared' : ''}`} onClick={() => env.go(seat.path, { attachmentId: a.id })}>
            <span aria-hidden="true">{glyph(a)}</span>
            {a.shared && <span className="shared-chip" aria-hidden="true" />}
          </button>
        )
      })}
    </div>
  )
}
