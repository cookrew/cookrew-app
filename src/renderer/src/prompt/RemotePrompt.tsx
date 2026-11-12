import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { CrIcon } from '../icons'
import { InkAvatar } from '../zoom/InkAvatar'
import { remoteAgentView, sendRefusal } from '../zoom/remote-machine'
import { remoteDraft, remotePlace, setRemoteDraft, useRemoteSeen, type RemotePlace } from '../zoom/remote-machine-store'
import { remoteBoxCall, remoteBoxDraftKey, remoteBoxPlaceholder, remoteBoxShut, remoteBoxTarget } from '../zoom/remote-prompt'
import { callRemote } from '../zoom/use-remote-machine'
import { enterOpensBox } from './enter-opens'
import { useFaceSlot } from './face-slot'
import { listenFoldPress } from './fold-press'
import { boxFold, promptFold, usePromptOpen } from './prompt-fold'
import { PromptFace, RemoteMark, type FaceAgent } from './PromptFace'
import { SentToast, pressKey, useSentToast } from './SentToast'
import './global-prompt.css'

/**
 * THE BAR'S BOX INSIDE ANOTHER MACHINE (owner 2026-11-12: "this part should be
 * handed back to the bar; the whole interaction should stay the same").
 *
 * The same box as this machine's (GlobalPrompt.tsx), drawn by the same parts:
 * folded into its face at the bar's end, a tap or Enter opens it, Esc or a press elsewhere folds it, the words kept as
 * its draft; with an agent's card open it stays open on that agent. Its words
 * go to that machine (zoom/remote-prompt.ts): to the agent whose card is open,
 * else to a new agent in the workspace stood in. The stage draws no box of its
 * own (RemoteMachineView.tsx).
 *
 * What only this machine has is left out: the harness and model pick (that
 * machine starts its own default), "@" and "#", pictures, the ear.
 */

const readPlace = (): RemotePlace => remotePlace.get()

