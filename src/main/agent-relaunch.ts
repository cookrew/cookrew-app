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
//   busy          mid-turn, or waiting on a question the owner has not
//                 answered: a restart would cut the reply or drop the
//                 question, so nothing is saved either — the pick is made
//                 again once it replies (the rail is locked meanwhile).
//   asleep        no process: the command is saved and the agent wakes on it.
//   unrestorable  the session could not be resumed exactly: the command is
//                 saved for the next start, but nothing is killed, because a
//                 restart now would boot an empty conversation.
//   restarted     saved, and the agent restarts on its own session.

import type { TerminalNodeData } from '../shared/model'
import type { TurnPhase } from '../shared/turn'

export type RelaunchVerdict = 'restarted' | 'asleep' | 'busy' | 'unrestorable' | 'gone'

export interface RelaunchDeps {
  node: (id: string) => TerminalNodeData | null
  phaseOf: (id: string) => TurnPhase | undefined
  /** Save the launch command on the card (the next spawn of it boots this). */
  setCommand: (id: string, command: string) => void
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

export function relaunchInPlace(deps: RelaunchDeps, id: string, command: string): RelaunchVerdict {
  const node = deps.node(id)
  if (node === null) return 'gone'
  if (!settled(deps.phaseOf(id))) return 'busy'
  deps.setCommand(id, command)
  if (!deps.live(id)) return 'asleep'
  if (!deps.restorable({ ...node, command })) return 'unrestorable'
  deps.respawn(id)
  return 'restarted'
}
