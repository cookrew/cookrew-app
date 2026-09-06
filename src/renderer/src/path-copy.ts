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
    "Staying on the relay. You can allow local network access in the browser's site settings."
} as const

/**
 * WHAT HAPPENED TO ONE CANDIDATE, in the four words a reader can act on.
 *
 * Deliberately not error strings. "Failed to fetch" is the same message for a
 * sleeping Mac, a refused permission and a captive portal, and repeating it
 * three times is what makes people ask why the badge says the wrong thing.
 */
export const ATTEMPT_COPY = {
  answered: 'answered',
  'no-answer': 'no answer',
  refused: 'refused by the browser',
  unverified: 'not verified'
} as const
