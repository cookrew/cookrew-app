// Activity Board: the cross-workspace, task-first view of what the crew is
// doing right now (design: docs/briefs/agent-activity-board-design.html).
//
// The roster answers "which agents do I have"; the board answers "what is
// running, who is stuck, did that finish". Its row is a TASK (one turn), not
// an agent — the agent demotes to a badge.
//
// WHY A MERGE EXISTS AT ALL
// -------------------------
// Only the ACTIVE workspace holds live processes: a workspace switch detaches
// the outgoing terminals (index.ts `store.on('switch')` → turns.untrack +
// ptys.detach), so TurnTracker — and therefore /api/activity — can only ever
// see one workspace. The board must span all of them, so it merges three
// sources of DIFFERENT fidelity, and says which one each row came from:
//
//   L1 live   TurnTracker            active workspace, full fidelity
//   L2 probe  tmux capture-pane      any live pane, PHASE ONLY (no prompt)
//   L3 ledger ~/.cookrew/turns/*.json + agents.json   everything ever
//
// This module is pure: no fs, no tmux, no Electron. It takes the three
// already-read inputs and produces the ordered rows. That keeps the merge
// rules (precedence, phase mapping, ordering, windowing) unit-testable
// without a running app — the collectors that feed it live in main/.

import type { TerminalActivity, TurnRecord } from './turn'

/**
 * Board-level phase. Deliberately NOT TurnPhase: the board needs two
 * distinctions the tracker does not make — 'unread' (finished, not yet looked
 * at) is a separate row treatment from 'done', and 'offline' (no live pane at
 * all) is a state TurnPhase cannot express because the tracker only exists
 * for attached terminals.
 */
export type BoardPhase =
  /** Agent is producing output right now. */
  | 'working'
  /** Blocked on a human — the only state that warrants urgency styling. */
  | 'waiting'
  /** Turn complete, result never viewed (TurnRecord.seenAt absent). */
  | 'unread'
  /** Turn complete and acknowledged. */
  | 'done'
  /** No live pane — a historical row reconstructed from the ledger. */
  | 'offline'

/**
 * Which layer produced this row's phase. Surfaced to the UI on purpose: a
 * 'probe' row has no prompt for its in-flight turn (a detached pane has no
 * node-pty capturing input), so the UI must not render a live tail for it.
 * Degrading visibly rather than silently is the same rule the roster follows
 * when the bridge lacks recoverAgent.
 */
export type BoardSource = 'live' | 'probe' | 'ledger'

/**
 * Identity for a board row, supplied by the caller. Structurally compatible
 * with AgentRegistryEntry but declared here so `shared` never imports from
 * `main` (the registry is a main-process concern).
 */
export interface BoardAgentMeta {
  id: string
  name: string
  preset: string
  role: string | null
  cwd: string
  workspaceId: string
  workspaceName: string
  orch: boolean
  active: boolean
}

/** One task — the unit the board is built from. */
export interface BoardRow {
  /** Terminal node id: the join key across all three layers. */
  terminalId: string
  agent: {
    name: string
    preset: string
    role: string | null
    orch: boolean
  }
  workspace: {
    id: string
    name: string
    /** True when this row's workspace is the one currently loaded. */
    active: boolean
  }
  cwd: string
  task: {
    /** Sous title — the row's primary label. Null when never summarized. */
    title: string | null
    /**
     * Display-ready fallback label and second line: the prompt's first
     * meaningful line, wrapper-stripped, whitespace-collapsed and capped at
     * BOARD_SUMMARY_MAX.
     *
     * This replaced a raw `prompt` field. Every consumer only ever rendered
     * the first line of it, so shipping the full text (4.7 KB on one measured
     * row) bought nothing and put whole task bodies on the wire — including
     * onto a TV. Truncating at the SOURCE means no downstream view, and no
     * second "degraded" endpoint, has to be trusted to redact.
     */
    summary: string
    /** Index in the terminal's turn history (checkpoint number). */
    turnIndex: number
    startedAt: number
    /** Null while the turn is still in flight. */
    endedAt: number | null
  }
  phase: BoardPhase
  source: BoardSource
  /** THE sort key. Descending. */
  lastActivityAt: number
  turnCount: number
}

