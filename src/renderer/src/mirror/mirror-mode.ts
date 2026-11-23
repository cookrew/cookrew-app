/**
 * WHICH VIEW A REMOTE BROWSER CARD SHOWS (mirror/mirror-mode.ts).
 *
 * `page` — the page drawn here from data — unless the viewer pressed Screen
 * for that card. Only the viewer's own button changes it; nothing in the view
 * does (owner ruling 2026-11-23). Remembered per card for this session, so
 * zooming out and back in keeps what the viewer chose.
 */
export type RemoteBrowserMode = 'page' | 'screen'

export const DEFAULT_REMOTE_BROWSER_MODE: RemoteBrowserMode = 'page'

let chosen: ReadonlyMap<string, RemoteBrowserMode> = new Map()

export function remoteBrowserMode(browserId: string): RemoteBrowserMode {
  return chosen.get(browserId) ?? DEFAULT_REMOTE_BROWSER_MODE
}

export function chooseRemoteBrowserMode(browserId: string, mode: RemoteBrowserMode): void {
  chosen = new Map([...chosen, [browserId, mode]])
}
