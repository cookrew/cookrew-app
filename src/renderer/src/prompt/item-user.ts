import { whoFilter } from './who-keys'

/**
 * A BROWSER'S OR A NOTE'S LATEST USER (owner, 2026-11-04): in an item's full
 * view the box talks to the agent that used it last — of the agents wired to
 * it, the one with the latest activity. None wired (or none known): nobody,
 * and the words make a new agent.
 */
export function latestUser(
  owners: readonly string[],
  rows: readonly { readonly id: string; readonly lastActivityAt: number }[]
): string | null {
  let best: { id: string; at: number } | null = null
  for (const id of owners) {
    const row = rows.find((r) => r.id === id)
    if (!row) continue
    if (!best || row.lastActivityAt > best.at) best = { id, at: row.lastActivityAt }
  }
  return best?.id ?? null
}

export interface PickRow {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly lastActivityAt: number
}

/**
 * The who-picker's agents (owner design, 2026-11-03; cut 2026-11-04): whoever
 * waits on you first, then the most recently active. The one in the box shows
 * where it stands, marked (the cut draws it there), kept in the recent row
 * even when it is not among the latest. A browser's or a note's users lead
 * the recent row in its full view and at the artifacts stop (usersInView).
 * A typed name searches every agent, past the recent few (who-keys.ts).
 */
export function pickerRows<R extends PickRow>(
  rows: readonly R[],
  { current, first = [], recent = 4, query = '' }: { current: string | null; first?: readonly string[]; recent?: number; query?: string }
): { waiting: R[]; recent: R[] } {
  const typed = query.trim() !== ''
  const hits = typed ? whoFilter(rows, query, (r) => r.name) : rows
  const waiting = hits.filter((r) => r.status === 'waiting')
  const rank = (r: R): number => (first.includes(r.id) ? 1 : 0)
  const rest = hits.filter((r) => r.status !== 'waiting')
  // Typed, the filter's order stands (best match first); untyped, users then activity.
  if (typed) return { waiting, recent: rest }
  const sorted = [...rest].sort((a, b) => rank(b) - rank(a) || b.lastActivityAt - a.lastActivityAt)
  const top = sorted.slice(0, recent)
  const inBox = sorted.find((r) => r.id === current)
  return { waiting, recent: inBox && !top.includes(inBox) ? [...top.slice(0, Math.max(0, recent - 1)), inBox] : top }
}

/**
 * The agents that used the items in view (cut 2026-11-04): in a browser's or
 * a note's full view its own users; at the artifacts stop (the grid holds
 * every item of the workspace) the users of them all, once each; nobody
 * anywhere else.
 */
export function usersInView({
  dir,
  v,
  full,
  item,
  artifacts
}: {
  dir: 'agents' | 'items'
  v: number
  full: 'agent' | 'item' | null
  item: string | null
  artifacts: readonly { readonly id: string; readonly owners: readonly string[] }[]
}): string[] {
  if (full === 'item') return [...(artifacts.find((a) => a.id === item)?.owners ?? [])]
  // The items side's stops: devices -2, workspaces -1, the artifacts 0.
  if (dir !== 'items' || full !== null || v < -0.5) return []
  return [...new Set(artifacts.flatMap((a) => a.owners))]
}
