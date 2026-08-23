// Fork preamble assembly, shared so main (injection) and tests agree on the
// exact text a forked agent receives.
//
// Forking is Cookrew's alternative to an in-place rewind: instead of rolling
// the ORIGINAL agent back to turn N (destroying everything after it), a fork
// spawns a NEW agent card seeded with the conversation history up to turn N
// and continues from there — the original keeps running untouched. Agents are
// opaque CLIs, so the seed is a plain-text transcript replay: agent-agnostic,
// works for Claude Code, Codex, OpenCode alike.

import type { TurnRecord } from './turn'

/** Longest reply excerpt replayed per turn (head is kept, tail dropped). */
const MAX_REPLY_CHARS = 1600
/** Longest prompt excerpt replayed per turn. */
const MAX_PROMPT_CHARS = 600
/** Overall preamble budget; oldest turns are elided beyond it. */
const MAX_PREAMBLE_CHARS = 20000

export interface ForkPreambleOptions {
  forkName: string
  sourceName: string
  /** Full source history; only records with index <= turnIndex are replayed. */
  turns: TurnRecord[]
  turnIndex: number
}

export interface AssembledNoticeOptions {
  forkName: string
  sourceName: string
  /** Checkpoint (turn) indexes assembled into this fork, ascending. */
  turnIndexes: number[]
}

/**
 * First message for a NATIVELY assembled fork: its resumed session contains
 * exactly the selected checkpoints, so no transcript replay — just which
 * checkpoints it woke up with.
 */
export function buildAssembledForkNotice(options: AssembledNoticeOptions): string {
  const list = options.turnIndexes.map((i) => `T${i}`).join(', ')
  return (
    `[Cookrew fork] You are "${options.forkName}", assembled from agent ` +
    `"${options.sourceName}" checkpoints ${list}. Your session contains exactly ` +
    `those exchanges — treat them as your own history; the original agent ` +
    `continues separately. Acknowledge briefly, then await instructions.`
  )
}

export interface ForkNoticeOptions {
  forkName: string
  sourceName: string
  turnIndex: number
}

/**
 * First message for a NATIVELY forked agent (resumed from a truncated copy
 * of the source's real session). It already has full context, so no
 * transcript replay — just who it is and that the branch is now its own.
 */
export function buildResumeForkNotice(options: ForkNoticeOptions): string {
  return (
    `[Cookrew fork] You are "${options.forkName}", a fork of the agent ` +
    `"${options.sourceName}" branched after its turn ${options.turnIndex}. ` +
    `This resumed session is your own copy — the original agent continues ` +
    `separately and is unaffected by anything you do. ` +
    `Acknowledge briefly, then continue from this point or await instructions.`
  )
}

