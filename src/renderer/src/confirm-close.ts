import type { CanvasNode } from '../../shared/model'
import { browserTabs } from '../../shared/model'
import type { TurnPhase } from '../../shared/turn'

/**
 * What a close confirmation says.
 *
 * A confirm that only asks "are you sure?" trains people to click through it,
 * because it adds a step without adding information. These prompts name the
 * thing being closed and what closing it actually costs — which differs enough
 * per kind that one generic sentence would be wrong for two of the three:
 *
 *   terminal  ends a live session, but the roster can RECOVER it
 *   note      the text exists nowhere else — the only truly lossy one
 *   browser   closes N tabs, cheap to reopen
 *   served    ends a session on SOMEONE ELSE's machine, which nothing here
 *             can recover — and on a paid door, one that was bought
 *
 * `danger` is reserved for the cases where something is lost or interrupted,
 * so the loud styling still means something when it appears.
 *
 * Pure, so the copy and the danger rule are unit-tested without a DOM.
 */
export interface ClosePrompt {
  title: string
  /** Which one — name, preset, or the note's first line. */
  subject: string
  /** What closing it costs, in plain words. */
  consequence: string
  confirmLabel: string
  /** True when something is genuinely lost or a live turn is interrupted. */
  danger: boolean
}

/** First non-empty line, trimmed and capped — enough to tell two notes apart. */
function firstLine(text: string, max = 48): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * Only the phase is consulted, so that is all this asks for — a full
 * TerminalActivity would be a dependency on fourteen fields it never reads.
 * A real activity satisfies it structurally.
 */
export function closePrompt(
  node: CanvasNode,
  activity?: { phase: TurnPhase } | null
): ClosePrompt {
  if (node.kind === 'note') {
    const line = firstLine(node.content)
    return {
      title: 'Delete this note?',
      subject: line.length > 0 ? line : 'Empty note',
      // The genuinely irreversible one: no session to resume, no page to
      // reopen. Say so plainly rather than sharing the agents' softer wording.
      consequence:
        line.length > 0
          ? 'Its text is not kept anywhere else.'
          : 'Nothing is written in it yet.',
      confirmLabel: 'Delete note',
      danger: line.length > 0,
    }
  }

  if (node.kind === 'browser') {
    const count = browserTabs(node).length
    return {
      title: 'Close this browser?',
      subject: node.name,
      consequence: `${count} ${count === 1 ? 'tab' : 'tabs'} will close. Pages can be opened again.`,
      confirmLabel: 'Close browser',
      danger: false,
    }
  }

  // A PLACED ORCH CARD IS NOT A LOCAL AGENT, and closing it is not recoverable
  // from the roster — the session lives at the author's app, and re-importing
  // admits a NEW one. On a paid door that is a purchase, so the prompt quotes
  // what was actually paid (kept at admission, never re-derived) and wears
  // `danger`. Placed before the ordinary terminal answer, which would
  // otherwise promise a recovery that does not exist here.
  if (node.servedSession) {
    const { paid, slug } = node.servedSession
    return {
      title: 'End this session?',
      subject: node.name,
      consequence: paid
        ? `You paid ${paid.price} ${paid.asset} for it. Starting again later is a new session at the same price. Files it made stay on @${slug}'s machine, not yours.`
        : `Starting again opens a new one. Its owner lends this door a limited number, so a new session may not be available.`,
      confirmLabel: 'End session',
      // Money is the line: a free session costs a seat, a paid one costs money.
      danger: paid !== undefined
    }
  }

  const working = activity?.phase === 'thinking'
  const waiting = activity?.phase === 'waiting'
  const role = node.role ? ` · ${node.role}` : ''
  return {
    title: 'Close this agent?',
    subject: `${node.name} · ${node.preset}${role}${node.orch ? ' · ORCH' : ''}`,
    consequence: working
      ? 'It is working right now — that turn is lost. You can recover the agent from Agents.'
      : waiting
        ? 'It is waiting on you — that question goes unanswered. You can recover the agent from Agents.'
        : 'Ends its session. You can recover the agent from Agents.',
    confirmLabel: 'Close agent',
    danger: working || waiting,
  }
}
