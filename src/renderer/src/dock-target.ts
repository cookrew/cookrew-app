import type { BrowserNodeData } from '../../shared/model'
import { activeBrowserTab } from '../../shared/model'

/**
 * The browser the dock should act on: the node currently filling the stage,
 * but only when it IS a browser. The LOD layout's primary is whichever card
 * won full view — a terminal or note wins it just as often, and those keep
 * the ordinary tool group.
 *
 * The url is the ACTIVE TAB's, not the node's, so the dock hands a real
 * browser the page you are looking at rather than the tab the card opened on.
 */
export function browserInFullView(
  primaryId: string | null,
  browsers: readonly BrowserNodeData[]
): { id: string; url: string } | null {
  if (primaryId === null) return null
  const browser = browsers.find((node) => node.id === primaryId)
  return browser ? { id: browser.id, url: activeBrowserTab(browser).url } : null
}
