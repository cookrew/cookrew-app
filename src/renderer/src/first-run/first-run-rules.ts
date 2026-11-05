import type { FirstTask } from '../../../shared/first-run'
import { turnFailure } from '../../../shared/turn-failure'
import type { CanvasNode } from '../../../shared/model'
import { AGENT_TOOLS, type PreflightRow } from '../../../shared/preflight'
import type { TerminalActivity, TurnPhase } from '../../../shared/turn'
import { SHELL_PRESET } from '../prompt/harness-pref'

/** The first run's small decisions, pure, so each is tested without a screen. */

/**
 * An agent of the person's own has really started: it works, or has finished a
 * turn. A card alone proves nothing: a dead agent has one, and a refused one reads
 * as replied, and the first run must not move on either. A Shell is no agent, the Setup card least of all.
 */
export function agentAtWork(nodes: readonly CanvasNode[], activities: readonly TerminalActivity[]): boolean {
  const agents = new Set(nodes.filter((n) => n.kind === 'terminal' && n.preset !== SHELL_PRESET).map((n) => n.id))
  return activities.some((a) => agents.has(a.terminalId) && (a.phase !== 'idle' || a.turnCount > 0) && turnFailure(a) === null)
}

/**
 * An agent made some other way (a phone, the CLI) ends the screens. Not while a
 * task is held: that outcome is main's to say. And not the agent a task was taken
 * back from: its card reads as working for a beat as it goes.
 */
export function otherAgentEnds(nodes: readonly CanvasNode[], activities: readonly TerminalActivity[], task: FirstTask | null): boolean {
  if (task?.state === 'holding' || task?.state === 'sent') return false
  const gone = task?.id
  return agentAtWork(nodes.filter((n) => n.id !== gone), activities)
}

/** A saved endpoint runs on certain tools: the first of them that is here, or the first to install. */
export function firstAgentHarness(rows: readonly PreflightRow[], endpointTools: readonly string[] | null): string | null {
  if (endpointTools === null || endpointTools.length === 0) return firstHarness(rows)
  return endpointTools.find((tool) => rows.some((r) => r.name === tool && r.state === 'found')) ?? endpointTools[0]
}

/** The tool the first agent runs on: the first one found; the row's name is the preset's. */
export function firstHarness(rows: readonly PreflightRow[]): string | null {
  return rows.find((r) => AGENT_TOOLS.includes(r.id) && r.state === 'found')?.name ?? null
}

interface Seen {
  readonly phase: TurnPhase
  readonly turns: number
}

export type TurnMemory = ReadonlyMap<string, Seen>

const working = (phase: TurnPhase): boolean => phase === 'thinking' || phase === 'waiting'

/**
 * WHICH TURNS JUST ENDED? An agent working that reached its reply, or a new turn
 * on record once it has stopped. A rising count alone is nothing: a file-backed
 * harness records a turn as it STARTS, and "finished" was said 5 s into the work.
 * First sight says nothing (a reply already on screen is old), a shell is never
 * an agent, a refused turn did not finish, and a turn that just stopped (a dead
 * agent) did not reach a reply.
 */
export function stepTurns(memory: TurnMemory, activities: Iterable<TerminalActivity>): { memory: TurnMemory; ended: readonly string[] } {
  const next = new Map(memory)
  const ended: string[] = []
  for (const activity of activities) {
    if (!activity.agent) continue
    const before = memory.get(activity.terminalId)
    const reached = before !== undefined && !working(activity.phase) && ((working(before.phase) && activity.phase === 'replied') || activity.turnCount > before.turns)
    if (reached && turnFailure(activity) === null) ended.push(activity.terminalId)
    next.set(activity.terminalId, { phase: activity.phase, turns: activity.turnCount })
  }
  return { memory: next, ended }
}

/** Looked at again a moment later: a quiet patch inside a turn starts working again. */
export function stillFinished(activity: TerminalActivity | undefined): boolean {
  return activity !== undefined && !working(activity.phase) && turnFailure(activity) === null
}

/**
 * The first task's turn ended well. Read at any sight, not on an edge: a restart
 * mid-turn sees no edge, and a sent task must not wait for a turn that is over.
 * The count says a turn exists: a sent task's agent can be idle before it starts.
 */
export function sentTurnDone(task: FirstTask | null, activity: TerminalActivity | undefined): boolean {
  return task?.state === 'sent' && activity?.terminalId === task.id && activity.turnCount > 0 && stillFinished(activity)
}

/** It stopped on a refusal: nothing moves, and the person is offered the way back. */
export function sentTurnFailed(task: FirstTask | null, activity: TerminalActivity | undefined): boolean {
  return task?.state === 'sent' && activity?.terminalId === task.id && !working(activity.phase) && turnFailure(activity) !== null
}
