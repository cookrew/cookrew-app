/** Chromium's private page used after a navigation failure. */
export const CHROMIUM_ERROR_PAGE = 'chrome-error://chromewebdata/'
export const BLANK_BROWSER_PAGE = 'about:blank'

/**
 * Chromium reports its internal error document as a real navigation. It is
 * not a URL an application may load: replaying it through Electron's webview
 * can hand the private scheme to macOS and show "There is no application set
 * to open the URL chrome-error://chromewebdata/".
 */
export function isChromiumErrorPage(url: string): boolean {
  try {
    return new URL(url).protocol === 'chrome-error:'
  } catch {
    return false
  }
}

/** Keep the requested address when Chromium moves to its private error page. */
export function observedBrowserUrl(current: string, observed: string): string {
  return isChromiumErrorPage(observed) ? current : observed
}

/** Never pass a persisted private error-page URL back to a browser engine. */
export function browserUrlForLoad(stored: string): string {
  return isChromiumErrorPage(stored) ? BLANK_BROWSER_PAGE : stored
}
