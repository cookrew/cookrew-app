import { CardBody } from './CardBody'
import { QuickReply, useQuickReply } from './quick-reply'
import type { AgentView, ItemView } from './zoom-model'

export function WorkspaceTileCard({ agent, item, thumb }: { agent: AgentView; item: ItemView | null; thumb: (item: ItemView) => React.JSX.Element }): React.JSX.Element {
  const reply = useQuickReply(agent.id)
  return (
    <div className="dm-card">
      <CardBody agent={agent} sent={reply.sent} roomy className="zv-body dm-card-body" />
      {item && <div className="dm-card-art" title={item.title}>{thumb(item)}<span className="dm-card-art-title">{item.title}</span></div>}
      <QuickReply agent={agent} reply={reply} className="zv-reply dm-card-reply" />
    </div>
  )
}
