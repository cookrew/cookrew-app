import { activeBrowserTab, type BrowserNodeData } from '../shared/model'
import { isUseUrl } from '../shared/use-url'

/**
 * TWO QUESTIONS, NEVER ONE (box round 3, bug 1).
 *
 * "Does a headless Chrome own this machine's PAGES?" is decided once per
 * launch (launch-defaults.ts) and needs a Chrome. A use card (a screen, a
 * window, a camera, an adb or virtual phone) has no page: main's stream draws
 * it from a device, and no Chrome is involved. Asking the first question about
 * the second made a box without Chrome pick between remote desktop and live
 * browser cards. Everything that reaches a card asks here instead.
 */

const isUseCard = (node: BrowserNodeData): boolean => isUseUrl(activeBrowserTab(node).url)

/** Main's stream draws this card. Otherwise it is a page in a renderer webview. */
export function mainDrawsCard(node: BrowserNodeData | null | undefined, pagesHeadless: boolean): boolean {
  return pagesHeadless || (node !== null && node !== undefined && isUseCard(node))
}

/**
 * An agent's `cookrew browser …` runs in main when main draws its card, or is
 * about to: `create` and `navigate` can name a use address, and a renderer would
 * wait forever for a webview to mount for one.
 */
export function commandRunsInMain(
  args: readonly string[],
  pagesHeadless: boolean,
  find: (name: string) => BrowserNodeData | undefined
): boolean {
  if (pagesHeadless) return true
  const [sub, subject, address] = args
  if (subject === undefined) return false
  if (sub === 'create') return isUseUrl(subject)
  if (sub === 'navigate' && address !== undefined && isUseUrl(address)) return true
  return mainDrawsCard(find(subject), false)
}
