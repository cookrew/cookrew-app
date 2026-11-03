/**
 * THE WORDS THE LOCAL-NETWORK ASK USES, IN ONE PLACE.
 *
 * The sentence in front of a browser permission prompt, and the one the row
 * says after a refusal.
 *
 * WHY THE ASK NEEDS A SENTENCE AT ALL. Chrome's Local Network Access dialog
 * names the origin doing the asking, and ours is
 * `192-168-1-24.<a uuid>.d.cookrew.dev` — a string that reads as an attack to
 * anybody who has not read the certificate design. The dialog cannot be
 * changed, so the only thing that can carry the meaning is the line above it,
 * and that line has to be true in the reader's own terms: this phone, that
 * Mac, this Wi-Fi.
 */

export const LOCAL_NETWORK_COPY = {
  /** Above the prompt, while the browser will still raise one. */
  ask: 'This phone can talk to the Mac directly on this Wi-Fi. Allow local network access?',
  /** The one control. Uppercased by .cr-btn, like every other button here. */
  allow: 'Allow',
  /** After a refusal, on the row. */
  denied:
    "Staying on the relay. You can allow local network access in the browser's site settings.",
  /**
   * ADDED TO THE ASK WHEN THE BROWSER REFUSED BOTH WAYS.
   *
   * Chrome 152 behind a system proxy, 2026-09-08: the annotated request fails
   * in 32 ms and the unannotated one fails too, the permission stays 'prompt',
   * and no dialog is ever raised. Offering ALLOW alone there is a button with
   * nothing behind it, so the sentence names the cause. The direct link
   * (path/rtc-adopt.ts) does not need the permission, so there is nothing
   * else to send the reader to.
   */
  proxied: 'A system proxy may be hiding the address from the browser.'
} as const
