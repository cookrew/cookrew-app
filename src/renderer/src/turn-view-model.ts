import type { TerminalActivity } from '../../shared/turn'

/**
 * The view model both agent surfaces bind to. Pure — no React — so the canvas
 * card, the sidebar row and the tests all read the SAME derivation of "what is
 * this agent doing". Change it here and both surfaces change together, by
 * construction; neither can drift.
 */

export type TurnTone = 'working' | 'waiting' | 'done'

export interface TurnViewModel {
  /** Sous recap — the headline. */
  title: string | null
  /**
   * The ask, first meaningful line. Null when the tracker never saw the
   * prompt — a self-healed turn (reattach, or input sent around the PTY) is
   * still a REAL turn, so this being null does NOT mean "nothing to show".
   */
  ask: string | null
  /** Tool calls in TUI order, oldest→newest. */
  tools: string[]
  /** Live status verb, or the reply once the turn is done. */
  latest: { text: string; tone: TurnTone } | null
  /** Typed-but-unsent input — visibly IN the box, never posing as an ask. */
  pendingInput: string | null
  /** Screen tail, when no turn is tracked (reattach after a restart). */
  tail: string | null
}

/**
 * The Ready/blank state — the live tracker knows nothing to show. This is the
 * exact condition <TurnView> collapses to "Ready", so it is also the condition
 * under which a card falls back to its latest checkpoint (trace-perf T1).
 */
export function isEmptyTurnView(model: TurnViewModel): boolean {
  return (
    model.ask === null &&
    model.latest === null &&
    model.title === null &&
    model.tools.length === 0 &&
    model.tail === null
  )
}

/** The latest checkpoint a card shows without a PTY (trace-perf T1). */
export interface LatestCheckpoint {
  prompt: string
  reply: string
  title?: string
}

/**
 * A checkpoint → the SAME view model a live turn binds to, so a card with no
 * live activity (no PTY, never zoomed) renders its latest turn through the very
 * same <TurnView> — identical typography, no second code path. It reads as a
 * finished turn: the ask, the reply, done. No live status verb, no tool trail
 * (those are the zoomed/subscribed tiers); the card shows the LATEST checkpoint,
 * which is all it ever needs (owner ruling).
 */
export function checkpointViewModel(cp: LatestCheckpoint | null): TurnViewModel | null {
  if (!cp) return null
  const ask = cp.prompt.trim() ? firstLine(cp.prompt) : null
  const reply = cp.reply.trim() ? firstLine(cp.reply) : null
  if (!ask && !reply && !cp.title) return null
  return {
    title: cp.title ? firstLine(cp.title) : null,
    ask,
    tools: [],
    latest: reply ? { text: reply, tone: 'done' } : null,
    pendingInput: null,
    tail: null,
  }
}

/** First non-empty line, trimmed. Width truncation is CSS's job, not ours. */
function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.trim() ?? ''
  )
}

/** Drop the "(esc to interrupt · …)" chrome the TUI appends to its status. */
export function stripStatus(status: string | null | undefined): string | null {
  if (!status) return null
  const cleaned = status.replace(/\s*\((?:[^)]*esc to interrupt[^)]*)\)\s*$/i, '').trim()
  return cleaned.length > 0 ? cleaned : null
}

/**
 * The ONE selector. Both surfaces bind to its output — change what an agent
 * shows here and the card and the row change together, by construction.
 */
export function turnViewOf(activity: TerminalActivity | undefined): TurnViewModel {
  const empty: TurnViewModel = {
    title: null,
    ask: null,
    tools: [],
    latest: null,
    pendingInput: null,
    tail: null,
  }
  if (!activity) return empty

  const pendingInput = activity.pendingInput ? firstLine(activity.pendingInput) : null

  const inTurn = activity.phase === 'thinking' || activity.phase === 'waiting'

  // A NULL PROMPT IS NOT AN EMPTY TURN. The tracker loses the prompt whenever
  // it self-heals into a turn it did not start (reattach after a restart, or
  // input delivered around the PTY — herdr/tmux send-keys, the CLI, the
  // phone): TurnTracker.resumeThinking can only recover the prompt from the
  // TUI's own on-screen echo, and a long turn scrolls that echo away. Falling
  // through to the screen tail here threw away the phase, the Sous title, the
  // live status verb and the tool trail — cards under a running spinner
  // rendered as a lone '❯' with "LIVE · N CHECKPOINTS" beneath them.
  // So the tail is for agents with genuinely NOTHING running; a turn in
  // flight renders as a turn, with or without a known ask.
  if (activity.prompt === null && !inTurn) {
    // Reattached after a restart: no turn is tracked yet, but the session's
    // screen carries the latest turn — surface it rather than pretending the
    // agent is fresh.
    const lines = (activity.lines ?? []).filter((l) => l.trim().length > 0)
    return {
      ...empty,
      pendingInput,
      tail: lines.length > 0 ? lines[lines.length - 1] : null,
    }
  }

  const message = activity.glance?.message ? firstLine(activity.glance.message) : null
  const latest: TurnViewModel['latest'] =
    activity.phase === 'thinking'
      ? {
          text: stripStatus(activity.glance?.status) ?? 'Working…',
          tone: 'working',
        }
      : activity.phase === 'waiting'
        ? { text: message ?? 'Needs your input', tone: 'waiting' }
        : activity.reply
          ? { text: firstLine(activity.reply), tone: 'done' }
          : null

  return {
    title: activity.title ? firstLine(activity.title) : null,
    ask: activity.prompt === null ? null : firstLine(activity.prompt),
    tools: inTurn ? (activity.glance?.tools ?? []) : [],
    latest,
    pendingInput,
    tail: null,
  }
}
