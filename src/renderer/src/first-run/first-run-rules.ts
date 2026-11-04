import type { CanvasNode } from '../../../shared/model'
import type { PreflightRow } from '../../../shared/preflight'
import type { TerminalActivity, TurnPhase } from '../../../shared/turn'
import { SETUP_CARD_NAME } from '../routing/use-setup-terminal'
import { SHELL_PRESET } from '../prompt/harness-pref'

/** The first run's small decisions, pure, so each is tested without a screen. */

/** Terminals of the person's own: the Setup card the tool check made is not their first agent. */
export function realAgents(nodes: readonly CanvasNode[]): number {
  return nodes.filter((n) => n.kind === 'terminal' && !(n.name === SETUP_CARD_NAME && n.preset === SHELL_PRESET)).length
}

/** The tool the first agent runs on: the first one found; the row's name is the preset's. */
export function firstHarness(rows: readonly PreflightRow[]): string | null {
  return rows.find((r) => (r.id === 'claude' || r.id === 'codex') && r.state === 'found')?.name ?? null
}

interface Seen {
  readonly phase: TurnPhase
  readonly turns: number
}

export type TurnMemory = ReadonlyMap<string, Seen>

const working = (phase: TurnPhase): boolean => phase === 'thinking' || phase === 'waiting'

/**
 * DID A TURN JUST END? An agent working that reached its reply, or a new
 * completed turn for one whose phase never showed the work. First sight says
 * nothing (a reply already on screen is old), and a shell is never an agent.
 */
export function stepTurns(memory: TurnMemory, activities: Iterable<TerminalActivity>): { memory: TurnMemory; ended: boolean } {
  const next = new Map(memory)
  let ended = false
  for (const activity of activities) {
    if (!activity.agent) continue
    const before = memory.get(activity.terminalId)
    if (before && ((working(before.phase) && activity.phase === 'replied') || activity.turnCount > before.turns)) ended = true
    next.set(activity.terminalId, { phase: activity.phase, turns: activity.turnCount })
  }
  return { memory: next, ended }
}
