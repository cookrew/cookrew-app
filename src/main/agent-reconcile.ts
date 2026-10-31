// AN AGENT THAT IS GONE IS NOT AN AGENT THAT IS RESTING.
//
// 2026-10-31, owner's screenshot: the Beacon card sat in the pet grid reading
// RESTING, with a prompt box, after its pane had ceased to exist. The roster
// was right to trust the registry — `active` is the registry's field — but
// `active` only ever flips on an EXPLICIT event: dismiss, kill, or an agent
// exit the app witnessed. A pane that disappears without one (a herdr server
// restart, a lost login session, a crash) leaves the entry claiming `active`
// forever. Beacon had eight such entries, the oldest sixteen weeks stale.
//
// So the registry is reconciled against what the app can actually SEE: a live
// PTY for the terminal, or a session the multiplexer still holds. Anything
// else is marked inactive, which the card already draws as `offline`.
//
// THE BLINDNESS RULE, and it is the load-bearing one: when the app cannot see
// the multiplexer at all, this marks NOTHING. "I cannot observe" must never be
// spent as "it is finished" — that is the same distinction the ask path's
// `unverifiable` outcome exists to protect, and getting it backwards here would
// flip every agent in a dead herdr to offline and hide real work.
import type { AgentRegistryEntry } from './agent-registry'

export interface LivenessInput {
  entries: readonly AgentRegistryEntry[]
  /** True when the app can see the multiplexer (or holds PTYs itself). */
  observable: boolean
  /** Ids the app can see running right now: a PTY, or a multiplexer session. */
  live: ReadonlySet<string>
  /**
   * Ids this sweep must never touch: served sandboxes ride a different
   * multiplexer, so their absence here is not evidence of anything.
   */
  exempt?: ReadonlySet<string>
}

/** Entries that claim to be active and cannot be seen running. */
export function staleAgentIds(input: LivenessInput): string[] {
  if (!input.observable) return []
  return input.entries
    .filter((e) => e.active && !input.live.has(e.id) && !input.exempt?.has(e.id))
    .map((e) => e.id)
}
