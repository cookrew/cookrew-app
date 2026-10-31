import { useCallback, useEffect, useState } from 'react'
import { cookrew } from '../api'
import { AgentLatest } from './AgentLatest'
import type { AgentView } from './zoom-model'

/**
 * THE CARD'S WORDS AND ITS REPLY BOX, ONE COPY (owner, 2026-11-01): the zoom
 * view's card (ZoomParts · AgentNode) and the card the agent group floats in
 * a full view (AgentCard.tsx) draw these, so an agent says the same thing and
 * takes a reply the same way wherever its card is.
 */

/** How long a sent reply stands in the card's words. */
const SENT_MS = 4000

export interface QuickReplyState {
  readonly draft: string
  readonly setDraft: (text: string) => void
  /** The reply just sent, for a moment; null otherwise. */
  readonly sent: string | null
  readonly send: () => void
}

export function useQuickReply(agentId: string, onDraft?: (text: string) => void): QuickReplyState {
  const [draft, setDraftState] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  const setDraft = useCallback(
    (text: string) => {
      setDraftState(text)
      onDraft?.(text)
    },
    [onDraft]
  )
  useEffect(() => {
    if (sent === null) return
    const timer = setTimeout(() => setSent(null), SENT_MS)
    return () => clearTimeout(timer)
  }, [sent])
  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    // The same two writes the voice bar makes: the words, then Enter on its own.
    cookrew().ptyInput(agentId, text)
    cookrew().ptyInput(agentId, '\r')
    setDraft('')
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
        onChange={(e) => reply.setDraft(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <button type="submit" aria-label="Send" disabled={!reply.draft.trim()}>
        ➜
      </button>
      {reply.sent !== null && <span className="zv-sent">sent ✓</span>}
    </form>
  )
}