export function RemotePrompt(): React.JSX.Element | null {
  const place = useSyncExternalStore(remotePlace.subscribe, readPlace, readPlace)
  const seen = useRemoteSeen()
  const machine = place.machine
  const target = remoteBoxTarget(place, seen.front, seen.cards)
  const box = remoteBoxDraftKey(target)
  const [text, setText] = useState(() => (machine && box ? remoteDraft(machine.id, box) : ''))
  useEffect(() => setText(machine && box ? remoteDraft(machine.id, box) : ''), [machine?.id, box])
  const write = (next: string): void => {
    setText(next)
    if (machine && box) setRemoteDraft(machine.id, box, next)
  }
  // The box the view stands at NOW: a send that comes back after a move touches only its own words.
  const boxNow = useRef<string | null>(box)
  boxNow.current = box
  const [busy, setBusy] = useState(false)
  // One send at a time, held in a ref: a second Enter in the same beat finds it taken.
  const sending = useRef(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setError(null), [box])
  const toast = useSentToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const sendRef = useRef<HTMLButtonElement>(null)

  // THE FOLD, as this machine's box folds (prompt-fold.ts). Always at the bar's end: inside
  // another machine an item is a stop like the others, not a full view with the bar moved away.
  const faceSlot = useFaceSlot()
  const open = usePromptOpen()
  const agentCard = target.kind === 'agent' ? target.card : null
  const { canFold, folded, overBar } = boxFold({ place: 'bar', slot: faceSlot !== null, pinned: agentCard !== null, open })
  useEffect(() => promptFold.setFoldable(canFold), [canFold])
  useEffect(
    () => () => {
      promptFold.setFoldable(false)
      promptFold.fold()
    },
    []
  )
  useLayoutEffect(() => {
    const body = document.body.classList
    body.toggle('cr-prompt-folded', folded)
    body.toggle('cr-prompt-open', overBar)
    return () => {
      body.remove('cr-prompt-folded')
      body.remove('cr-prompt-open')
    }
  }, [folded, overBar])
  const openBox = (): void => {
    flushSync(() => promptFold.open())
    inputRef.current?.focus()
  }
  // Enter opens it while nothing that takes keys has them (enter-opens.ts).
  useEffect(() => {
    if (!folded) return
    const onKey = (e: KeyboardEvent): void => {
      if (!enterOpensBox(e, e.target instanceof Element ? e.target : null)) return
      if (document.querySelector('[aria-modal="true"]')) return
      e.preventDefault()
      openBox()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [folded])
  // A press anywhere else folds it (fold-press.ts).
  useEffect(() => {
    if (!canFold || folded) return
    return listenFoldPress(window, { onFold: () => promptFold.fold() })
  }, [canFold, folded])
  // An error must be seen: it lives in the box, so the box opens.
  useEffect(() => {
    if (error && canFold) promptFold.open()
  }, [error, canFold])

  if (!machine) return null

  const view = agentCard ? remoteAgentView(agentCard) : null
  const face: FaceAgent | null = agentCard && view ? { id: agentCard.id, name: agentCard.name, preset: agentCard.preset, orch: agentCard.orch, status: view.status } : null
  const harness = agentCard?.preset || 'claude'
  const shut = remoteBoxShut(target)
  const call = remoteBoxCall(target, text)
  const canSend = call !== null && !busy

  const send = async (): Promise<void> => {
    if (!call || !box || sending.current) return
    sending.current = true
    pressKey(sendRef.current)
    setBusy(true)
    setError(null)
    const from = { machine: machine.id, box, words: text.trim(), who: agentCard ? agentCard.name : `New agent on ${machine.name}` }
    try {
      const refusal = sendRefusal(await callRemote(from.machine, 'POST', call.route, call.body), machine.name)
      // Moved on meanwhile: the box on show is another's, and its words and its line are its own.
      const here = boxNow.current === from.box
      // The words leave the box only once that machine took them.
      if (refusal) {
        if (here) setError(refusal)
        return
      }
      setRemoteDraft(from.machine, from.box, '')
      if (here) setText('')
      toast.leave(from.who, from.words)
      seen.refresh()
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  const who = agentCard ? `${agentCard.name} on ${machine.name}` : target.kind === 'new' ? `a new agent on ${machine.name}` : machine.name
  const foldedFace = (
    <PromptFace
      agent={face}
      harness={harness}
      mode="folded"
      draft={text !== ''}
      remote
      label={agentCard ? `Reply to ${who}` : target.kind === 'new' ? `New agent on ${machine.name}` : `Asking ${machine.name}`}
      tip={
        target.kind === 'none' ? (
          <>Asking <b>{machine.name}</b>…</>
        ) : (
          <>
            {agentCard ? 'Reply to' : 'New agent on'} <b>{agentCard ? agentCard.name : machine.name}</b> · click, or press <kbd>⏎</kbd>
          </>
        )
      }
      onTap={openBox}
    />
  )

  return (
    <>
      {folded && faceSlot && createPortal(foldedFace, faceSlot)}
      <form
        className={`cr-prompt cr-prompt-remote${agentCard ? ' to-agent' : ' to-new'}${folded ? ' folded' : ''}`}
        aria-label={`Prompt ${who}`}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && promptFold.backFirst()) e.stopPropagation()
        }}
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        {agentCard && face ? (
          <span className="cr-prompt-to pf-chip" title={`Prompts go to ${who}`}>
            <span className="pf-chip-who">
              <span className="pf-chip-face">
                <InkAvatar id={face.id} preset={face.preset} orch={face.orch} status={face.status} weight="regular" />
                <RemoteMark />
              </span>
              <b>{face.name}</b>
            </span>
          </span>
        ) : (
          <span className="cr-prompt-new">
            <span className="cr-prompt-harness" title={`Starts on ${machine.name}, with its own default`}>
              <span className="pf-chip-face pf-new">
                <InkAvatar id={`new:${machine.id}`} preset={harness} status="idle" weight="regular" />
                <RemoteMark />
              </span>
              <span>＋ {machine.name}</span>
            </span>
          </span>
        )}
        <input
          ref={inputRef}
          type="text"
          value={text}
          placeholder={remoteBoxPlaceholder(target, machine.name)}
          aria-label={`Prompt ${who}`}
          autoComplete="off"
          disabled={busy || shut || target.kind === 'none'}
          onChange={(e) => write(e.target.value)}
          onKeyDown={(e) => {
            // The zoom's keys (Esc steps out) are not this box's.
            e.stopPropagation()
            if (e.key === 'Enter' && !canSend) e.preventDefault()
            if (e.key === 'Escape') {
              e.currentTarget.blur()
              if (canFold) promptFold.fold()
            }
          }}
        />
        <button type="submit" className="cr-btn sm primary" ref={sendRef} title={agentCard ? 'Send (Enter)' : 'Start the agent (Enter)'} aria-label="Send" disabled={!canSend}>
          <CrIcon name="send" />
        </button>
        <SentToast sent={toast.sent} />
        {error && (
          <span className="cr-prompt-error" role="alert" title={error}>
            {error}
          </span>
        )}
      </form>
    </>
  )
}
