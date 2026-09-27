// The state behind the zoomed card's left rail: what the agent's last reply
// ran at, and the dial turns that have not been answered yet.
//
// THERE IS NO POLL HERE, AND THAT IS THE DESIGN.
//
// The readout is the harness's own record, and that record only gains a new
// reading when a reply is written to it. So the reply IS the event: every
// phase change re-reads, and between phase changes there is by construction
// nothing new to read. A timer would ask a 256 KB tail the same question
// twelve times a minute and get the same answer, on the thread that runs the
// zoom animation.
//
// The cost of having no timer is that an ask stays ASKED until the agent next
// replies. That is not a lag, it is the truth: nothing has confirmed it.

import { useCallback, useEffect, useRef, useState } from 'react'
import { cookrew } from '../api'
import {
  tuneRailView,
  type AgentTuningState,
  type TuneKnob,
  type TuneRailView
} from '../../../shared/agent-tuning'
import type { TurnPhase } from '../../../shared/turn'

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
    // Feature-detected, not assumed: the remote (phone) api carries no dials
    // on purpose, and a bridge from before this feature carries none either.
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
        })
        .catch(() => setError('the app did not answer'))
    },
    [terminalId, read]
  )

  return { view: tuneRailView({ state, phase, remote }), open, setOpen, turn, error }
}
