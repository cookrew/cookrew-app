import { AgentCard, CARD_POSE, type CardPose } from './AgentCard'
import type { AgentView, ItemView } from './zoom-model'

const KEEP_DRAFT = (): void => undefined

/**
 * THE SAME CARD, ACROSS THE TILE (owner, 2026-11-16: "撑满整个tile"). The
 * tile's own row already shows the face, name and state, so the card brings
 * its latest words, three thumbnails and the reply box, laid across the
 * tile's width (workspace-tile.css · .dm-agent-card, 352 wide): words on top,
 * thumbnails 112 wide 8 apart, the reply box at the foot.
 */
const TILE_CARD_POSE: CardPose = {
  ...CARD_POSE,
  origin: 0,
  body: { x: 0, y: 0 },
  thumb: (k) => ({ x: 56 + 120 * k, y: 95 }),
  coin: { x: -48, y: -18, s: 0.45 }
}

export function WorkspaceTileCard({ agent, items, onOpen, onItem }: { agent: AgentView; items: readonly ItemView[]; onOpen: () => void; onItem: (id: string) => void }): React.JSX.Element {
  return (
    <div className="dm-agent-card">
      <div className="ag-card dm-agent-card-box">
        <AgentCard agent={agent} items={items} onOpen={onOpen} onItem={onItem} onDraft={KEEP_DRAFT} pose={TILE_CARD_POSE} />
      </div>
    </div>
  )
}
