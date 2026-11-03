// RESTART AN AGENT IN PLACE ON A NEW LAUNCH COMMAND (owner 2026-11-01: a
// model or effort pick is "not typed into the TUI").
//
// A claude dial is a launch flag (shared/launch-tune): the pick is written
// into the card's command, and the agent is restarted on its own session to
// take it — the route dial's restart, with the same guard (route/service.ts
// restorable). This module only decides; the store, the turn tracker and the
// PTY table arrive as functions, so every branch is tested without Electron.
//
// The rules, in order:
//   gone          no such card: nothing is saved.
//   busy          mid-turn, waiting on a question the owner has not
//                 answered, or a prompt still on its way in (a dispatch open,
//                 the submission window held, undelivered text in the box): a
//                 restart would cut the reply, drop the question or lose the
//                 prompt, so nothing is saved either — the pick is made again
//                 once it replies (the rail is locked meanwhile).
//   asleep        no process: the command is saved and the agent wakes on it.
//   unrestorable  the session could not be resumed exactly: the command is
//                 saved for the next start, but nothing is killed, because a
//                 restart now would boot an empty conversation.
//   restarted     saved, and the agent restarts on its own session.
//   unchanged     the pick is what the card already carries: nothing to do.
//
// What is saved is a patch: the launch command, and for a routed claude card's
// model the route too (claude-model-route.ts), so one restart takes both.

import type { TerminalNodeData } from '../shared/model'
import type { TurnPhase } from '../shared/turn'
import type { LaunchPatch } from './claude-model-route'

export type RelaunchVerdict = 'restarted' | 'unchanged' | 'asleep' | 'busy' | 'unrestorable' | 'gone'

export interface RelaunchDeps {
  node: (id: string) => TerminalNodeData | null
  phaseOf: (id: string) => TurnPhase | undefined
  /**
   * A prompt is on its way in: the turn tracker cannot see it yet (a turn
   * starts once the agent takes the prompt), and a restart now loses it and
   * strands its dispatch's slot (QA 2026-11-03).
   */
  delivering: (id: string) => boolean
  /** Save the patch on the card (the next spawn of it boots this). */
  save: (id: string, patch: LaunchPatch) => void
  /** A process, or a pane the multiplexer still holds, is running for the card. */
  live: (id: string) => boolean
  /** A respawn loses nothing: exact resume, or nothing to lose (RouteService.restorable). */
  restorable: (node: TerminalNodeData) => boolean
  /** Kill and spawn again, reading the card after the kill (index.ts respawnInPlace). */
  respawn: (id: string) => void
}

/** The phases a restart cannot hurt: nothing being written, nothing being asked. */
function settled(phase: TurnPhase | undefined): boolean {
  return phase === undefined || phase === 'idle' || phase === 'replied'
}

export function relaunchInPlace(deps: RelaunchDeps, id: string, patch: LaunchPatch): RelaunchVerdict {
  const node = deps.node(id)
  if (node === null) return 'gone'
  if (patch.command === node.command && (patch.route === undefined || patch.route === node.route)) return 'unchanged'
  if (!settled(deps.phaseOf(id)) || deps.delivering(id)) return 'busy'
  deps.save(id, patch)
  if (!deps.live(id)) return 'asleep'
  if (!deps.restorable({ ...node, ...patch })) return 'unrestorable'
  deps.respawn(id)
  return 'restarted'
}
