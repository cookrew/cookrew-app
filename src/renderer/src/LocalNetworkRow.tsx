import { useEffect, useState } from 'react'
import { LOCAL_NETWORK_COPY } from './path-copy'
import { localNetworkGate, subscribeLocalNetwork } from './local-network-gate'
import type { LocalNetworkState } from './local-network'

/**
 * ONE LINE UNDER THE BADGE, AFTER THE BROWSER REFUSED THE LOCAL NETWORK.
 *
 * The browser will not re-prompt for a site the reader refused, so the row
 * says where the switch lives instead of offering a button. Every other state
 * draws nothing.
 *
 * THE ALLOW BUTTON IS GONE (2026-11-16). It raised Chrome's prompt with a
 * request to one of the Mac's names under d.cookrew.dev, and those names are
 * gone: the direct path is the WebRTC link (path/rtc-adopt.ts), and there is
 * no address left to aim an ask at.
 */
export function LocalNetworkRow(): React.JSX.Element | null {
  const [state, setState] = useState<LocalNetworkState>(() => localNetworkGate())

  useEffect(() => subscribeLocalNetwork(setState), [])

  if (state !== 'denied') return null
  return (
    <p className="cr-path-ask cr-path-ask-denied" role="status">
      {LOCAL_NETWORK_COPY.denied}
    </p>
  )
}