export interface MergeBoardInput {
  /** TurnTracker.list() — attached terminals plus registered HOT agents. */
  live: TerminalActivity[]
  /** terminalId → phase, from sampling detached panes. Probe knows no text. */
  probe: Map<string, BoardPhase>
  /** terminalId → its persisted turn history, oldest first. */
  ledger: Map<string, TurnRecord[]>
  /** Every known agent, across all workspaces. */
  registry: BoardAgentMeta[]
  /** Id of the currently loaded workspace (marks rows `workspace.active`). */
  activeWorkspaceId: string
  now: number
  /** Rows whose lastActivityAt is older than this are dropped. */
  windowMs: number
}

/** Default board window — see the design's recency measurements. */
export const BOARD_WINDOW_MS = 24 * 60 * 60 * 1000

/** Wider window behind the board's "show older" affordance. */
export const BOARD_WINDOW_WIDE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Map a live TerminalActivity phase onto the board vocabulary.
 *
 * 'replied' means the turn finished and has NOT been acknowledged — the
 * tracker demotes it to 'idle' the moment the user views it (seen()). So
 * 'replied' → 'unread' and 'idle' → 'done' is a faithful translation, not a
 * guess. An 'idle' terminal that never ran a turn has no row at all, which
 * the caller handles by skipping recordless terminals.
 */
export function livePhase(activity: TerminalActivity): BoardPhase {
  switch (activity.phase) {
    case 'thinking':
      return 'working'
    case 'waiting':
      return 'waiting'
    case 'replied':
      return 'unread'
    case 'idle':
      return 'done'
  }
}

/**
 * Phase for a terminal with no live or probe signal — pure history.
 * An unacknowledged last turn stays 'unread' forever (never a TTL: an unread
 * result must not silently expire), otherwise the row is 'offline' because
 * nothing proves a pane still exists.
 */
export function ledgerPhase(last: TurnRecord | undefined): BoardPhase {
  if (!last) return 'offline'
  return last.seenAt === undefined ? 'unread' : 'offline'
}

/**
 * Tags that ONLY ever appear in harness-generated wrappers — never in human
 * prose. The set is deliberately CLOSED and specific: the board must strip
 * `<task-notification>` scaffolding without touching a prompt that legitimately
 * talks about `<div>`, `<Foo />` or `List<string>`. Generic words that could
 * plausibly be user markup (status, summary, …) are intentionally absent.
 */
const SYSTEM_TAGS = [
  'task-notification',
  'task-id',
  'tool-use-id',
  'output-file',
  'system-reminder',
  'local-command-stdout',
  'local-command-stderr',
  'command-name',
  'command-message',
  'command-args'
] as const

const SYSTEM_TAG_ALTERNATION = SYSTEM_TAGS.join('|')

/** A complete `<tag>…</tag>` block, however many lines it spans. */
const SYSTEM_BLOCK_RE = new RegExp(
  `<(${SYSTEM_TAG_ALTERNATION})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`,
  'gi'
)

/**
 * A LINE that opens or closes one of those tags. Line-scoped on purpose: an
 * unbalanced wrapper (a truncated notification) must not swallow the rest of
 * the text, and a mid-sentence `<div>` must not match at all.
 */
const SYSTEM_LINE_RE = new RegExp(`^\\s*<\\/?(?:${SYSTEM_TAG_ALTERNATION})\\b`, 'i')

/**
 * Strip harness scaffolding out of prompt text, leaving the human-readable
 * part. Two passes, both conservative:
 *
 *  1. Remove COMPLETE `<system-reminder>…</system-reminder>`-style blocks —
 *     including inline ones, so "context <system-reminder>x</system-reminder>
 *     now do Y" keeps "context now do Y".
 *  2. Drop LINES that begin with a known system tag — this is what handles the
 *     truncated `<task-notification>\n<task-id>…` shape actually observed on
 *     the board, where no closing tag exists to match.
 *
 * Anything not in SYSTEM_TAGS is left completely alone, so ordinary prompts
 * containing HTML/JSX/generics survive byte-for-byte.
 */
