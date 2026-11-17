/**
 * THE BAR'S GROUPS REACH EVERY WORKSPACE (owner, 2026-11-15/16; plan
 * docs/hitl-cross-workspace-2026-11-15 · v6.2). What needs you in a workspace
 * you are not looking at still needs you: AGENTS holds every workspace's
 * waiting agents and unread replies, ordered by urgency and time, never by
 * workspace. A face from another workspace wears that workspace's mark, opens
 * a read-only card where you are, and its second tap jumps there
 * (canvas-ui.ts · jumpToNode). A served workspace is a customer's: never here.
 */

export interface WorkspaceFace {
  readonly name: string
  readonly icon: string | null
  /** A served (marketplace) session's workspace (main: store.ts · markServed). */
  readonly served?: boolean
}

interface ReachRow {
  readonly id: string
  readonly workspaceId: string
  readonly active: boolean
}

/**
 * The rows the AGENTS group reads: the open workspace's crew (as its cards draw
 * them), then every other workspace's running agents off the roster. A served
 * workspace, open or not, and one the list does not know are left out.
 */
export function inboxRows<R extends ReachRow>(open: readonly R[], all: readonly R[], openId: string | null, workspaces: ReadonlyMap<string, WorkspaceFace>): R[] {
  const owners = (id: string | null): boolean => {
    const ws = id === null ? undefined : workspaces.get(id)
    return ws !== undefined && ws.served !== true
  }
  const here = new Set(open.map((r) => r.id))
  const own = owners(openId) ? [...open] : []
  const away = all.filter((r) => r.workspaceId !== openId && r.active && !here.has(r.id) && owners(r.workspaceId))
  return [...own, ...away]
}

/** Another workspace's mark on a face: its icon, else its name's first letter. */
export function badgeOf(ws: WorkspaceFace | undefined): string {
  const icon = ws?.icon?.trim()
  if (icon) return icon
  const first = Array.from(ws?.name.trim() ?? '')[0]
  return first ? first.toUpperCase() : '?'
}

/** A face tapped a second time: its full view here, or the jump to the workspace it is in. */
export const secondTap = (itsWorkspace: string, openWorkspace: string | null): 'full' | 'jump' =>
  itsWorkspace === openWorkspace ? 'full' : 'jump'
