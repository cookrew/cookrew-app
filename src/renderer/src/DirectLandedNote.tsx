import { useEffect, useState } from 'react'
import { dismissLandedNote, landedDirect, subscribeLandedNote } from './landed-note'
import { DIRECT_OFFER_COPY } from './path-copy'

/**
 * ONE LINE ON THE PAGE THE OPEN ON WI-FI BUTTON LANDED ON.
 *
 * The phone that pressed that button is now at `192-168-2-40.<id>.d.
 * cookrew.dev:8643` — an address it did not type — and the cookrew.dev URL it
 * knows has gone from the bar, taken off by the same boot that took the token
 * off (auth-gate.ts). Without a sentence that reads as the app having wandered
 * off somewhere, and the reader's next move is to type the old URL back in and
 * undo the fix.
 *
 * IT PROMISES THE OLD ADDRESS STILL WORKS, which is the actual anxiety. The
 * relay is not lost and nothing was traded away; this is the fast path when
 * the phone is on the same Wi-Fi, and the other one is still there when it is
 * not.
 *
 * DISMISSABLE AND ALREADY ONE-SHOT. `from=relay` is scrubbed with the token,
 * so a reload cannot raise it again — the button is there for the reader who
 * wants the line gone now rather than as the only way to ever be rid of it.
 */
export function DirectLandedNote(): React.JSX.Element | null {
  const [shown, setShown] = useState(() => landedDirect())

  useEffect(() => subscribeLandedNote(setShown), [])

  if (!shown) return null

  return (
    <p className="cr-path-ask cr-path-landed" role="status">
      <span className="cr-path-ask-text">{DIRECT_OFFER_COPY.landed}</span>
      <button
        type="button"
        className="cr-btn cr-path-landed-ok"
        onClick={() => dismissLandedNote()}
      >
        {DIRECT_OFFER_COPY.dismiss}
      </button>
    </p>
  )
}
