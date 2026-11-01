import { useCallback, useEffect, useState } from 'react'
import { AgentLatest } from './AgentLatest'
import { draftKey, useDraft } from '../prompt/prompt-draft'
import { submitLine, typeLine, useLiveLine } from '../prompt/live-line'
import type { AgentView } from './zoom-model'

/**
 * THE CARD'S WORDS AND ITS REPLY BOX, ONE COPY (owner, 2026-11-01): the zoom
 * view's card (ZoomParts · AgentNode) and the card the agent group floats in
 * a full view (AgentCard.tsx) draw these, so an agent says the same thing and
 * takes a reply the same way wherever its card is.
 *
 * The draft is the agent's ONE draft (prompt/prompt-draft.ts): the global
 * prompt box at the foot, carrying @agent, reads and writes the same text,
 * and it is the agent's own input line, typed there as it is written
 * (prompt/live-line.ts).
 */

/** How long a sent reply stands in the card's words. */
const SENT_MS = 4000

export interface QuickReplyState {
  readonly draft: string
  /** `composing`: an IME is mid-word, so the agent's line waits for the word. */
  readonly setDraft: (text: string, composing?: boolean) => void
  /** The reply just sent, for a moment; null otherwise. */
  readonly sent: string | null
  readonly send: () => void
}

/**
 * `watching`: this box is on screen, so words typed in the agent's own line
 * come into it. Off for the crew's faces, which carry no box: watching is a
 * subscription to the agent's activity, and a face re-rendering on every push
 * is what the zoom view's render budget cannot pay.
 */
export function useQuickReply(agentId: string, onDraft?: (text: string) => void, watching = true): QuickReplyState {
  const [draft, setDraftState] = useDraft(draftKey(agentId))
  const [sent, setSent] = useState<string | null>(null)
  useLiveLine(watching ? agentId : null)
  const setDraft = useCallback(
    (text: string, composing = false) => {
      setDraftState(text)
      if (!composing) typeLine(agentId, text)
      onDraft?.(text)
    },
    [agentId, onDraft, setDraftState]
  )
  useEffect(() => {
    if (sent === null) return
    const timer = setTimeout(() => setSent(null), SENT_MS)
    return () => clearTimeout(timer)
  }, [sent])
  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    submitLine(agentId, text)
    onDraft?.('')
    setSent(text)
  }
  return { draft, setDraft, sent, send }
}

/** What the card says: its latest turn, or the reply just sent. */
export function CardWords({ agent, sent }: { agent: AgentView; sent: string | null }): React.JSX.Element {
  if (sent !== null) {
    return (
      <div className="ag-latest">
        <span className="ag-you">
          <em>You:</em> {sent}
        </span>
      </div>
    )
  }
  return <AgentLatest turn={agent.turn} fallback={agent.line} />
}

/** The quick reply: one line, Enter sends. */
export function QuickReply({
  agent,
  reply,
  className,
  style,
  formRef
}: {
  agent: AgentView
  reply: QuickReplyState
  className: string
  style?: React.CSSProperties
  formRef?: (el: HTMLElement | null) => void
}): React.JSX.Element {
  return (
    <form
      ref={formRef}
      className={className}
      style={style}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault()
        reply.send()
      }}
    >
      <input
        type="text"
        value={reply.draft}
        placeholder={`Reply to ${agent.name}…`}
        aria-label={`Quick reply to ${agent.name}`}
        autoComplete="off"
        onChange={(e) => reply.setDraft(e.target.value, (e.nativeEvent as InputEvent).isComposing === true)}
        onCompositionEnd={(e) => reply.setDraft(e.currentTarget.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <button type="submit" aria-label="Send" disabled={!reply.draft.trim()}>
        ➜
      </button>
      {reply.sent !== null && <span className="zv-sent">sent ✓</span>}
    </form>
  )
}
