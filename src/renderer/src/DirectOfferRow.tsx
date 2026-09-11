import { useEffect, useRef, useState } from 'react'
import { authStore } from './auth-gate'
import { directOffer, subscribeDirectOffer } from './direct-offer-gate'
import { retryPath } from './path-retry-gate'
import { DIRECT_OFFER_COPY, directOfferWhy } from './path-copy'
import { directNavigationUrl, type DirectOffer } from './path/direct-offer'

/**
 * ONE SENTENCE AND ONE BUTTON, ABOVE THE ATTEMPTS IN THE BADGE'S SHEET.
 *
 * ABOVE THEM BECAUSE THE ROWS ARE EVIDENCE AND THIS IS THE CONCLUSION. A
 * reader who has opened the sheet is already looking at four LAN addresses
 * that timed out; making them scroll past the diagnosis to reach the fix would
 * be filing the answer under the symptom.
 *
 * IT IS THE ONLY PLACE IN THE COMPANION THAT NAVIGATES UNDER A RELAY BASE.
 * Every automatic path — the 60-second race, `online`, a tab coming back, the
 * boot — is still forbidden from touching the address bar, and
 * companion-relay-no-jump.test.ts still asserts exactly that. The exception is
 * this handler, it fires from a press, and the reason it exists at all is in
 * the docblock of path/direct-offer.ts: no browser on iOS or iPadOS has a
 * local-network permission to grant, so a fetch from cookrew.dev to the Mac
 * can never succeed while a navigation to the same trusted name always can.
 *
 * TWO BUTTONS, IN THE ORDER THE SENTENCE NAMES THEM. TRY AGAIN re-runs the
 * race the switcher already owns (path-retry-gate.ts) and is the cheaper of
 * the two answers: a Mac that was asleep, a card that lagged a network hop, a
 * Wi-Fi that had just changed under the phone — all of those answer on the
 * next pass and none of them needs a page load. Leaving the page is the
 * second answer because it is the irreversible-looking one.
 *
 * THE PRESS WAITS, AND SAYS SO. A race is up to a second of probes; a button
 * that went back to its resting state immediately would read as a button that
 * did nothing, which is the failure this whole panel exists to end. It also
 * gives up waiting after RETRY_SAFETY_MS, because a switcher that was torn
 * down mid-press would otherwise leave TRYING… on the screen for ever.
 */
/** How long TRY AGAIN waits for a race that may never report back. */
export const RETRY_SAFETY_MS = 6000

export function DirectOfferRow(): React.JSX.Element | null {
  const [offer, setOffer] = useState<DirectOffer | null>(() => directOffer())
  const [trying, setTrying] = useState(false)
  const giveUp = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => subscribeDirectOffer(setOffer), [])
  useEffect(
    () => () => {
      if (giveUp.current) clearTimeout(giveUp.current)
    },
    []
  )

  if (!offer) return null

  const tryAgain = (): void => {
    if (trying) return
    setTrying(true)
    const settle = (): void => {
      if (giveUp.current) clearTimeout(giveUp.current)
      giveUp.current = null
      setTrying(false)
    }
    giveUp.current = setTimeout(settle, RETRY_SAFETY_MS)
    void retryPath().then(settle, settle)
  }

  return (
    <p className="cr-path-direct" role="status">
      <span className="cr-path-direct-why">{directOfferWhy(offer.family, offer.proxy)}</span>
      <span className="cr-path-direct-acts">
        <button
          type="button"
          className="cr-btn cr-path-direct-retry"
          disabled={trying}
          onClick={tryAgain}
        >
          {trying ? DIRECT_OFFER_COPY.retrying : DIRECT_OFFER_COPY.retry}
        </button>
        <button
          type="button"
          className="cr-btn cr-path-direct-go"
          onClick={() => openDirectly(offer)}
        >
          {offer.kind === 'lan' ? DIRECT_OFFER_COPY.lan : DIRECT_OFFER_COPY.tailnet}
        </button>
      </span>
    </p>
  )
}

/** What the tap needs from the outside world, so a test needs no browser. */
export interface DirectJumpDeps {
  readonly token: () => string | null
  readonly go: (url: string) => void
}

const browserJump: DirectJumpDeps = {
  token: () => authStore().token(),
  // `assign` rather than `replace`: the relay page stays in history, so BACK
  // is the way home if this Wi-Fi turns out not to be the Mac's after all.
  go: (url) => window.location.assign(url)
}

/**
 * TAKE THE OFFER. Read the token, build the URL, go — and nothing else.
 *
 * THE CREDENTIAL IS READ HERE AND HELD NOWHERE. It is not in the offer, not in
 * the store, not in an attempt row and not in a log line: this client logs
 * nothing at all on this path, deliberately, because a token that reaches a
 * console reaches every crash reporter and screenshot after it. It goes into
 * one query string, is spent on one request, and is taken back off the address
 * bar by the boot at the far end (auth-gate.ts · `scrubPairingFromUrl`).
 *
 * NO TOKEN, NO NAVIGATION. Landing unpaired means a certificate the reader has
 * never seen wrapped around a Not paired card, which is strictly worse than
 * the relay that is currently working.
 */
export const openDirectly = (
  offer: { readonly origin: string },
  deps: DirectJumpDeps = browserJump
): void => {
  const url = directNavigationUrl(offer, deps.token())
  if (url) deps.go(url)
}
