import { useState } from 'react'
import type { TerminalActivity } from '../../shared/turn'
import { MKT_GATE } from '../../shared/marketplace-copy'
import { cookrew } from './api'
import { CrIcon } from './icons'

/** Only product-approved gate voices may cross from transport stdout to pixels. */
export function servedGateReply(reply: string | null | undefined): string | null {
  if (!reply) return null
  for (const copy of [
    MKT_GATE['mkt.gate.payment.unavailable'],
    MKT_GATE['mkt.gate.payment.unverifiable']
  ]) {
    if (reply.includes(copy)) return copy
  }
  return null
}

/**
 * LIVE seam for a placed crew. The durable/streaming body is still rendered by
 * TranscriptView above; this replaces crew-line's stdout REPL with the prompt
 * composer and an honest pre-trace warming state.
 */
export function ServedCrewLive({
  terminalId,
  activity,
  hasTranscript
}: {
  terminalId: string
  activity: TerminalActivity | undefined
  hasTranscript: boolean
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const busy = activity?.phase === 'thinking' || activity?.phase === 'waiting'
  const gateReply = servedGateReply(activity?.reply)

  const submit = (): void => {
    const prompt = draft.trim()
    if (!prompt || busy) return
    setDraft('')
    // One transport write: companion-mode POSTs are asynchronous, so splitting
    // prompt and Enter could let the Enter overtake the text on the network.
    cookrew().ptyInput(terminalId, `${prompt}\r`)
  }

  return (
    <div className="served-live-turn">
      {!hasTranscript && activity?.prompt && (
        <div className="served-live-prompt">{activity.prompt}</div>
      )}
      {!hasTranscript && gateReply && (
        <div className="served-live-reply">{gateReply}</div>
      )}
      <div className={`served-live-state${busy ? ' busy' : ''}`} role="status" aria-live="polite">
        <span className="served-live-dot" />
        {busy && !hasTranscript ? 'LIVE · LINE WARMING' : busy ? 'LIVE · RECEIVING' : 'LIVE'}
      </div>
      <div className="served-live-compose-row">
        <textarea
          className="served-live-input"
          aria-label="Ask this crew"
          rows={3}
          value={draft}
          autoFocus
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey) return
            event.preventDefault()
            submit()
          }}
        />
        <button
          className="cr-btn sm primary icon served-live-send"
          aria-label="Send"
          title="Send"
          disabled={busy || !draft.trim()}
          onClick={submit}
        >
          <CrIcon name="send" />
        </button>
      </div>
    </div>
  )
}
