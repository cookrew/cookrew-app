import { useId } from 'react'
import { InkAvatar } from './InkAvatar'
import { WaitReviewList, WaitRows, WaitSteps } from '../prompt/WaitChoices'
import type { WaitAnswering, WaitView } from '../prompt/wait-answer'
import type { AgentView } from './zoom-model'

/**
 * A WAITING AGENT'S CARD FROM THE BAR'S GROUP (owner task, 2026-11-04; cut
 * docs/avatar-send-tasks/g-choice · 5-phone-from-the-group): the card popped
 * from AGENTS carries the same rows as the box over the prompt, smaller, so
 * the menu is answered without going anywhere. Its foot opens the full view
 * or hands over to the box (the agent is already in it: the card selected it).
 */
export function BarWaitCard({ agent, view, wait, onOpen, onReply, onClose }: {
  agent: AgentView
  view: WaitView
  wait: WaitAnswering
  onOpen: () => void
  onReply: () => void
  onClose: () => void
}): React.JSX.Element {
  const qid = useId()
  return (
    <>
      <div className="cr-pet-card-head wc-card-head">
        <button type="button" className="cr-pet-card-face wc-card-face" title={`Open ${agent.name} in full`} aria-label={`Open ${agent.name} in full`} onClick={onOpen}>
          <InkAvatar id={agent.id} preset={agent.preset} orch={agent.orch} status="waiting" weight="regular" />
        </button>
        <div className="cr-pet-card-who">
          <span className="cr-pet-card-name wc-card-name">{agent.name}</span>
          <span className="wc-card-needs">needs you</span>
        </div>
        <button type="button" className="wc-card-x" aria-label={`Close ${agent.name}'s card`} onClick={onClose}>
          ×
        </button>
      </div>
      <div
        className="wc-card-ask"
        role="group"
        aria-labelledby={qid}
        onKeyDown={(e) => {
          if (e.metaKey || e.ctrlKey || e.altKey) return
          if (!wait.key(e.key)) return
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        <p className="wc-q" id={qid}>
          {view.choice.question}
        </p>
        <WaitSteps choice={view.choice} onStep={wait.step} />
        <div className="wc-scroll">
          <WaitReviewList choice={view.choice} />
          <WaitRows view={view} onAnswer={wait.answer} small />
        </div>
        {wait.moved && <p className="wc-moved" role="status">The menu moved on · nothing sent</p>}
      </div>
      <div className="wc-foot wc-card-foot">
        <button type="button" onClick={onOpen}>
          full view ↗
        </button>
        <button type="button" onClick={onReply}>
          reply · the box ↓
        </button>
      </div>
    </>
  )
}
