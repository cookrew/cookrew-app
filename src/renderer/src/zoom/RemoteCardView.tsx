import { useEffect, useId, useRef, useState } from 'react'
import { choiceSig, hasWordsRow, staysOpen, type MenuAct } from '../../../shared/wait-choice'
import { AgentLatest } from './AgentLatest'
import { InkAvatar } from './InkAvatar'
import { NOTE_GLYPH } from './ZoomParts'
import { WaitBrief, WaitReviewList, WaitRows, WaitSteps } from '../prompt/WaitChoices'
import { menuCall, remoteAgentView, replyCall, sendRefusal, stopCall, type CardCall, type RemoteCard, type RemoteItem } from './remote-machine'
import { remoteDraft, setRemoteDraft, type RemoteMachineRef } from './remote-machine-store'
import { callRemote, REMOTE_PEEK_MS, useRemotePicture } from './use-remote-machine'
import '../prompt/wait-choices.css'
import './agent-card.css'

/**
 * AN AGENT'S CARD ON ANOTHER MACHINE (owner 2026-11-10, design B): the face,
 * the name and state, its latest reply whole, the menu it waits on with the
 * same rows as this machine's own (prompt/WaitChoices.tsx), its browsers and
 * notes, and a box that says which machine it sends to. Everything it sends
 * goes the way a phone's would on that machine: /input, the checked menu
 * answer, Esc for a stop.
 */

/** How long a picked row stands filled before the next read shows what the agent did. */
const FILL_MS = 600
/** How long a word about what was sent stands. */
const NOTE_MS = 4000

const THUMB_W = 320

function useNote(): [{ text: string; failed: boolean } | null, (text: string, failed: boolean) => void] {
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const say = (text: string, failed: boolean): void => {
    setNote({ text, failed })
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setNote(null), NOTE_MS)
  }
  return [note, say]
}

function Thumb({ machine, item, onOpen }: { machine: RemoteMachineRef; item: RemoteItem; onOpen: () => void }): React.JSX.Element {
  const { src } = useRemotePicture(machine.id, item.kind === 'browser' ? item.id : null, THUMB_W, true, REMOTE_PEEK_MS)
  // A picture that does not decode is no picture: the coin's letter stands instead.
  const [broken, setBroken] = useState<string | null>(null)
  return (
    <button type="button" className="rm-thumb" title={item.title} aria-label={`Open ${item.kind}: ${item.title}`} onClick={onOpen}>
      {src && src !== broken ? <img src={src} alt="" onError={() => setBroken(src)} /> : <i className="rm-glyph" style={{ background: item.kind === 'browser' ? item.tint || 'var(--zv-ink-soft)' : 'var(--zv-ink-soft)' }}>{item.kind === 'note' ? NOTE_GLYPH : item.initial}</i>}
      <span>{item.kind === 'note' ? 'note' : item.host || 'browser'} · {item.title}</span>
    </button>
  )
}

export function RemoteCardView({ machine, card, onItem, onSent }: {
  machine: RemoteMachineRef
  card: RemoteCard
  onItem: (item: RemoteItem) => void
  /** Something went to the machine: read it again now. */
  onSent: () => void
}): React.JSX.Element {
  const view = remoteAgentView(card)
  const qid = useId()
  const [words, setWords] = useState(() => remoteDraft(machine.id, card.id))
  const [note, say] = useNote()
  const [sent, setSent] = useState<{ sig: string; index: number; at: number } | null>(null)
  const busy = useRef(false)
  const choice = card.choice
  const shownSent = choice && sent && sent.sig === choiceSig(choice) && Date.now() - sent.at < FILL_MS * 4 ? sent.index : null

  // A finished reply is read once its card is open, as on the machine itself.
  const seenDone = useRef<string | null>(null)
  useEffect(() => {
    if (card.status !== 'done' || seenDone.current === card.id) return
    seenDone.current = card.id
    void callRemote(machine.id, 'POST', `api/terminal/${encodeURIComponent(card.id)}/seen`)
  }, [card.status, card.id, machine.id])

  const write = (text: string): void => {
    setWords(text)
    setRemoteDraft(machine.id, card.id, text)
  }

  /** One send at a time; the answer, or why not, in words. */
  const deliver = async (call: CardCall, done: string): Promise<boolean> => {
    if (busy.current) return false
    busy.current = true
    try {
      const refusal = sendRefusal(await callRemote(machine.id, 'POST', call.route, call.body), machine.name)
      say(refusal ?? done, refusal !== null)
      onSent()
      return refusal === null
    } finally {
      busy.current = false
    }
  }

  const answer = (act: MenuAct, index: number): void => {
    if (!choice) return
    if (act.kind === 'row' && !staysOpen(choice.options[index])) setSent({ sig: choiceSig(choice), index, at: Date.now() })
    void deliver(menuCall(card, choice, act), `Answered on ${machine.name}.`).then((ok) => {
      if (!ok) setSent(null)
    })
  }

  const wordsGoToMenu = choice !== null && hasWordsRow(choice)
  const boxShut = choice !== null && !wordsGoToMenu
  const send = async (): Promise<void> => {
    const call = replyCall(card, words)
    // The words leave the box only once the machine took them.
    if (call && (await deliver(call, `Sent to ${card.name} on ${machine.name}.`))) write('')
  }

  return (
    <article className="rm-card" aria-label={`${card.name} on ${machine.name}`}>
      <header className="rm-head">
        <InkAvatar id={card.id} preset={card.preset} orch={card.orch} status={view.status} weight="large" />
        <div>
          <b>{card.name}</b>
          <small><span className={`zv-st ${view.status}`}>{card.word}</span> on {machine.name}</small>
        </div>
        {card.status === 'working' && (
          <button type="button" className="rm-stop" onClick={() => void deliver(stopCall(card), `Stopped on ${machine.name}.`)}>
            Stop
          </button>
        )}
      </header>
      <div className="rm-words">
        <AgentLatest turn={view.turn} fallback={view.line || 'Ready'} />
      </div>
      {choice && (
        <div className="rm-menu" role="group" aria-labelledby={qid}>
          <p className="wc-q" id={qid}>{choice.question}</p>
          <WaitSteps choice={choice} onStep={(dir) => answer({ kind: 'step', dir }, -1)} />
          <WaitBrief choice={choice} />
          <WaitReviewList choice={choice} />
          <WaitRows view={{ choice, sent: shownSent }} onAnswer={(index) => answer(index === choice.escIndex ? { kind: 'esc' } : { kind: 'row', index }, index)} />
        </div>
      )}
      {card.items.length > 0 && (
        <div className="rm-thumbs">
          {card.items.map((item) => <Thumb key={item.id} machine={machine} item={item} onOpen={() => onItem(item)} />)}
        </div>
      )}
      <form className="rm-box" onSubmit={(e) => { e.preventDefault(); void send() }}>
        <input
          value={words}
          disabled={boxShut}
          onChange={(e) => write(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder={boxShut ? 'Answer its menu above first' : wordsGoToMenu ? `Type the answer for ${card.name} on ${machine.name}…` : `Reply to ${card.name} on ${machine.name}…`}
          aria-label={`Reply to ${card.name} on ${machine.name}`}
          autoComplete="off"
        />
        <button type="submit" disabled={boxShut || !words.trim()}>Send</button>
      </form>
      <p className={`rm-note${note?.failed ? ' failed' : ''}`} role="status">{note?.text ?? ''}</p>
    </article>
  )
}
