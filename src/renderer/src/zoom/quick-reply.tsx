import { useCallback, useEffect, useRef, useState } from 'react'
import { AgentLatest } from './AgentLatest'
import { launchRefusal } from '../prompt/launch-gate'
import { AgentFailure } from './AgentFailure'
import { draftKey, getDraft, useDraft } from '../prompt/prompt-draft'
import { noteSent } from '../prompt/input-refused'
import { submitLine, typeLine, useLiveLine } from '../prompt/live-line'
import { usePromptAttach } from '../prompt/use-prompt-attach'
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
/** How long a word about a screenshot that did not attach stands in the box. */
const NOTE_MS = 5000

export interface QuickReplyState {
  readonly draft: string
  /** `composing`: an IME is mid-word, so the agent's line waits for the word. */
  readonly setDraft: (text: string, composing?: boolean) => void
  /** The reply just sent, for a moment; null otherwise. */
  readonly sent: string | null
  /** Resolves with why the words stayed in the box, else null. */
  readonly send: (offline: boolean) => Promise<string | null>
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
  /** One send at a time: a double tap over a slow link must not send twice. */
  const sending = useRef(false)
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
  /** The refusal when the words stayed in the box, else null. */
  const send = async (offline: boolean): Promise<string | null> => {
    if (sending.current || !draft.trim()) return null
    sending.current = true
    try {
      const refusal = offline ? await launchRefusal(agentId) : null
      if (refusal) return refusal
      // Read now: the check can take a relay's round trip, and words go on being typed.
      const text = getDraft(draftKey(agentId)).trim()
      if (!text) return null
      noteSent({ id: agentId, box: draftKey(agentId), words: text, at: Date.now() })
      submitLine(agentId, text)
      onDraft?.('')
      setSent(text)
      return null
    } finally {
      sending.current = false
    }
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
  if (agent.failure) return <AgentFailure failure={agent.failure} />
  return <AgentLatest turn={agent.turn} fallback={agent.line} />
}

/** The quick reply: one line, Enter sends; a screenshot pasted or dropped goes in as its path. */
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
  const inputRef = useRef<HTMLInputElement>(null)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    if (note === null) return
    const timer = setTimeout(() => setNote(null), NOTE_MS)
    return () => clearTimeout(timer)
  }, [note])
  const attach = usePromptAttach({ draftKey: draftKey(agent.id), write: reply.setDraft, inputRef, onError: setNote })
  return (
    <form
      ref={formRef}
      className={className}
      style={style}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onDragOver={attach.onDragOver}
      onDrop={attach.onDrop}
      onSubmit={(e) => {
        e.preventDefault()
        void reply.send(agent.status === 'offline').then((refusal) => {
          if (refusal) setNote(refusal)
        })
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={reply.draft}
        placeholder={agent.failure?.blocked ? `${agent.name} could not start` : `Reply to ${agent.name}…`}
        aria-label={`Quick reply to ${agent.name}`}
        autoComplete="off"
        onChange={(e) => reply.setDraft(e.target.value, (e.nativeEvent as InputEvent).isComposing === true)}
        onCompositionEnd={(e) => reply.setDraft(e.currentTarget.value)}
        onKeyDown={(e) => e.stopPropagation()}
        onPaste={attach.onPaste}
      />
      <button type="submit" aria-label="Send" disabled={!reply.draft.trim()}>
        ➜
      </button>
      {reply.sent !== null && <span className="zv-sent">sent ✓</span>}
      {attach.attaching ? (
        <span className="zv-sent zv-attach-note" role="status">
          attaching…
        </span>
      ) : (
        note !== null && (
          <span className="zv-sent zv-attach-note failed" role="alert" title={note}>
            {note}
          </span>
        )
      )}
    </form>
  )
}
