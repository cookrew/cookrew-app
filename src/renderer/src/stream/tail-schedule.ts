/**
 * WHEN A QUIET AGENT'S PREVIEW IS READ AGAIN (bytes 0.6.2).
 *
 * Where nothing pushes (the console, the phone) a board's previews were
 * polled: every quiet agent of every workspace, every 3 s, one read at a time
 * through the relay. Measured on the owner's Mac 2026-11-11: 22 agents, 128 KB
 * a sweep, ~147 reads and ~850 KB a minute for an idle page, about the whole
 * of what the Mac's relay uplink carries (canvas bytes audit).
 *
 * A quiet agent's last turn changes when the agent does something, and the
 * page already hears that: its activity arrives on the event stream. So a
 * preview is read
 *
 *   once           when its agent joins the board,
 *   at a change    when its activity says something changed (its version), and
 *   at a minute    regardless, so a signal that went missing leaves a preview
 *                  stale for a minute at most (the backstop),
 *
 * and a read that missed is asked again soon. Most of the reads left are the
 * backstop's, and the machine answers those 304 (stream-http.ts · tail).
 *
 * Pure: the clock and the ids come in, so the rule is tested without a page.
 */
import type { TerminalActivity } from '../../../shared/turn'

/** The longest a preview goes unread: what a missed activity signal costs at most. */
export const TAIL_BACKSTOP_MS = 60_000
/** A read that got no answer is asked again after this, not after the backstop. */
export const TAIL_MISS_RETRY_MS = 10_000

export interface TailSchedule {
  /** The ids due a read at `now`: never read, changed since, missed, or read a backstop ago. Forgets ids no longer listed. */
  due(ids: readonly string[], versions: Readonly<Record<string, string>>, now: number): string[]
  /** A read of `id` at this version began at `now`. */
  read(id: string, version: string, now: number): void
  /** The read of `id` got no answer at `now`. */
  missed(id: string, now: number): void
}

/**
 * What of an agent's activity says its last turn may have changed: its phase and
 * how many turns it has had. Not its clock: the tracker stamps `updatedAt` on every
 * push, and an idle pane that pushes would put its preview back on a 3 s read
 * (review, bytes 0.6.2). Anything else is the backstop's.
 */
export const tailVersionOf = (activity: Pick<TerminalActivity, 'phase'> & { turnCount?: number } | undefined): string =>
  activity === undefined ? '' : `${activity.phase}|${activity.turnCount ?? 0}`

export function createTailSchedule(backstopMs = TAIL_BACKSTOP_MS, missRetryMs = TAIL_MISS_RETRY_MS): TailSchedule {
  let last = new Map<string, { readonly version: string; readonly at: number }>()
  return {
    due(ids, versions, now) {
      const listed = new Set(ids)
      if ([...last.keys()].some((id) => !listed.has(id))) last = new Map([...last].filter(([id]) => listed.has(id)))
      return ids.filter((id) => {
        const was = last.get(id)
        return was === undefined || was.version !== (versions[id] ?? '') || now - was.at >= backstopMs
      })
    },
    read(id, version, now) {
      last.set(id, { version, at: now })
    },
    missed(id, now) {
      const was = last.get(id)
      if (was) last.set(id, { version: was.version, at: now - backstopMs + missRetryMs })
    }
  }
}
