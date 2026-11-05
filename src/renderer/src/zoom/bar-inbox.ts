import type { AgentPhase } from '../agent-rows'
import { inkStatusOfRow } from './ink-status'
import { isUnseen, type SeenPage } from './bar-seen'

/**
 * WHAT A GROUP HOLDS IS WHAT NEEDS YOU (owner, 2026-11-04; cut
 * docs/avatar-send-tasks/e-groups · 8-what-is-in-a-group).
 *
 *   AGENTS     waiting on you first (red ring + dot), then a reply you have
 *              not read (the red tick, ink-status.ts · inkStatusOfRow 'done').
 *              Working or resting agents are not in it.
 *   ARTIFACTS  browsers and notes made or changed since you last looked,
 *              newest first (bar-seen.ts).
 *
 * Handled, it leaves: a reply once its card or full view opened; a waiting
 * agent once it is answered (it stops waiting) — a glance at its card does not
 * unblock it, so it stays where you will find it. The stop itself still shows
 * everything.
 *
 * Whether a reply is read is the tracker's (`unread`, turnSeen), never this
 * device's: a page refreshed or a phone beside the desktop must not disagree.
 * Nothing on the client names a reply: `lastActivityAt` is reseeded from a time
 * stamped per read, so a reply "seen" by it came back on every refresh.
 */

export interface InboxRow {
  readonly id: string
  readonly phase: AgentPhase
  readonly unread?: boolean
  readonly lastActivityAt: number
}

export interface AgentEntry {
  readonly id: string
  readonly why: 'waiting' | 'reply'
}

const newestFirst = (a: InboxRow, b: InboxRow): number => b.lastActivityAt - a.lastActivityAt

export function agentInbox(rows: readonly InboxRow[]): AgentEntry[] {
  const waiting = rows.filter((r) => r.phase === 'waiting').sort(newestFirst)
  const replies = rows.filter((r) => inkStatusOfRow(r.phase, r.unread === true) === 'done').sort(newestFirst)
  return [...waiting.map((r) => ({ id: r.id, why: 'waiting' as const })), ...replies.map((r) => ({ id: r.id, why: 'reply' as const }))]
}

export interface ItemEntry {
  readonly id: string
  readonly sig: string
  /** When the change was first noticed; null when it was not yet. */
  readonly at: number | null
}

/** `items` newest made first (the board's nodes reversed); the ones not looked at, the latest noticed first. */
export function itemInbox(items: readonly { readonly id: string; readonly sig: string }[], page: SeenPage): ItemEntry[] {
  const out = items.flatMap((i, k) => {
    if (!isUnseen(page, i.id, i.sig)) return []
    const n = page.noticed[i.id]
    return [{ id: i.id, sig: i.sig, at: n && n[0] === i.sig ? n[1] : null, k }]
  })
  out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.k - b.k)
  return out.map(({ id, sig, at }) => ({ id, sig, at }))
}

/** How many faces a group shows before its "+N": a phone 3, the desktop 5 (beside the word). */
export const groupSize = (narrow: boolean): number => (narrow ? 3 : 5)

/**
 * The stack's ids with the open card's face kept where it stood, though it was
 * handled the moment its card opened: a second tap on it is its full view.
 */
export function withHeld(stack: readonly string[], before: readonly string[], held: string | null): string[] {
  if (held === null || stack.includes(held) || !before.includes(held)) return [...stack]
  const at = before.indexOf(held)
  const after = stack.findIndex((id) => before.indexOf(id) > at)
  return after < 0 ? [...stack, held] : [...stack.slice(0, after), held, ...stack.slice(after)]
}

/** "new · 2 m ago": why the artifacts group holds it, on its card. */
export function sinceWord(at: number | null, now: number): string {
  if (at === null) return 'new'
  const min = Math.floor(Math.max(0, now - at) / 60_000)
  if (min < 1) return 'new · just now'
  if (min < 60) return `new · ${min} m ago`
  const h = Math.floor(min / 60)
  return h < 24 ? `new · ${h} h ago` : `new · ${Math.floor(h / 24)} d ago`
}
