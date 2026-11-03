// Loose notes and browsers (wired to no agent) lie on the container's tray as
// the kit's own cards: a small tilted stack. On L1 they are passive scenery;
// on L2 each card is a button and the stack carries a caption.
import type { LevelsAttachment, Rect } from '../../shared/strata'
import { CARD_VIEW } from '../figures'
import { useLevels } from './env'
import { Figure, rectStyle } from './Figure'

const MAX_CARDS = 3
const TILT = [-9, 4, -3]
const MAX_CARD_W = 72

export function TrayCards({ rect, items, onOpen }: { rect: Rect; items: readonly LevelsAttachment[]; onOpen?: (item: LevelsAttachment) => void }) {
  const env = useLevels()
  if (items.length === 0) return null
  const shown = items.slice(0, MAX_CARDS)
  const w = Math.min(rect.w * 0.6, ((rect.h * 0.8) / CARD_VIEW.h) * CARD_VIEW.w, MAX_CARD_W)
  const h = (w / CARD_VIEW.w) * CARD_VIEW.h
  const step = Math.min(w * 0.2, 12)
  const x0 = rect.x + rect.w / 2 - w / 2 - ((shown.length - 1) * step) / 2
  const y0 = rect.y + rect.h / 2 - h / 2 + ((shown.length - 1) * step) / 4
  const extra = items.length - 1
  return (
    <div className={`tray${onOpen ? ' open' : ''}`} aria-label={onOpen ? 'Loose notes and browsers' : undefined} aria-hidden={onOpen ? undefined : true}>
      {shown.map((item, i) => {
        const style = { ...rectStyle({ x: x0 + i * step, y: y0 - (i * step) / 2, w, h }), transform: `rotate(${TILT[i]}deg)` }
        const art = <Figure art={env.kit.attachment({ kind: item.kind, shared: item.shared })} />
        if (!onOpen)
          return (
            <span key={item.id} className="tray-card" style={style}>
              {art}
            </span>
          )
        const title = item.host ? `${item.title} · ${item.host}` : item.title
        return (
          <button key={item.id} type="button" className="tray-card" style={style} title={title} aria-label={`Loose ${item.kind}: ${title}`} onClick={() => onOpen(item)}>
            {art}
          </button>
        )
      })}
      {onOpen && (
        <span className="tray-caption" data-plane="screen" style={{ left: rect.x + rect.w / 2, top: rect.y + rect.h + 6 }}>
          {shown[0].title}
          {extra > 0 && <span className="muted"> +{extra}</span>}
        </span>
      )}
    </div>
  )
}
