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

/** First message for an agent booted fresh from a saved role. */
export function buildRoleBootMessage(roleName: string, rolePrompt: string): string {
  return `[Cookrew role: ${roleName}] ${rolePrompt.trim()}`
}
