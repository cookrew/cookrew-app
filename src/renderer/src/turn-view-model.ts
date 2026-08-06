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
  /** The ask, first meaningful line. */
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

  if (activity.prompt === null) {
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

  const inTurn = activity.phase === 'thinking' || activity.phase === 'waiting'
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
    ask: firstLine(activity.prompt),
    tools: inTurn ? (activity.glance?.tools ?? []) : [],
    latest,
    pendingInput,
    tail: null,
  }
}
