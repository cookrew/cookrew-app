// The boot reaper's rules: what a Cookrew may close at startup.
//
// 2026-09-18 02:19 a second Cookrew (a QA run with its own userData and HOME)
// booted on the SAME herdr session with an empty store. Every live pane matched
// no terminal node it knew, so every pane was an "orphan": herdr logged
// `pane close` 56 times in 52 seconds and every running agent died mid-turn.
//
// "Not in my store" was never proof of "nobody's". So the reaper now needs
// three things before it closes anything:
//   1. The instance holds the multiplexer session's owner claim (see
//      herdr-session-claim.ts). A guest does not tidy someone else's house.
//   2. The store is FAMILIAR: at least one live Cookrew pane belongs to it.
//      An empty or unrelated store proves nothing about the panes it sees, so
//      it adopts nothing and closes nothing.
//   3. A seatbelt: a boot that would close more than a handful of panes
//      closes none of them and says so. Real leaks are a few crash leftovers;
//      a long list means the ownership answer is wrong, not that the fleet is.

import { COOKREW_SESSION_RE, sessionNameFor } from './tmux-multiplexer'
import type { Multiplexer } from './multiplexer'

/** Above this, one boot closes nothing at all. */
export const MAX_ORPHAN_CLOSES_PER_BOOT = 5

/**
 * Session names that belong to NO terminal node — leaked agents from a crash
 * or a workspace delete that never killed its terminals. Pure: only names
 * matching our naming AND not owned are returned, so a foreign session on the
 * same server is never reaped.
 */
export function orphanSessionNames(names: string[], ownedTerminalIds: Iterable<string>): string[] {
  const owned = new Set<string>()
  for (const id of ownedTerminalIds) owned.add(sessionNameFor(id))
  return names.filter((name) => COOKREW_SESSION_RE.test(name) && !owned.has(name))
}

export interface ReapPlan {
  /** Sessions to close. Empty whenever a guard held. */
  close: string[]
  /** Orphan-looking sessions left alone by a guard. */
  held: number
  /** Why the reaper held back, or null when it did not. */
  reason: string | null
}

/** Decide what a boot may close. Pure. */
export function planOrphanReap(
  liveNames: string[],
  ownedTerminalIds: Iterable<string>,
  cap = MAX_ORPHAN_CLOSES_PER_BOOT
): ReapPlan {
  const owned = [...ownedTerminalIds]
  const orphans = orphanSessionNames(liveNames, owned)
  if (orphans.length === 0) return { close: [], held: 0, reason: null }

  const ours = liveNames.filter((name) => COOKREW_SESSION_RE.test(name)).length - orphans.length
  if (ours === 0) {
    return {
      close: [],
      held: orphans.length,
      reason:
        `none of the ${orphans.length} live Cookrew panes belongs to this store ` +
        `(${owned.length} terminal node(s)) — an empty or unfamiliar store proves nothing about them`
    }
  }
  if (orphans.length > cap) {
    return {
      close: [],
      held: orphans.length,
      reason: `${orphans.length} panes look orphaned, above the per-boot cap of ${cap}`
    }
  }
  return { close: orphans, held: 0, reason: null }
}

export interface ReapOptions {
  /** True when this instance holds the multiplexer session's owner claim. */
  claimHeld: boolean
  cap?: number
  log?: (line: string) => void
}

/**
 * Run the boot reap against a backend. Returns the closed session names.
 * Without the owner claim it does not even list the session.
 */
export function reapOrphansOn(
  mux: Pick<Multiplexer, 'listSessions' | 'killSession'>,
  ownedTerminalIds: Iterable<string>,
  options: ReapOptions
): string[] {
  const log = options.log ?? ((line: string) => console.error(line))
  if (!options.claimHeld) {
    log('Orphan reap skipped: this instance does not own the multiplexer session — closing none')
    return []
  }
  const plan = planOrphanReap(mux.listSessions(), ownedTerminalIds, options.cap)
  if (plan.reason) {
    log(`Orphan reap held: ${plan.reason}. Closing none of ${plan.held}; close them by hand if they really are leaks.`)
    return []
  }
  for (const name of plan.close) mux.killSession(name)
  return plan.close
}
