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

/**
 * The browser this page is actually running in.
 *
 * Guarded because some embedded web views throw on touching `navigator`, and
 * because a panel that explains a failure must not be able to cause one.
 */
export const currentBrowser = (): string => {
  try {
    return browserFamily((globalThis as { navigator?: { userAgent?: unknown } }).navigator?.userAgent)
  } catch {
    return 'other'
  }
}