export function stripSystemWrappers(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return ''
  let out = text
  // Nested wrappers need more than one pass; bounded so a pathological input
  // can never spin here.
  for (let pass = 0; pass < 4; pass += 1) {
    const next = out.replace(SYSTEM_BLOCK_RE, ' ')
    if (next === out) break
    out = next
  }
  const kept = out
    .split('\n')
    .filter((line) => !SYSTEM_LINE_RE.test(line))
    // Tidy ONLY the gaps an inline removal left behind: leading indentation is
    // preserved, because a prompt that pasted indented markup must come back
    // exactly as the human wrote it.
    .map((line) => {
      const [, indent = '', body = ''] = /^([ \t]*)([\s\S]*)$/.exec(line) ?? []
      return indent + body.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/, '')
    })
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * The human-readable task text of a turn: its prompt with harness scaffolding
 * removed. Empty when the turn was pure machine noise — the caller then falls
 * back to an earlier turn rather than rendering XML as a task title.
 */
export function taskText(record: TurnRecord | undefined): string {
  return record ? stripSystemWrappers(record.prompt) : ''
}

/** Hard cap on the board's task label. Nothing longer leaves this module. */
export const BOARD_SUMMARY_MAX = 140

/**
 * Turn prompt text into the short, display-ready label the board actually
 * renders. Strip FIRST, then take the first surviving line: a wrapper block
 * occupies the opening lines, so picking line 1 before stripping would throw
 * away the real request sitting underneath it.
 */
export function taskSummary(text: string): string {
  const cleaned = stripSystemWrappers(text)
  const firstLine = cleaned.split('\n').find((line) => line.trim().length > 0) ?? ''
  const collapsed = firstLine.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= BOARD_SUMMARY_MAX) return collapsed
  return `${Array.from(collapsed).slice(0, BOARD_SUMMARY_MAX - 1).join('')}…`
}

/**
 * The turn a row should DISPLAY: the most recent one that still has readable
 * text after stripping. Falls back to the genuine last turn when every turn is
 * noise, so the row keeps its timing and the UI can show its own placeholder.
 *
 * Note this only moves the displayed TASK — `lastActivityAt` continues to come
 * from the real last turn, so a row's position on the timeline stays truthful.
 */
function displayRecord(history: readonly TurnRecord[]): TurnRecord | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (taskText(history[i]).length > 0) return history[i]
  }
  return history.length > 0 ? history[history.length - 1] : undefined
}

/**
 * Merge the three layers into the ordered board.
 *
 * Rules this must satisfy (see tests/board-merge.test.ts):
 *  1. One row per terminal, keyed by terminalId; L1 beats L2 beats L3.
 *  2. Rows sort by lastActivityAt DESC — the only ordering. Waiting rows are
 *     NOT floated: the board is a timeline, and urgency is carried by the
 *     phase styling plus the aggregate counts, not by reordering.
 *  3. A terminal with no turn history and no live turn produces NO row —
 *     that is what keeps 189 inactive agents off the screen.
 *  4. Rows older than windowMs are dropped.
 *  5. A row whose agent is missing from the registry is still emitted, with
 *     placeholder identity — losing a task because the registry lagged would
 *     be worse than showing it unlabeled.
 */
