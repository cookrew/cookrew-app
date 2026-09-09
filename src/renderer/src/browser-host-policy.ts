import type { BrowserNodeData } from '../../shared/model'

/**
 * Which browser hosts mount.
 *
 * Only a LEGACY webview needs to stay resident while its card is a thumbnail:
 * the <webview> IS the page, and its session and thumbnail capture die with
 * it. Everywhere else — a remote client, and a desktop whose browsers are
 * headless streams — a host that is not zoomed does nothing: the stream opens
 * only while zoomed and the card's picture comes from main's snapshot poll.
 * So only the LOD winner mounts. Before this the desktop mounted every host
 * regardless: 90 fixed 1100x780 popouts, 54% of the live renderer's DOM and
 * 90 compositing layers for nothing on screen (perf lane L6, 2026-09-06).
 *
 * `interactive` is the resolved ownership: false = legacy webviews, true =
 * headless streams, null = not yet known (nothing streams until it is, so a
 * single zoomed host says all a neutral body can).
 */
export function browserHostsToRender(
  browsers: readonly BrowserNodeData[],
  remote: boolean,
  primaryId: string | null,
  interactive: boolean | null,
): readonly BrowserNodeData[] {
  if (!remote && interactive === false) return browsers
  const active = primaryId === null ? undefined : browsers.find((browser) => browser.id === primaryId)
  return active ? [active] : []
}
