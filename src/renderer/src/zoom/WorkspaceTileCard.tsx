import { AgentCard } from './AgentCard'
import type { AgentView, ItemView } from './zoom-model'

const KEEP_DRAFT = (): void => undefined

export function WorkspaceTileCard({ agent, items, onOpen, onItem }: { agent: AgentView; items: readonly ItemView[]; onOpen: () => void; onItem: (id: string) => void }): React.JSX.Element {
  return (
    <div className="dm-agent-card">
      <div className="ag-card dm-agent-card-box">
        <AgentCard agent={agent} items={items} onOpen={onOpen} onItem={onItem} onDraft={KEEP_DRAFT} />
      </div>
    </div>
  )
}
