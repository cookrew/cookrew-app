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
 * The who-picker's agents (owner design, 2026-11-03): whoever waits on you
 * first, then the most recently active, the one in the box left out of both.
 * A browser's or a note's users lead the recent row in its full view.
 */
export function pickerRows<R extends PickRow>(
  rows: readonly R[],
  { current, first = [], recent = 4 }: { current: string | null; first?: readonly string[]; recent?: number }
): { waiting: R[]; recent: R[] } {
  const others = rows.filter((r) => r.id !== current)
  const waiting = others.filter((r) => r.status === 'waiting')
  const rank = (r: R): number => (first.includes(r.id) ? 1 : 0)
  const rest = others
    .filter((r) => r.status !== 'waiting')
    .sort((a, b) => rank(b) - rank(a) || b.lastActivityAt - a.lastActivityAt)
  return { waiting, recent: rest.slice(0, recent) }
}
