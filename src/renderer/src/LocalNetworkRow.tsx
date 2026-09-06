import { useEffect, useState } from 'react'
import { LOCAL_NETWORK_COPY } from './path-copy'
import {
  acceptLocalNetwork,
  localNetworkGate,
  localNetworkOffered,
  subscribeLocalNetwork
} from './local-network-gate'
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
 */
export function LocalNetworkRow(): React.JSX.Element | null {
  const [state, setState] = useState<LocalNetworkState>(() => localNetworkGate())
  const [offered, setOffered] = useState(() => localNetworkOffered())
  const [asking, setAsking] = useState(false)

  useEffect(
    () =>
      subscribeLocalNetwork((next) => {
        setState(next)
        setOffered(localNetworkOffered())
      }),
    []
  )

  if (state === 'denied') {
    return (
      <p className="cr-path-ask cr-path-ask-denied" role="status">
        {LOCAL_NETWORK_COPY.denied}
      </p>
    )
  }
  // Nothing to ask (granted, or a browser that never prompts), or nowhere yet
  // to point the ask. Both render nothing rather than a disabled control.
  if (state !== 'prompt' || !offered) return null

  return (
    <p className="cr-path-ask" role="status">
      <span className="cr-path-ask-text">{LOCAL_NETWORK_COPY.ask}</span>
      <button
        type="button"
        className="cr-btn cr-path-ask-allow"
        disabled={asking}
        onClick={() => {
          // One press, one probe. The store is updated by the handler with
          // whatever the browser decided, and this row re-renders out of
          // existence on a grant.
          setAsking(true)
          void acceptLocalNetwork().finally(() => setAsking(false))
        }}
      >
        {LOCAL_NETWORK_COPY.allow}
      </button>
    </p>
  )
}