function excerpt(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

function renderTurn(turn: TurnRecord): string {
  return [
    `── Turn ${turn.index} ──`,
    `User: ${excerpt(turn.prompt, MAX_PROMPT_CHARS)}`,
    `Agent: ${excerpt(turn.reply, MAX_REPLY_CHARS) || '(no visible reply)'}`
  ].join('\n')
}

/**
 * Build the first message sent to a freshly forked agent: who it is, the
 * transcript up to the fork point, and how to continue. Newest turns win the
 * budget — old ones collapse into an "[… N earlier turns omitted …]" marker.
 */
export function buildForkPreamble(options: ForkPreambleOptions): string {
  const replayed = options.turns.filter((t) => t.index <= options.turnIndex)
  if (replayed.length === 0) {
    throw new Error(`No turns up to index ${options.turnIndex} to fork from`)
  }

  const header =
    `[Cookrew fork] You are "${options.forkName}", a fork of the agent ` +
    `"${options.sourceName}" taken after its turn ${options.turnIndex}. ` +
    `Below is that conversation up to the fork point. Adopt it as your own ` +
    `context — the work described as done is already done; do not redo it.`

  const rendered = replayed.map(renderTurn)
  const budget = MAX_PREAMBLE_CHARS - header.length
  const kept: string[] = []
  let used = 0
  for (let i = rendered.length - 1; i >= 0; i -= 1) {
    if (used + rendered[i].length > budget && kept.length > 0) break
    kept.unshift(rendered[i])
    used += rendered[i].length + 2
  }
  const omitted = replayed.length - kept.length
  const transcript =
    omitted > 0 ? [`[… ${omitted} earlier turns omitted …]`, ...kept] : kept

  const footer =
    `You are now at the state right after turn ${options.turnIndex}. ` +
    `Acknowledge briefly, then continue from that point or await instructions.`

  return [header, ...transcript, footer].join('\n\n')
}

export interface AssembledPreambleOptions {
  forkName: string
  sourceName: string
  /** Full source history; only listed indexes are replayed, in given order. */
  turns: TurnRecord[]
  turnIndexes: number[]
}

/**
 * Team-fork "assembled" mode: replay a hand-picked subset of turns as the
 * fork's context, in the order the user chose them. Unknown indexes are
 * skipped; the newest picks win the budget like buildForkPreamble.
 */
export function buildAssembledPreamble(options: AssembledPreambleOptions): string {
  const byIndex = new Map(options.turns.map((t) => [t.index, t]))
  const picked = options.turnIndexes
    .map((i) => byIndex.get(i))
    .filter((t): t is TurnRecord => t !== undefined)
  if (picked.length === 0) {
    throw new Error(`None of the requested turns exist to assemble a fork from`)
  }

  const header =
    `[Cookrew fork] You are "${options.forkName}", a fork of the agent ` +
    `"${options.sourceName}" assembled from ${picked.length} selected ` +
    `turn${picked.length === 1 ? '' : 's'} of its conversation. Adopt the ` +
    `exchanges below as your own context — work described as done is ` +
    `already done; do not redo it.`

  const rendered = picked.map(renderTurn)
  const budget = MAX_PREAMBLE_CHARS - header.length
  const kept: string[] = []
  let used = 0
  for (let i = rendered.length - 1; i >= 0; i -= 1) {
    if (used + rendered[i].length > budget && kept.length > 0) break
    kept.unshift(rendered[i])
    used += rendered[i].length + 2
  }
  const omitted = picked.length - kept.length
  const transcript =
    omitted > 0 ? [`[… ${omitted} earlier selected turns omitted …]`, ...kept] : kept

  const footer =
    `Continue from the state these exchanges describe, or await instructions.`

  return [header, ...transcript, footer].join('\n\n')
}

/**
 * What the shipped prompt tells an agent about ENDING a turn.
 *
 * The defect is not that agents fail to announce, it is that they answer with
 * a plan and an orchestrator cannot tell that from still working.
 *
 * That is why the clause says STOP rather than "report": an agent that
 * continues past its own answer is doing work nobody is watching, and an
 * orchestrator polling for "is it done" sees the same silence either way.
 *
 * DELIBERATELY SILENT ABOUT FORMAT. A format request is the first thing a
 * model drifts from, and a drifted format reads as a missing announcement —
 * which would make the prompt a source of false negatives rather than a help.
 *
 * BELT, NEVER BRACES. This is advisory and nothing may depend on it. The
 * dispatch record and the turn tracker are the mechanisms; if a caller ever
 * waits for an agent to ANNOUNCE, the no-completion-signal defect is rebuilt
 * with better manners. Deleting this clause must never break a caller.
 */
export const COMPLETION_CLAUSE =
  'Completion. When you finish a piece of work, say so in one line and stop. ' +
  'Do not continue into the next task on your own — a turn that ends is the ' +
  'signal your orchestrator waits on, and work that continues past it is work ' +
  'nobody is watching. If you are handing off, name who and what in that same line.'

/** First message for an agent booted fresh from a saved role. */
export function buildRoleBootMessage(roleName: string, rolePrompt: string): string {
  return `[Cookrew role: ${roleName}] ${rolePrompt.trim()}\n\n${COMPLETION_CLAUSE}`
}
