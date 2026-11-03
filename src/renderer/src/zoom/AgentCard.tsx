import { InkAvatar } from './InkAvatar'
import { CardWords, QuickReply, useQuickReply } from './quick-reply'
import { Counts, NOTE_GLYPH, Page } from './ZoomParts'
import type { AgentView, ItemView } from './zoom-model'
import './agent-card.css'

/**
 * AN AGENT'S CARD, FLOATING (owner, 2026-11-01): in a full view the crew view
 * is not on screen, so the agent group shows the card itself, beside the face
 * that was clicked. It is the crew view's card, not a look-alike: the same
 * AgentView (zoom-model.ts · agentViewOf, from the one crew list), the same
 * parts with the same classes (ZoomParts · AgentNode and LinkNode), each
 * where the zoom painter puts it when the card is open (zoom-frame.ts):
 * the face in the corner, name, state and counts beside it, the latest turn,
 * three thumbnails with their item's coin, the reply box, and the × that
 * removes the agent (the app's confirm dialog asks). Its face opens the full
 * view, as the crew card's does; a tap outside or Escape closes it.
 *
 * Its first version laid the same parts out in a column of its own, with an
 * OPEN and a close button: two cards that did not look alike (owner,
 * 2026-11-01: "the two cards are still not the same").
 *
 * Classes the troop's motion finds (pets/pet-zoom.ts · CARD_PARTS) stay on
 * the parts they name, so the face still zooms into it.
 */

/** Thumbnails on the card, as the crew card's strip holds. */
export const CARD_THUMBS = 3

/**
 * The open card's geometry, in the painter's own numbers: the origin is the
 * face's centre, the card box starts 34px up and left of it (zoom.css · .zv-card,
 * 260x244).
 */
export const CARD_POSE = {
  origin: 34,
  /** The face is drawn at this scale on the open card (the painter's lerp(1, 0.62, …)). */
  face: 0.62,
  name: { x: 30, y: -24 },
  meta: { x: 30, y: -2 },
  body: { x: -18, y: 32 },
  thumb: (k: number) => ({ x: 17 + 79 * k, y: 136 }),
  coin: { x: -27, y: -18, s: 0.45 }
} as const

const at = (p: { x: number; y: number }): React.CSSProperties => ({ transform: `translate(${p.x}px, ${p.y}px)` })

export function AgentCard({
  agent,
  items,
  onOpen,
  onItem,
  onDelete,
  onDraft
}: {
  agent: AgentView
  /** Its browsers and notes, newest wire first. */
  items: readonly ItemView[]
  /** In full: this agent's full view. */
  onOpen: () => void
  onItem: (id: string) => void
  /** Remove the agent (the app's confirm dialog asks); absent where removing is not offered. */
  onDelete?: () => void
  /** The draft, so a tap outside does not throw it away (PetTroop). */
  onDraft: (text: string) => void
}): React.JSX.Element {
  const reply = useQuickReply(agent.id, onDraft)
  const { origin, face, name, meta, body, thumb, coin } = CARD_POSE
  return (
    <div className="ag-plate" style={{ left: origin, top: origin }}>
      <button type="button" className="zv-av cr-pet-card-face" style={{ transform: `scale(${face})` }} title={`Open ${agent.name} in full`} aria-label={`Open ${agent.name} in full`} onClick={onOpen}>
        <InkAvatar id={agent.id} preset={agent.preset} orch={agent.orch} status={agent.status} weight="large" />
      </button>
      <div className="zv-nm cr-pet-card-name" style={at(name)}>
        {agent.name}
      </div>
      <div className="ag-meta cr-pet-card-meta" style={at(meta)}>
        <span className={`zv-st ${agent.status}`}>{agent.word}</span>
        <span className="zv-cnt">
          <Counts browsers={agent.browsers} notes={agent.notes} />
        </span>
      </div>
      {onDelete && (
        <button type="button" className="zv-del" title={`Remove ${agent.name}`} aria-label={`Remove ${agent.name}`} onClick={onDelete}>
          ×
        </button>
      )}
      <div className="zv-body cr-pet-card-turn" style={at(body)}>
        <CardWords agent={agent} sent={reply.sent} />
      </div>
      {items.length > 0 &&
        items.slice(0, CARD_THUMBS).map((item, k) => (
          <button key={item.id} type="button" className={`zv-lk ag-lk ${item.kind}`} style={at(thumb(k))} title={item.title} aria-label={`Open ${item.kind}: ${item.title}`} onClick={() => onItem(item.id)}>
            <span className={`zv-th ${item.kind}`}>
              <Page item={item} />
            </span>
            <span className="zv-coin" style={{ transform: `translate(${coin.x}px, ${coin.y}px) scale(${coin.s})` }}>
              <span className="zv-face zv-face-item" style={item.kind === 'browser' ? { background: item.tint } : undefined}>
                {item.kind === 'browser' ? item.initial : NOTE_GLYPH}
              </span>
            </span>
          </button>
        ))}
      <QuickReply agent={agent} reply={reply} className="zv-reply cr-pet-card-ask" />
    </div>
  )
}
