// The state behind the zoomed card's left rail: what the agent's last reply
// ran at, and the dial turns that have not been answered yet.
//
// THERE IS NO POLL HERE, AND THAT IS STILL THE DESIGN.
//
// The readout is the harness's own record, so between writes to that record
// there is by construction nothing new to read. Every phase change re-reads;
// a timer would ask the same question twelve times a minute and get the same
// answer, on the thread that runs the zoom animation.
//
// WHAT CHANGED: turning a dial is a write we CAUSED, and claude acknowledges
// it in the session file within about a second (`<local-command-stdout>Set
// model to …`). Waiting for the next phase change to notice left the rail
// reading `opus` while the pane plainly said Fable — reported, fairly, as
// "not updating". So an ask arms a SHORT, FINITE chase: a few re-reads over
// the next few seconds, then silence. It is not a poll; it is waiting for one
// specific write we are expecting, and it gives up.

import { useCallback, useEffect, useRef, useState } from 'react'
import { cookrew } from '../api'
import {
  tuneRailView,
  type AgentTuningState,
  type TuneKnob,
  type TuneRailView
} from '../../../shared/agent-tuning'
import type { TurnPhase } from '../../../shared/turn'

/** When to look for the harness's acknowledgment after turning a dial. */
const ACK_CHASE_MS = [400, 1200, 3000]

export interface TuningControls {
  /** Null when this card has no dials to draw at all — see tuneRailView. */
  view: TuneRailView | null
  /** The dial whose list is showing, or null. */
  open: TuneKnob | null
  setOpen: (knob: TuneKnob | null) => void
  turn: (knob: TuneKnob, value: string) => void
  /** Why the last turn was refused; cleared by the next attempt. */
  error: string | null
}

export function useAgentTuning(input: {
  terminalId: string
  phase: TurnPhase
  /** The card is a line into a session at someone else's app. */
  remote: boolean
}): TuningControls {
  const { terminalId, phase, remote } = input
  const [state, setState] = useState<AgentTuningState | null>(null)
  const [open, setOpen] = useState<TuneKnob | null>(null)
  const [error, setError] = useState<string | null>(null)

  const read = useCallback(() => {
    const ask = cookrew().terminalTuning
    // Feature-detected, not assumed. Both real transports implement this —
    // IPC on the desktop, /api/terminal/:id/tuning on the phone — so the
    // absent case is the demo api and any bridge older than the feature.
    if (!ask) {
      setState(null)
      return
    }
    void ask(terminalId)
      .then(setState)
      .catch(() => setState(null))
  }, [terminalId])

  // Mount, and every phase change after it. Listing `phase` is the whole
  // subscription — see the header for why nothing else is needed.
  useEffect(() => {
    read()
  }, [read, phase])

  // A card that changes identity under the same mount must not keep the
  // previous agent's readout on screen while the new one is in flight.
  const shownFor = useRef(terminalId)
  if (shownFor.current !== terminalId) {
    shownFor.current = terminalId
    if (state !== null) setState(null)
    if (open !== null) setOpen(null)
    if (error !== null) setError(null)
  }

  // The chase's timers, cleared on unmount and re-armed by the next ask, so a
  // card closed mid-chase leaves nothing running.
  const chasing = useRef<ReturnType<typeof setTimeout>[]>([])
  const stopChase = useCallback(() => {
    for (const timer of chasing.current) clearTimeout(timer)
    chasing.current = []
  }, [])
  useEffect(() => stopChase, [stopChase, terminalId])

  const turn = useCallback(
    (knob: TuneKnob, value: string) => {
      const apply = cookrew().tuneTerminal
      if (!apply) return
      setOpen(null)
      setError(null)
      void apply(terminalId, knob, value)
        .then((result) => {
          if (!result.ok) setError(result.reason)
          // Re-read either way: a refusal still wants the readout that proves
          // the dial did not move, and an acceptance wants the ask on screen.
          read()
          // Then chase the acknowledgment the harness is about to write. Three
          // tries over three seconds — enough for a TUI to echo a local
          // command, and bounded so a harness that never acknowledges costs
          // three reads rather than a timer for the life of the card.
          stopChase()
          chasing.current = ACK_CHASE_MS.map((delay) => setTimeout(read, delay))
        })
        .catch(() => setError('the app did not answer'))
    },
    [terminalId, read, stopChase]
  )

  return { view: tuneRailView({ state, phase, remote }), open, setOpen, turn, error }
}
