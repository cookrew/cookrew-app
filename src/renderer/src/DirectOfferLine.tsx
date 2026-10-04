import { useEffect, useState } from 'react'
import { openDirectly } from './DirectOfferRow'
import {
  directOffer,
  directOfferLineHidden,
  hideDirectOfferLine,
  subscribeDirectOffer
} from './direct-offer-gate'
import { DIRECT_OFFER_COPY, directOfferLine } from './path-copy'
import type { DirectOffer } from './path/direct-offer'

/**
 * ONE LINE UNDER THE BADGE, FOR THE PHONE WHOSE BROWSER REFUSES BY RULE.
 *
 * THE SCREENSHOT (2026-10-04): the bar said RELAY, the sheet said 845 ms and
 * "your Mac is not on this network", and the one button that works on that
 * phone — OPEN ON WI-FI — sat two taps down under a headline that blamed the
 * Mac. The reader was on the Mac's own Wi-Fi.
 *
 * SO THE REFUSAL CASE GETS THE ASK'S SLOT. LocalNetworkRow hangs the Local
 * Network ask under the badge because "a permission nobody knows to look for
 * is a permission nobody grants"; the same is true of a path. The slot is
 * free exactly when this renders: a 'blocked' offer is only ever made on a
 * browser with no permission to ask for (path/direct-offer.ts), and the ask
 * draws nothing there.
 *
 * ONLY FOR A REFUSAL. A timeout may be a Mac that is asleep, and a line that
 * nagged about every sleeping Mac would be dismissed by reflex. A refusal in
 * 4 ms is the browser's rule and will read the same on every race; it is the
 * one case where the bar should say so without being asked.
 *
 * STILL A PRESS. The automatic gates in companion-relay-no-jump.test.ts are
 * untouched: nothing here fires without a finger, and the credential is read
 * at the tap by the same `openDirectly` the sheet's row uses.
 *
 * DISMISSABLE, for the session and for this offer (direct-offer-gate.ts). The
 * sheet keeps its row either way, so the fix is never further than the badge.
 */
export function DirectOfferLine(): React.JSX.Element | null {
  const [offer, setOffer] = useState<DirectOffer | null>(() => directOffer())
  const [hidden, setHidden] = useState(() => directOfferLineHidden())

  useEffect(
    () =>
      subscribeDirectOffer((next) => {
        setOffer(next)
        setHidden(directOfferLineHidden())
      }),
    []
  )

  if (!offer || hidden || offer.reason !== 'blocked') return null

  return (
    <p className="cr-path-ask cr-path-direct-line" role="status">
      <span className="cr-path-ask-text">{directOfferLine(offer.family)}</span>
      <span className="cr-path-direct-acts">
        <button type="button" className="cr-btn cr-path-direct-go" onClick={() => openDirectly(offer)}>
          {offer.kind === 'lan' ? DIRECT_OFFER_COPY.lan : DIRECT_OFFER_COPY.tailnet}
        </button>
        <button
          type="button"
          className="cr-btn cr-path-direct-hide"
          onClick={() => hideDirectOfferLine()}
        >
          {DIRECT_OFFER_COPY.dismiss}
        </button>
      </span>
    </p>
  )
}
