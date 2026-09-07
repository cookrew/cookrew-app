/**
 * THE WORDS THE PATH USES, IN ONE PLACE.
 *
 * Two surfaces, and both of them are the design rather than a decoration of
 * it: the sentence in front of a browser permission prompt, and the sentence a
 * badge says when that prompt was refused.
 *
 * WHY THE ASK NEEDS A SENTENCE AT ALL. Chrome's Local Network Access dialog
 * names the origin doing the asking, and ours is
 * `192-168-1-24.<a uuid>.d.cookrew.dev` — a string that reads as an attack to
 * anybody who has not read the certificate design. The dialog cannot be
 * changed, so the only thing that can carry the meaning is the line above it,
 * and that line has to be true in the reader's own terms: this phone, that
 * Mac, this Wi-Fi.
 *
 * WHY THE REFUSAL NEEDS ONE. "Via cookrew.dev relay — your Mac is not on this
 * network" is the ordinary relay sentence and it is a LIE after a refusal: the
 * Mac may be three feet away and perfectly reachable, and the reason we are on
 * the long path is a permission, not a topology. Saying so, and naming where
 * it can be undone, is the difference between a product and a forum thread.
 */

export const LOCAL_NETWORK_COPY = {
  /** Above the prompt, while the browser will still raise one. */
  ask: 'This phone can talk to the Mac directly on this Wi-Fi. Allow local network access?',
  /** The one control. Uppercased by .cr-btn, like every other button here. */
  allow: 'Allow',
  /** After a refusal — on the row, and as the badge's relay sentence. */
  denied:
    "Staying on the relay. You can allow local network access in the browser's site settings.",
  /**
   * ADDED TO THE ASK WHEN THE BROWSER REFUSED BOTH WAYS.
   *
   * Chrome 152 behind a system proxy, 2026-09-08: the annotated request fails
   * in 32 ms and the unannotated one fails too, the permission stays 'prompt',
   * and no dialog is ever raised. Offering ALLOW alone there is a button with
   * nothing behind it, so the sentence names the cause and points at the one
   * thing that does work — the OPEN ON WI-FI button beside it, which the direct
   * offer puts there for exactly this case (path/direct-offer.ts).
   */
  proxied:
    "A system proxy may be hiding the address from the browser; open the Mac's Wi-Fi address directly instead."
} as const

/**
 * THE ONE CASE WHERE THE ANSWER IS "LEAVE THIS PAGE", IN WORDS.
 *
 * LOCAL_NETWORK_COPY above names a switch the reader can flip. On iOS there is
 * no switch: the permission is never asked for and the site is never listed
 * under Settings → Privacy → Local Network, so every probe from cookrew.dev
 * times out for ever (QA 2026-09-08). "Staying on the relay, you can allow
 * local network access in the browser's site settings" is therefore not merely
 * unhelpful there — it sends somebody hunting for a control that does not
 * exist, which is the same failure as the sentence it replaced.
 *
 * SO THE SENTENCE NAMES THE BROWSER AND THE SENTENCE ENDS IN A COLON, because
 * the only thing after it is the one button that fixes it. The buttons are
 * sentence case here and uppercased by .cr-btn, like every other button on
 * this bar; the reader sees OPEN ON WI-FI.
 */
export const DIRECT_OFFER_COPY = {
  lan: 'Open on Wi-Fi',
  tailnet: 'Open on tailnet',
  /** On the landed page, once. The old URL is gone from the bar; say it works. */
  landed: 'Opened directly on Wi-Fi. cookrew.dev/… still works from anywhere.',
  dismiss: 'Dismiss'
} as const

/** The tail both sentences share: the fix, and the colon that introduces it. */
const OPEN_INSTEAD = 'Open the Mac directly on Wi-Fi instead:'

/**
 * WHOSE FAULT IT IS, WHICH IS A DIFFERENT ANSWER IN SAFARI.
 *
 * "Apple never asks it for local-network permission" is exactly right in
 * Safari and quietly wrong in Chrome, where a reader knows perfectly well that
 * Chrome has such a permission and would go looking for it in Chrome's own
 * settings. On iOS it is not Chrome's to give: every browser there is WebKit,
 * so the sentence has to name the PLATFORM. Getting that wrong sends somebody
 * to a settings screen that cannot help them, which is the whole failure this
 * copy exists to end.
 *
 * The family is a family name — `Chrome`, `Safari`, or `This browser` when
 * nothing was recognised — never a version and never a user-agent string.
 *
 * AND THE THIRD ANSWER IS NOT A PLATFORM AT ALL. Chrome 152 on the owner's Mac
 * behind a system proxy, 2026-09-08: the browser HAS the permission and can
 * never raise the dialog, because the annotated request fails the address-space
 * check before any prompt when the proxy hides the resolved address. Saying
 * "on iPhone" to somebody sitting at a Mac would be worse than saying nothing;
 * the sentence names the proxy, which is the thing they can actually change.
 */
