import type { BrowserNodeData } from '../../shared/model'

/**
 * Native Electron keeps every legacy webview resident so its page/session and
 * thumbnail compositor stay alive. A remote client owns none of those pages:
 * it only needs the one server-owned browser currently open as the LOD winner.
 */
export function browserHostsToRender(
  browsers: readonly BrowserNodeData[],
  remote: boolean,
  primaryId: string | null,
): readonly BrowserNodeData[] {
  if (!remote) return browsers
  const active = primaryId === null ? undefined : browsers.find((browser) => browser.id === primaryId)
  return active ? [active] : []
}
