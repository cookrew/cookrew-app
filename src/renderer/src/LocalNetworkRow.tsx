import { useEffect, useState } from 'react'
import { LOCAL_NETWORK_COPY } from './path-copy'
import {
  acceptLocalNetwork,
  localNetworkAsked,
  localNetworkGate,
  localNetworkOffered,
  subscribeLocalNetwork
} from './local-network-gate'
import { localNetworkAskRow } from './path/hint-evidence'
import { pathAttempts, subscribePathAttempts, type PathAttempts } from './path-attempts'
import type { LocalNetworkState } from './local-network'

/**
 * ONE LINE UNDER THE BADGE, AND THE ONLY PLACE THE PROMPT IS RAISED FROM.
 *
 * Chrome raises its Local Network Access dialog from the REQUEST, not from an
 * API, so "asking" and "probing" are the same act — which means the moment the
 * companion chooses to probe is the moment a reader is asked for a permission.
 * Doing that on the 60-second timer would put a dialog in front of a phone
 * that is face-down on a table, and an unseen dialog is dismissed, and a
 * dismissal is a refusal that then persists. So the timer never asks
 * (plane-switch.ts) and this row does, once, when somebody presses it.
 *
 * IT IS ONE LINE ON PURPOSE. The alternative — a card, an illustration, a
 * "learn more" — spends the reader's attention on a permission that is worth
 * about 40 ms per request. If they ignore the row, the relay keeps working and
 * nothing is broken; that is the whole reason the ask can be this quiet.
 *
 * AFTER A REFUSAL IT KEEPS TALKING, WITHOUT A BUTTON. The browser will not
 * re-prompt for a site the reader refused, so a second ALLOW would do nothing
 * at all — worse than saying where the switch actually lives.
 *
 * ONE PRESS, AND THE ROW IS GONE (2026-11-02). The press is recorded before the
 * probe goes out (local-network-gate.ts), so the row leaves on the press; what
 * the browser decides afterwards can only bring back the refusal sentence.
 *
 * AND 'prompt' NO LONGER MEANS "ASK" ON ITS OWN. Chrome 152 behind a system
 * proxy (2026-09-08) leaves the permission at 'prompt' for ever while raising
 * no dialog at all, so the LAST RACE decides whether an ask is honest: the rule
 * is in path/hint-evidence.ts, and this component only draws its answer.
 */
export function LocalNetworkRow(): React.JSX.Element | null {
  const [state, setState] = useState<LocalNetworkState>(() => localNetworkGate())
  const [offered, setOffered] = useState(() => localNetworkOffered())
  const [asked, setAsked] = useState(() => localNetworkAsked())
  const [race, setRace] = useState<PathAttempts>(() => pathAttempts())

  useEffect(
    () =>
      subscribeLocalNetwork((next) => {
        setState(next)
        setOffered(localNetworkOffered())
        setAsked(localNetworkAsked())
      }),
    []
  )
  useEffect(() => subscribePathAttempts(setRace), [])

  const row = localNetworkAskRow({ permission: state, offered, asked, attempts: race.attempts })

  if (row.kind === 'hidden') return null
  if (row.kind === 'denied') {
    return (
      <p className="cr-path-ask cr-path-ask-denied" role="status">
        {row.sentence}
      </p>
    )
  }

  return (
    <p className="cr-path-ask" role="status">
      <span className="cr-path-ask-text">{row.sentence}</span>
      <button
        type="button"
        className="cr-btn cr-path-ask-allow"
        onClick={() => {
          // One press, one probe. The press itself takes the row away; the
          // handler then records whatever the browser decided.
          void acceptLocalNetwork()
        }}
      >
        {LOCAL_NETWORK_COPY.allow}
      </button>
    </p>
  )
}
