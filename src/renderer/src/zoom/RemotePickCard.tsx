import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cardScaleStyle, useCardScale } from './AgentCard'
import { InkAvatar } from './InkAvatar'
import { RemoteCardView } from './RemoteCardView'
import { replyCall, sendRefusal } from './remote-machine'
import { remoteDraft, setRemoteDraft, type RemoteMachineRef } from './remote-machine-store'
import { useFloatSpot, useOutsidePress } from './ShelfCard'
import { callRemote, useRemoteCards } from './use-remote-machine'
import type { AgentView } from './zoom-model'
import '../pets/pets.css'
import './remote-machine.css'
import './devices-agents.css'

/**
 * AN AGENT OF ANOTHER MACHINE, POPPED ON THE DEVICES STOP (owner, 2026-11-17:
 * the agent the keys stand on pops its card for a quick reply, across devices).
 * The card that machine's own stage draws (RemoteCardView: its latest reply
 * whole, the menu it waits on, its browsers and notes), read for as long as it
 * is up, and under it a reply box that sends as the bar's box does inside that
 * machine (prompt/RemotePrompt.tsx): the words to the agent, or into the
 * menu's row for words; with a menu that has none, the rows on the card answer.
 * The words are that machine's draft for this agent, kept when the card goes.
 */

/** How long a sent reply's word stands. */
const SENT_MS = 4000

/**
 * Replies on their way, by machine and agent: not the mounted card's, which the keys can
 * leave and come back to before an answer lands (a second Enter must not send it again).
 */
const inFlight = new Set<string>()
/** Cards to tell when a send settles: one that came back meanwhile shows the draft as it is now. */
const settled = new Set<(key: string) => void>()

export function RemotePickCard({ machine, workspace, agent, anchor, onOpen, onOutside, onClose }: {
  machine: RemoteMachineRef
  workspace: string
  /** The agent as the fleet seats it: drawn until the card itself is read. */
  agent: AgentView
  anchor: HTMLElement | null
  /** Into that machine, at this agent. */
  onOpen: () => void
  onOutside: (target: EventTarget | null) => boolean
  onClose: () => void
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const size = useCardScale()
  const spot = useFloatSpot(box, anchor, size.scale, `${machine.id}|${agent.id}`)
  const { cards, answering, refresh } = useRemoteCards(machine.id, workspace, agent.id)
  const card = cards?.cards.find((one) => one.id === agent.id) ?? null
  const [text, setText] = useState(() => remoteDraft(machine.id, agent.id))
  const [note, setNote] = useState<{ words: string; failed: boolean } | null>(null)
  const flightKey = `${machine.id}|${agent.id}`
  const [busy, setBusy] = useState(() => inFlight.has(flightKey))
  useOutsidePress(box, () => text.trim() !== '', onOutside, onClose)
  useEffect(() => {
    const hear = (key: string): void => {
      if (key !== flightKey) return
      setText(remoteDraft(machine.id, agent.id))
      setBusy(false)
    }
    settled.add(hear)
    return () => void settled.delete(hear)
  }, [flightKey, machine.id, agent.id])
  useEffect(() => {
    if (!note) return undefined
    const timer = window.setTimeout(() => setNote(null), SENT_MS)
    return () => window.clearTimeout(timer)
  }, [note])

  const write = (words: string): void => {
    setText(words)
    setRemoteDraft(machine.id, agent.id, words)
  }
  const call = card ? replyCall(card, text) : null
  // A menu with no row for words takes none: its rows on the card answer it.
  const shut = card !== null && replyCall(card, 'x') === null
  const send = async (): Promise<void> => {
    if (!call || inFlight.has(flightKey)) return
    inFlight.add(flightKey)
    setBusy(true)
    try {
      const refusal = sendRefusal(await callRemote(machine.id, 'POST', call.route, call.body), machine.name)
      if (refusal) return setNote({ words: refusal, failed: true })
      // Out of the draft whichever card is up now (settled tells it).
      setRemoteDraft(machine.id, agent.id, '')
      setNote({ words: 'sent ✓', failed: false })
      refresh()
    } finally {
      inFlight.delete(flightKey)
      for (const hear of settled) hear(flightKey)
    }
  }
  const placeholder = shut ? `Answer ${agent.name}’s menu on the card` : card?.choice ? `Type the answer for ${agent.name}…` : `Reply to ${agent.name} on ${machine.name}…`

  return createPortal(
    <div
      ref={box}
      className={`cr-pet-card ag-ink zv-shelf-card zv-pick-card zv-pick-remote${(card?.status ?? agent.phase) === 'waiting' ? ' needs' : ''}`}
      role="dialog"
      aria-label={`${agent.name}'s card on ${machine.name}`}
      style={{ ...cardScaleStyle(size), ...(spot ? { left: spot.left, top: spot.top } : { left: 0, top: 0, visibility: 'hidden' }) }}
    >
      {card ? (
        <RemoteCardView machine={machine} card={card} onItem={onOpen} onSent={refresh} />
      ) : (
        <article className="rm-card" aria-label={`${agent.name} on ${machine.name}`}>
          <header className="rm-head">
            <InkAvatar id={agent.id} preset={agent.preset} orch={agent.orch} status={agent.status} weight="large" />
            <div>
              <b>{agent.name}</b>
              <small><span className={`zv-st ${agent.status}`}>{agent.word}</span> on {machine.name}</small>
            </div>
          </header>
          <p className="rm-note" role="status">{answering ? `Asking ${machine.name}…` : `${machine.name} isn’t answering.`}</p>
        </article>
      )}
      <form
        className="zv-reply zv-pick-reply"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <input
          type="text"
          value={text}
          placeholder={placeholder}
          aria-label={`Quick reply to ${agent.name} on ${machine.name}`}
          autoComplete="off"
          disabled={shut}
          onChange={(e) => write(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <button type="submit" aria-label="Send" disabled={!call || busy}>
          ➜
        </button>
        {note && <span className={`zv-sent${note.failed ? ' zv-attach-note failed' : ''}`} role={note.failed ? 'alert' : 'status'} title={note.words}>{note.words}</span>}
      </form>
      <button type="button" className="zv-pick-open" onClick={onOpen}>
        Open on {machine.name} ›
      </button>
    </div>,
    document.body
  )
}