export function mergeBoard(input: MergeBoardInput): BoardRow[] {
  const { live, probe, ledger, registry, activeWorkspaceId, now, windowMs } = input
  const metaById = new Map(registry.map((m) => [m.id, m]))
  const liveById = new Map(live.map((a) => [a.terminalId, a]))

  // Candidates come from the SIGNAL layers, never the registry: an agent that
  // never ran a turn has no task, and that is the 228 → 8 collapse (rule 3).
  const ids = new Set<string>([...liveById.keys(), ...probe.keys(), ...ledger.keys()])

  const cutoff = now - windowMs
  const rows: BoardRow[] = []

  for (const terminalId of ids) {
    const activity = liveById.get(terminalId)
    const history = ledger.get(terminalId) ?? []
    const last = history.length > 0 ? history[history.length - 1] : undefined

    // Precedence: L1 live beats L2 probe beats L3 ledger (rule 1).
    const probePhase = probe.get(terminalId)
    const source: BoardSource = activity ? 'live' : probePhase ? 'probe' : 'ledger'
    const phase: BoardPhase = activity
      ? livePhase(activity)
      : (probePhase ?? ledgerPhase(last))

    // A live turn is IN FLIGHT while the tracker reports thinking/waiting —
    // then the row's task is that turn, and it has no end yet.
    const inFlight = activity !== undefined && (phase === 'working' || phase === 'waiting')

    // No live turn and no history → nothing to show (rule 3).
    if (!inFlight && !last) continue

    // A probe row must NOT invent text: a detached pane has no node-pty, so
    // the task stays the last KNOWN one and `source` tells the UI to withhold
    // the live tail. Only a LIVE in-flight turn may use the captured prompt.
    // Prompts can arrive wrapped in harness scaffolding (a task-notification
    // block, a system-reminder). Rendering that as a task title puts raw XML on
    // the wall display, so strip it and fall back to the most recent turn that
    // still reads as a task. Sous `title` keeps its priority untouched.
    const display = displayRecord(history)
    const ledgerSummary = taskSummary(display?.prompt ?? '')
    const task = inFlight
      ? {
          title: activity.title ?? display?.title ?? null,
          summary: taskSummary(activity.prompt ?? '') || ledgerSummary,
          turnIndex: (last?.index ?? 0) + 1,
          startedAt: activity.turnStartedAt ?? activity.updatedAt,
          endedAt: null
        }
      : {
          title: display?.title ?? null,
          summary: ledgerSummary,
          turnIndex: display?.index ?? 0,
          startedAt: display?.startedAt ?? 0,
          endedAt: display?.endedAt ?? null
        }

    const lastActivityAt = inFlight
      ? (activity.turnStartedAt ?? activity.updatedAt)
      : (last?.endedAt ?? activity?.updatedAt ?? 0)

    // An agent that is demonstrably alive is never windowed out — "a 30-hour
    // agent is exactly the one you must not lose off the board". A probe row
    // counts too: its pane is working even though its last KNOWN task is old.
    const alive = inFlight || (source === 'probe' && (phase === 'working' || phase === 'waiting'))
    if (!alive && lastActivityAt < cutoff) continue

    // A row whose agent is missing from the registry is still emitted with
    // placeholder identity (rule 5) — losing the task would be worse.
    const meta = metaById.get(terminalId)
    const workspaceId = meta?.workspaceId ?? activeWorkspaceId

    rows.push({
      terminalId,
      agent: {
        name: meta?.name ?? 'Unknown agent',
        preset: meta?.preset ?? 'unknown',
        role: meta?.role ?? null,
        orch: meta?.orch ?? false
      },
      workspace: {
        id: workspaceId,
        name: meta?.workspaceName ?? 'Unknown workspace',
        active: workspaceId === activeWorkspaceId
      },
      cwd: meta?.cwd ?? '',
      task,
      phase,
      source,
      lastActivityAt,
      // Completed turns known for this terminal. The ledger is authoritative;
      // the tracker's count covers a terminal whose history hasn't flushed.
      turnCount: Math.max(history.length, activity?.turnCount ?? 0)
    })
  }

  // Ordering is a TIMELINE and nothing else — waiting rows are deliberately
  // NOT floated (rule 2). terminalId breaks ties so the order is stable.
  return rows.sort(
    (a, b) =>
      b.lastActivityAt - a.lastActivityAt || a.terminalId.localeCompare(b.terminalId)
  )
}

/** Aggregate counters for the board header strip. */
export interface BoardSummary {
  working: number
  waiting: number
  /** Turns completed inside the window (unread + done). */
  doneInWindow: number
  /** preset → row count, for the model mix bar. */
  presetMix: Record<string, number>
}

export function summarizeBoard(rows: BoardRow[]): BoardSummary {
  const presetMix: Record<string, number> = {}
  let working = 0
  let waiting = 0
  let doneInWindow = 0

  for (const row of rows) {
    if (row.phase === 'working') working += 1
    else if (row.phase === 'waiting') waiting += 1
    // 'unread' and 'done' are both COMPLETED turns; they differ only in
    // whether the result was acknowledged. 'offline' is a reconstructed
    // historical row, not a completion observed inside this window.
    else if (row.phase === 'unread' || row.phase === 'done') doneInWindow += 1
    presetMix[row.agent.preset] = (presetMix[row.agent.preset] ?? 0) + 1
  }

  return { working, waiting, doneInWindow, presetMix }
}
