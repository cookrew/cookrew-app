import { isHarnessNotice, noticeLine } from '../../shared/harness-notice'
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
  /**
   * Live status verb, or the reply once the turn is done. `text` is its first
   * line; `full` the whole message, present only when it says more than that.
   */
  latest: { text: string; tone: TurnTone; full?: string } | null
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
    model.pendingInput === null &&
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
  // A turn the harness started is nobody's ask (harness-notice.ts): no "You:"
  // line, and what it says stands in for a title until Sous has one.
  const notice = isHarnessNotice(cp.prompt)
  const ask = !notice && cp.prompt.trim() ? firstLine(cp.prompt) : null
  const reply = cp.reply.trim() ? said(cp.reply, 'done') : null
  const title = cp.title ? firstLine(cp.title) : notice ? noticeLine(cp.prompt) : null
  if (!ask && !reply && !title) return null
  return {
    title,
    ask,
    tools: [],
    latest: reply,
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

/** A message as a card holds it: its first line, and the rest when there is more. */
function said(text: string, tone: TurnTone): NonNullable<TurnViewModel['latest']> {
  const line = firstLine(text)
  const whole = text.trim()
  return whole === line ? { text: line, tone } : { text: line, tone, full: whole }
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

  const latest: TurnViewModel['latest'] =
    activity.phase === 'thinking'
      ? {
          text: stripStatus(activity.glance?.status) ?? 'Working…',
          tone: 'working',
        }
      : activity.phase === 'waiting'
        ? said(activity.glance?.message || 'Needs your input', 'waiting')
        : activity.reply
          ? said(activity.reply, 'done')
          : null

  // A turn the harness started is nobody's ask (harness-notice.ts).
  const notice = isHarnessNotice(activity.prompt)
  return {
    title: activity.title
      ? firstLine(activity.title)
      : notice && activity.prompt !== null
        ? noticeLine(activity.prompt)
        : null,
    ask: activity.prompt === null || notice ? null : firstLine(activity.prompt),
    tools: inTurn ? (activity.glance?.tools ?? []) : [],
    latest,
    pendingInput,
    tail: null,
  }
}

/**
 * Fold an incoming activity into what a card already knows.
 *
 * A MIRRORLESS activity carries a phase and deliberately nothing else — the
 * multiplexer knows what an agent is doing, not what it said. Letting it
 * replace a richer entry is how zooming out of a card (which detaches the
 * mirror, leaving the card on the canvas) would blank its prompt, its reply
 * and its unread mark on the next herdr tick. So it updates the phase and
 * keeps the words; a real activity, derived from a screen, replaces whole.
 */
export function mergeActivity(
  known: TerminalActivity | undefined,
  incoming: TerminalActivity
): TerminalActivity {
  if (incoming.mirrorless !== true || !known || known.mirrorless === true) return incoming
  // Still marked: the words are a mirror's, but the PHASE is the
  // multiplexer's guess, and the marker is what says so.
  return { ...known, mirrorless: true, phase: incoming.phase, waitChoice: incoming.waitChoice, updatedAt: incoming.updatedAt }
}