export const directOfferWhy = (family: string, proxy?: boolean): string => {
  if (proxy) {
    return `${family} cannot reach your Mac from this page — a system proxy hides the address, so the browser refuses the request with and without the local-network hint. ${OPEN_INSTEAD}`
  }
  return family === 'Safari'
    ? `Safari on iPhone cannot reach your Mac from this page — Apple never asks it for local-network permission. ${OPEN_INSTEAD}`
    : `${family} on iPhone cannot reach your Mac from this page — iOS never asks a browser for local-network permission. ${OPEN_INSTEAD}`
}

/**
 * WHAT HAPPENED TO ONE CANDIDATE, in words a reader can act on.
 *
 * Deliberately not error strings. "Failed to fetch" is the same message for a
 * sleeping Mac, a refused permission and a captive portal, and repeating it
 * three times is what makes people ask why the badge says the wrong thing.
 *
 * THE FOUR NEW ONES EXIST BECAUSE OF ONE SCREENSHOT: four LAN candidates, four
 * rows saying "no answer", a 13,328 ms relay round trip, and no way to tell
 * whether the phone's browser had refused the request outright or the Mac was
 * simply asleep. Each sentence now names its own next step — site settings, the
 * Wi-Fi, the Mac, or whatever else is answering on that port.
 */
export const ATTEMPT_COPY = {
  answered: 'answered',
  'no-answer': 'no answer',
  refused: 'refused by the browser',
  unverified: 'not verified',
  timeout: 'timed out',
  blocked: 'refused by the browser before connecting',
  network: 'could not connect (DNS, certificate or network)',
  http: 'answered'
} as const

/**
 * THE TWO ROWS THE ADDRESS-SPACE HINT CHANGES THE MEANING OF.
 *
 * THE INCIDENT: Chrome 152 behind a system proxy, on the owner's Mac,
 * 2026-09-08. The panel said `192.168.2.40:8643 refused by the browser before
 * connecting — 32 ms` and the permission line above it said "local network not
 * asked yet", which together read as "go and allow it". There was nothing to
 * allow: no prompt had been raised or could be. The proxy hides the resolved
 * address, Chrome calls the target public, and a request DECLARING 'local'
 * fails that check before any dialog — while the identical request without the
 * declaration is delivered.
 *
 * So the two rows that can only come from that world say so. An answer that
 * arrived only unannotated names the proxy, because it is the reason the panel
 * looks strange; a refusal that happened both ways says both ways, because it
 * is the one refusal site settings cannot fix.
 */
const HINTLESS_COPY = {
  answered: 'answered (without the local-network hint — a proxy hides the address)',
  blocked: 'refused by the browser before connecting (with and without the hint)'
} as const

/** Only these two outcomes mean anything different for having lost the hint. */
const tellsOnTheHint = (outcome: keyof typeof ATTEMPT_COPY): outcome is 'answered' | 'blocked' =>
  outcome === 'answered' || outcome === 'blocked'

/**
 * The one sentence per row, with the measurement folded in where it earns its
 * place.
 *
 * `answered` without a time would throw away the only number in the panel that
 * explains an ordering, and `unverified` WITH one is deliberate: an address
 * that answered in 4 ms and could not prove itself is the exact signature of
 * somebody else's machine on this Wi-Fi, and the speed is the tell.
 *
 * A timeout quotes its deadline in brackets rather than after a dash, because
 * "timed out — 800 ms" reads as a measurement of something that happened and
 * this is a measurement of something that did not.
 */
export const attemptSentence = (attempt: {
  readonly outcome: keyof typeof ATTEMPT_COPY
  readonly ms: number | null
  readonly status?: number
  /** Set only where the variant is news — see HINTLESS_COPY and toldHint. */
  readonly hint?: 'local' | 'none'
}): string => {
  const said =
    attempt.hint === 'none' && tellsOnTheHint(attempt.outcome)
      ? HINTLESS_COPY[attempt.outcome]
      : ATTEMPT_COPY[attempt.outcome]
  // The status IS the story: 421 is the endpoint-bound hello refusing a
  // relayed challenge, 404 is somebody else's server on port 8643.
  if (attempt.outcome === 'http') return attempt.status ? `${said} ${attempt.status}` : said
  if (attempt.ms === null) return said
  if (attempt.outcome === 'timeout') return `${said} (${attempt.ms} ms)`
  return attempt.outcome === 'answered' ? `${said} in ${attempt.ms} ms` : `${said} — ${attempt.ms} ms`
}

/**
 * WHAT THE BROWSER SAYS ABOUT THE LOCAL NETWORK, as the panel's header says it.
 *
 * The rows are the evidence and this is the condition every one of them ran
 * under. Without it a panel full of "refused by the browser before connecting"
 * is a mystery; with it the first line already reads "Chrome 142 · local
 * network refused" and the reader is looking at the answer before the rows.
 */
export const PERMISSION_COPY = {
  granted: 'local network allowed',
  denied: 'local network refused',
  prompt: 'local network not asked yet',
  unsupported: 'local network permission not supported'
} as const
