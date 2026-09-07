/**
 * WHICH BROWSER IS ASKING, IN AS FEW WORDS AS ARE USEFUL.
 *
 * A blocked probe means completely different things in two browsers and the
 * reader cannot be expected to know which they are holding. Chrome 142 gates
 * the local network behind a permission and refuses without prompting when a
 * page has not earned one; Safari has no such permission at all, so a refusal
 * there is a certificate or a content policy and site settings will never fix
 * it. One line at the top of the panel — and one field in the report the phone
 * sends the Mac — turns "it says blocked" into a diagnosis.
 *
 * A FAMILY AND A MAJOR VERSION, AND NOTHING ELSE. A full user-agent string is
 * a fingerprint: model, build, locale, sometimes a carrier. It would be drawn
 * on a screen that gets screenshotted and posted, stored on the Mac, and read
 * back over the network — three places it has no business being. "Chrome 142"
 * is the whole of what a diagnosis needs.
 *
 * CHROME IS TESTED FIRST BECAUSE EVERY CHROME CLAIMS TO BE SAFARI. The token
 * order in a user-agent string is a museum of compatibility lies, and the one
 * that matters here is that Chrome's contains `Safari/537.36`. Chromium-based
 * browsers (Edge, Brave, Arc, Samsung Internet) therefore read as Chrome, and
 * that is the right answer for this question: they share the engine, the
 * permission and the refusal.
 */

/** `Chrome 142`, `Safari 17`, or `other` when nothing is recognised. */
export const browserFamily = (userAgent: unknown): string => {
  const ua = typeof userAgent === 'string' ? userAgent : ''
  if (ua.length === 0) return 'other'
  // Chrome on iOS is CriOS and is really WebKit underneath; it is still the
  // browser the reader chose and the one whose settings they would open.
  const chrome = /(?:CriOS|Chrome|Chromium)\/(\d+)/.exec(ua)
  if (chrome) return `Chrome ${chrome[1]}`
  // Safari's own version lives in the `Version/` token; `Safari/605.1.15` is
  // the engine build and is not a number anybody recognises.
  if (/Safari\//.test(ua)) {
    const version = /Version\/(\d+)/.exec(ua)
    return version ? `Safari ${version[1]}` : 'Safari'
  }
  return 'other'
}

/** `Chrome 142` → `Chrome`, for a sentence rather than a diagnosis. */
export const familyName = (browser: string): string => {
  const name = browser.replace(/\s+\d+$/, '')
  // A sentence has to be about SOMETHING. 'other' is the honest answer to
  // "which browser" and a terrible subject for a verb.
  return name === 'other' || name.length === 0 ? 'This browser' : name
}

/**
 * IS THIS iOS OR iPadOS — which is a question about WebKit, not about a brand.
 *
 * Asked because of a second measurement. The first said Safari 26 on the
 * owner's iPhone could not fetch the LAN; the next day the same phone did the
 * same thing in Chrome — "Chrome 152 · local network permission not supported
 * · 192.168.2.40 timed out 1557 ms". That is not a coincidence and not a bug in
 * either browser: every browser shipped on iOS and iPadOS is WebKit under the
 * App Store rules, so none of them has a local-network permission to ask for,
 * and a page on cookrew.dev cannot reach a LAN address from any of them.
 *
 * TWO SIGNALS, BECAUSE ONE OF THEM IS BEING RETIRED. The platform token
 * (`iPhone`, `iPad`, `iPod`) is the plain answer; the browser wrappers name
 * themselves (`CriOS`, `FxiOS`, `EdgiOS`, `OPiOS`) and are checked as well
 * because they survive a UA that has been trimmed of its platform.
 *
 * AN iPad IN DESKTOP MODE IS NOT DETECTED HERE, and does not need to be: it
 * sends a Macintosh Safari user agent, and macOS Safari is offered the same
 * navigation anyway (path/direct-offer.ts), so it lands on the right side of
 * the guard by the other route. Touch-point sniffing to tell those two apart
 * would be a fingerprint bought for nothing.
 *
 * STILL NOT A USER-AGENT STRING ON A SCREEN. This answers one bit and the bit
 * is about a platform, not a device — nothing here is drawn, stored or sent.
 */
export const isAppleMobile = (userAgent: unknown): boolean => {
  const ua = typeof userAgent === 'string' ? userAgent : ''
  if (ua.length === 0) return false
  return /iPhone|iPad|iPod/.test(ua) || /(?:CriOS|FxiOS|EdgiOS|OPiOS)\//.test(ua)
}

/** The user agent, or an empty string wherever it cannot be touched. */
const ambientUserAgent = (): unknown => {
  try {
    return (globalThis as { navigator?: { userAgent?: unknown } }).navigator?.userAgent
  } catch {
    // Some embedded web views throw on touching `navigator`, and a panel that
    // explains a failure must not be able to cause one.
    return ''
  }
}

/** The browser this page is actually running in. */
export const currentBrowser = (): string => browserFamily(ambientUserAgent())

/** Is this page running on iOS or iPadOS, where there is no permission at all? */
export const onAppleMobile = (): boolean => isAppleMobile(ambientUserAgent())
