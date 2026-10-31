import { InkAvatar } from './InkAvatar'
import { inkStatusOfRow } from './ink-status'
import { CardWords, QuickReply, useQuickReply } from './quick-reply'
import { Counts, Page } from './ZoomParts'
import type { AgentView, ItemView } from './zoom-model'
import './agent-card.css'

/**
 * AN AGENT'S CARD, FLOATING (owner, 2026-11-01): in a full view the crew view
 * is not on screen, so the agent group shows the card itself, beside the face
 * that was clicked. It is the crew view's card, not a look-alike: the same
 * AgentView (zoom-model.ts · agentViewOf, from the one crew list), the same
 * face and status ring, the same state word and counts, the same words and
 * reply box (quick-reply.tsx), the same thumbnails (ZoomParts · Page). It
 * exists only while it is open: one card at a time, never one per agent.
 *
 * The class names are the troop's card parts (pets/pet-zoom.ts · CARD_PARTS),
 * so the face zooms into it and it zooms into the full view.
 */

/** Thumbnails on the card, as the crew card's strip holds. */
export const CARD_THUMBS = 3

export function AgentCard({
  agent,
  items,
  onOpen,
  onClose,
  onItem,
  onDraft
}: {
  agent: AgentView
  /** Its browsers and notes, newest wire first. */
  items: readonly ItemView[]
  /** In full: this agent's full view. */
  onOpen: () => void
  onClose: () => void
  onItem: (id: string) => void
  /** The draft, so a tap outside does not throw it away (PetTroop). */
  onDraft: (text: string) => void
}): React.JSX.Element {
  const reply = useQuickReply(agent.id, onDraft)
  return (
    <>
      <div className="cr-pet-card-head">
        <span className="cr-pet-card-face">
          <InkAvatar id={agent.id} preset={agent.preset} orch={agent.orch} status={inkStatusOfRow(agent.phase, agent.unread)} weight="large" />
        </span>
        <span className="cr-pet-card-who">
          <span className="cr-pet-card-name">{agent.name}</span>
          <span className="cr-pet-card-meta">
            <span className={`zv-st ${agent.phase}`}>{agent.word}</span>
            <span className="zv-cnt">
              <Counts browsers={agent.browsers} notes={agent.notes} />
            </span>
          </span>
        </span>
        <button type="button" className="cr-pet-card-open" onClick={onOpen} title="Open in full (or click its face again)">
          OPEN
        </button>
        <button type="button" className="cr-pet-card-x" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="cr-pet-card-turn">
        <CardWords agent={agent} sent={reply.sent} />
      </div>
      {items.length > 0 ? (
        <div className="ag-thumbs">
          {items.slice(0, CARD_THUMBS).map((item) => (
            <button key={item.id} type="button" className={`zv-th ag-thumb ${item.kind}`} title={item.title} aria-label={`Open ${item.kind}: ${item.title}`} onClick={() => onItem(item.id)}>
              <Page item={item} />
            </button>
          ))}
        </div>
      ) : (
        <div className="ag-thumbs-none">no browser or note</div>
      )}
      <QuickReply agent={agent} reply={reply} className="zv-reply cr-pet-card-ask" />
    </>
  )
}
