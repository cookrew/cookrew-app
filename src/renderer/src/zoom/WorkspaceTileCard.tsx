import { CardBody } from './CardBody'
import { QuickReply, useQuickReply } from './quick-reply'
import { Page } from './page-parts'
import type { AgentView, ItemView } from './zoom-model'

export default function WorkspaceTileCard({ agent, item }: { agent: AgentView; item: ItemView | null }): React.JSX.Element {
  const reply = useQuickReply(agent.id)
  return (
    <div className="zv-tile-card">
      <CardBody agent={agent} sent={reply.sent} roomy className="zv-body zv-tile-card-body" />
      {item && <div className="zv-tile-card-art"><div className="zv-artifact-page"><Page item={item} words /></div><span>{item.title}</span></div>}
      <QuickReply agent={agent} reply={reply} className="zv-reply zv-tile-card-reply" />
    </div>
  )
}
