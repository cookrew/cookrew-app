import { AgentCard } from '../zoom/AgentCard'
import { BarWaitCard } from '../zoom/BarWaitCard'
import type { AgentView, ItemView } from '../zoom/zoom-model'
import { useWaitAnswer } from '../prompt/wait-answer'

/**
 * The card a troop's face floats. Waiting on a menu it carries the rows, as the
 * bar's card does, so a question can be answered from a full view of someone
 * else. The box there is the viewed agent's, so words for this one go through
 * this agent's own view: the row to type in and Reply open it.
 */
export function AgentPetCard({ agent, items, onOpen, onItem, onDelete, onDraft, onClose }: {
  agent: AgentView
  items: readonly ItemView[]
  onOpen: () => void
  onItem: (id: string) => void
  onDelete?: () => void
  onDraft: (text: string) => void
  onClose: () => void
}): React.JSX.Element {
  const wait = useWaitAnswer(agent.id, onOpen)
  if (wait.view) return <BarWaitCard agent={agent} view={wait.view} wait={wait} onOpen={onOpen} onReply={onOpen} onClose={onClose} />
  return <AgentCard agent={agent} items={items} onOpen={onOpen} onItem={onItem} onDelete={onDelete} onDraft={onDraft} />
}
