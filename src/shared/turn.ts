// Turn tracking model shared between main (TurnTracker) and renderer cards.
//
// A "turn" is one prompt→reply exchange with a code agent running inside a
// PTY. Agents are plain CLIs (claude/codex/...), so turn boundaries are
// derived from the byte streams: Enter on the input side starts a turn,
// output quiescence ends it. These helpers are pure so they can be unit
// tested without a PTY.

/**
 * 'waiting' is vibe-island's "needs attention": the turn is not finished,
 * the agent went quiet on a permission prompt / question menu.
 */
export type TurnPhase = 'idle' | 'thinking' | 'waiting' | 'replied'

export interface TerminalActivity {
  terminalId: string
  /** True when the terminal runs an agent preset (non-empty command). */
  agent: boolean
  phase: TurnPhase
  /** Prompt that started the current turn, best-effort echo of typed input. */
  prompt: string | null
  /**
   * Typed-or-pasted input sitting UNSENT in the agent's input box (cleared
   * on submit) — lets cards render a dim "typing:" line. Null when empty.
   */
  pendingInput: string | null
  /**
   * Summary lines: the live thinking tail while phase is 'thinking' (or the
   * pending question while 'waiting'), otherwise a cleaned viewport tail.
   */
  lines: string[]
  /** Cleaned reply text once the current turn completed. */
  reply: string | null
  /** Structured at-a-glance view of the turn, parsed from the agent TUI. */
  glance: AgentGlance | null
  /**
   * Short local-model summary of what the current turn is doing (Sous).
   * Null until the first summary lands or when no local model is running.
   */
  title: string | null
  /** Completed turns recorded for this terminal (drives the card pager). */
  turnCount: number
  /** Epoch ms when the current turn started; null outside a turn. */
  turnStartedAt: number | null
  updatedAt: number
}

/**
 * One completed prompt→reply exchange, kept per terminal so cards can page
 * back through past turns and fork new agents from any of them. `index` is
 * 1-based and monotonic — it stays stable even after old records are capped
 * away, so "turn 7" always means the same exchange.
 */
export interface TurnRecord {
  index: number
  prompt: string
  reply: string
  /** Sous title captured when the turn completed, if one was generated. */
  title?: string
  /**
   * Session message uuid of the prompt entry that started this turn — the
   * exact binding to the Claude session file. Present only for
   * session-derived records; absent for scrape-based turns (non-Claude
   * agents, or before a session file exists). Fork cutoff and title
   * carryover key on this when set.
   */
  uuid?: string
  startedAt: number
  endedAt: number
  /**
   * Epoch ms when the user viewed this result (acknowledge-on-view). Absent
   * = unread: a restart restores the LAST record's unread state as
   * TURN COMPLETE instead of silently dropping it to READY.
   */
  seenAt?: number
}

/** Cap on retained turn records per terminal (oldest dropped first). */
export const MAX_TURN_HISTORY = 100

/**
 * Synthetic prompt for turns the tracker's self-healing opened without ever
 * seeing a typed prompt (tmux reattach, missed turn start). History rows
 * then read "(recovered turn)" instead of an impossible empty prompt.
 */
export const RECOVERED_PROMPT_LABEL = '(recovered turn)'

/**
 * Prompt echo painted by agent TUIs at turn start ("> fix the bug"). Menu
 * rows ("❯ 1. Yes") are excluded so approval menus never read as prompts.
 */
const PROMPT_ECHO_RE = /^\s*[>❯]\s+(\S.*)$/
const MENU_ROW_RE = /^\d+\.\s/

/**
 * Best-effort prompt recovery for a turn the tracker never saw typed (tmux
 * reattach, missed capture): the most recent prompt echo in the rendered
 * transcript. Null when nothing plausible is on screen.
 */
export function extractPromptEcho(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = PROMPT_ECHO_RE.exec(lines[i])
    if (m && !MENU_ROW_RE.test(m[1])) return m[1].trim()
  }
  return null
}

/** Append a completed turn immutably, assigning the next index and capping. */
export function appendTurnRecord(
  history: TurnRecord[],
  turn: Omit<TurnRecord, 'index'>,
  max = MAX_TURN_HISTORY
): TurnRecord[] {
  const index = (history[history.length - 1]?.index ?? 0) + 1
  const next = [...history, { ...turn, index }]
  return next.length > max ? next.slice(next.length - max) : next
}

/** Vibe-island style glance: status verb, recent tools, latest message. */
export interface AgentGlance {
  /** Live spinner/status line, e.g. "Cerebrating… (34s · ↓ 2.1k tokens)". */
  status: string | null
  /** Recent tool invocations this turn, oldest→newest (max 3). */
  tools: string[]
  /** Latest assistant message text (may still be streaming). */
  message: string | null
}

const MAX_PROMPT_BUFFER = 2000

/**
 * Terminal input escape sequences: CSI with optional private prefix
 * (cursor keys, bracketed paste markers, SGR mouse reports like
 * `\x1b[<0;39;37M`) and SS3 (application-mode cursor keys).
 */
const CSI_RE = /\x1b(?:\[[<>=?]?[0-9;]*[@-~]|O[@-~])/g

/**
 * OSC sequences (window title, color set/query). Under tmux, a GUI xterm
 * answering tmux's OSC 10/11 color *queries* injects the response
 * (`]11;rgb:1414/1111/0a0a`) back into the input stream, which would
 * otherwise land in the prompt buffer. OSC_RE matches complete sequences;
 * OSC_COLOR_REMNANT_RE mops up responses whose leading ESC was split across
 * chunks (so only the `]1x;rgb:…` tail remains).
 */
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const OSC_COLOR_REMNANT_RE = /\x1b?\]1[01];rgb:[0-9a-fA-F/]+\\?/g

/** The cookrew tmux status bar line (status-left is "cookrew · <session>"). */
const TMUX_STATUS_RE = /^\s*cookrew · /

/** Strip terminal control noise that would otherwise pollute turn text. */
function stripTermNoise(text: string): string {
  return text.replace(OSC_RE, '').replace(OSC_COLOR_REMNANT_RE, '')
}

export interface PromptFeed {
  buffer: string
  /** Lines submitted with Enter during this feed, in order. */
  submitted: string[]
  /** True while a bracketed paste is open (ESC[200~ seen, no ESC[201~ yet). */
  inPaste: boolean
  /**
   * Trailing bytes withheld because they might be the START of a paste
   * marker split across chunks — prepend to the next feed. Without this, a
   * split ESC[200~ degrades pasted text to "typed" and a CR inside it
   * submits a phantom prompt (attachment-path mispair defect).
   */
  held: string
}

/** Bracketed-paste markers, matched BEFORE the CSI strip would eat them. */
const PASTE_OPEN = '\x1b[200~'
const PASTE_CLOSE = '\x1b[201~'

/**
 * Length of the longest PROPER prefix of a paste marker that `data` ends
 * with (both markers share '\x1b[20'). 0 when the tail can't be a marker.
 */
function trailingMarkerPrefixLen(data: string): number {
  for (let len = Math.min(5, data.length); len >= 1; len -= 1) {
    const tail = data.slice(data.length - len)
    if (PASTE_OPEN.startsWith(tail) || PASTE_CLOSE.startsWith(tail)) return len
  }
  return 0
}

/**
 * Bytes inside a bracketed paste are literal prompt text, exactly as agent
 * TUIs treat them: CR/LF become newlines in the buffer — never submits —
 * and other control bytes are dropped.
 */
function appendPastedText(buffer: string, segment: string): string {
  const text = stripTermNoise(segment)
    .replace(CSI_RE, '')
    .replace(/\r\n?/g, '\n')
    .split('')
    .filter((char) => char === '\n' || char === '\t' || (char >= ' ' && char !== '\x7f'))
    .join('')
  return (buffer + text).slice(0, MAX_PROMPT_BUFFER)
}

/** Keystrokes outside a paste: Enter submits, backspace edits, ctrl-c/u clears. */
function feedTypedSegment(
  buffer: string,
  segment: string
): { line: string; submitted: string[] } {
  const submitted: string[] = []
  let line = buffer
  const plain = stripTermNoise(segment).replace(CSI_RE, '')
  for (const char of plain) {
    if (char === '\r' || char === '\n') {
      submitted.push(line.trim())
      line = ''
    } else if (char === '\x7f' || char === '\b') {
      line = line.slice(0, -1)
    } else if (char === '\x03' || char === '\x15') {
      line = ''
    } else if (char >= ' ' && char !== '\x1b') {
      line = line.length < MAX_PROMPT_BUFFER ? line + char : line
    }
  }
  return { line, submitted }
}

/**
 * Accumulate typed input into a prompt line, best effort. Handles Enter
 * (submit), backspace, ctrl-c/ctrl-u (clear) and strips escape sequences.
 * Bracketed pastes buffer their content verbatim without ever submitting;
 * `inPaste` carries the open-paste state across chunks, since the close
 * marker may arrive in a different chunk than the pasted content.
 */
export function feedPromptBuffer(
  buffer: string,
  data: string,
  inPaste = false,
  held = ''
): PromptFeed {
  const submitted: string[] = []
  let line = buffer
  let pasting = inPaste
  let rest = held + data
  // Withhold a trailing partial marker until the next chunk completes it.
  const partial = trailingMarkerPrefixLen(rest)
  const heldOut = partial > 0 ? rest.slice(rest.length - partial) : ''
  if (partial > 0) rest = rest.slice(0, rest.length - partial)
  while (rest.length > 0) {
    const marker = pasting ? PASTE_CLOSE : PASTE_OPEN
    const at = rest.indexOf(marker)
    const segment = at === -1 ? rest : rest.slice(0, at)
    rest = at === -1 ? '' : rest.slice(at + marker.length)
    if (pasting) {
      line = appendPastedText(line, segment)
    } else {
      const fed = feedTypedSegment(line, segment)
      line = fed.line
      submitted.push(...fed.submitted)
    }
    if (at !== -1) pasting = !pasting
  }
  return { buffer: line, submitted, inPaste: pasting, held: heldOut }
}

/** Lines that are pure TUI chrome: box drawing, rules, empty input boxes. */
const CHROME_RE = /^[\s─│┃╭╮╰╯┌┐└┘═║━┏┓┗┛┠┨┝┥├┤]+$/
const INPUT_BOX_RE = /^\s*[│┃]\s*>?\s*[│┃]?\s*$/
const STATUS_RE =
  /esc to interrupt|\? for shortcuts|bypass(?:ing)? permissions|shift\+tab to cycle|for agents\b/i

/**
 * Reduce raw appended terminal text to displayable summary lines: drop TUI
 * frames, status bars (including the tmux one), OSC noise and blank runs
 * while keeping the actual content.
 */
export function cleanTurnLines(text: string): string[] {
  const lines = stripTermNoise(text)
    .split('\n')
    .map((l) => l.replace(/\s+$/g, ''))
  const kept = lines.filter(
    (l) =>
      !CHROME_RE.test(l) &&
      !INPUT_BOX_RE.test(l) &&
      !STATUS_RE.test(l) &&
      !TMUX_STATUS_RE.test(l)
  )
  return kept.reduce<string[]>((acc, line) => {
    if (line === '' && acc[acc.length - 1] === '') return acc
    return [...acc, line]
  }, [])
}

/** Last `n` lines, without leading blanks. */
export function tailLines(lines: string[], n: number): string[] {
  const tail = lines.slice(-n)
  const firstContent = tail.findIndex((l) => l !== '')
  return firstContent <= 0 ? tail : tail.slice(firstContent)
}

/**
 * Signatures of agent TUIs blocked on the human: permission approvals,
 * numbered choice menus, y/n confirms. Checked against the tail of a turn
 * that just went quiet to distinguish 'waiting' from 'replied'.
 */
const ATTENTION_RES = [
  /do you want|would you like|proceed\?/i,
  /enter to confirm|esc to cancel|press enter/i,
  /\(y\/n\)|\[y\/n\]/i,
  /^\s*[❯>]?\s*\d+\.\s+(yes|no|allow|deny|approve|reject)/i,
  /allow this|grant access|permission request|needs your approval/i,
  /waiting for (your )?(input|approval|response)/i
]

/** True when the quiet tail looks like a question the agent is blocked on. */
export function detectAttention(lines: string[]): boolean {
  const tail = lines.slice(-10)
  return tail.some((line) => ATTENTION_RES.some((re) => re.test(line)))
}

/** Spinner glyphs used by Claude Code / Codex style TUI status lines. */
const SPINNER_LINE_RE = /^\s*[✻✽✳✢✶✦✺✹✸✷·∗*+]\s+(\S.*)$/
/**
 * A spinner line counts as a status when it carries progress chrome:
 * ellipsis, parens, elapsed time ("Baked for 1m 6s"), or token counts.
 */
const STATUS_HINT_RE = /…|\(|esc to interrupt|tokens|\b\d+m?\s?\d*s\b/i
/** ⏺ entry: either Tool(args…) or a plain assistant message. */
const ENTRY_RE = /^\s*[⏺●○]\s+(.*)$/
const TOOL_RE = /^([A-Z][\w-]*)\((.*)$/
const MARKER_RE = /^\s*([⏺●○⎿✻✽✳✢✶✦✺✹✸✷>│┃╭╰]|[·∗*+]\s)/

/**
 * Parse an agent TUI transcript slice (the raw current-turn delta) into the
 * vibe-island style glance: latest status verb, latest tool call, latest
 * assistant message. Best effort — anything unmatched stays null.
 */
export function parseAgentGlance(text: string): AgentGlance {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/g, ''))

  let status: string | null = null
  for (const line of lines.slice(-15).reverse()) {
    const m = SPINNER_LINE_RE.exec(line)
    if (m && STATUS_HINT_RE.test(m[1])) {
      status = m[1]
      break
    }
  }

  const tools: string[] = []
  let message: string | null = null
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const entry = ENTRY_RE.exec(lines[i])
    if (!entry) continue
    const body = entry[1].trim()
    if (TOOL_RE.test(body)) {
      if (tools.length < 3) tools.unshift(body.length > 120 ? `${body.slice(0, 119)}…` : body)
      continue
    }
    if (message !== null || body.length === 0) continue
    const parts = [body]
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j]
      if (next === '' || MARKER_RE.test(next)) break
      parts.push(next.trim())
    }
    const joined = parts.join('\n')
    message = joined.length > 700 ? `${joined.slice(0, 699)}…` : joined
  }

  return { status, tools, message }
}

/**
 * True when a raw output chunk contains agent-transcript activity: a
 * spinner/status line or a ⏺ entry. The tracker's self-healing uses this to
 * decide that output arriving during 'replied'/'idle' is the agent working,
 * not typed-echo or shell noise.
 */
export function detectAgentActivity(chunk: string): boolean {
  const lines = stripTermNoise(chunk).replace(CSI_RE, '').split('\n')
  return lines.some((line) => {
    const spinner = SPINNER_LINE_RE.exec(line)
    if (spinner && STATUS_HINT_RE.test(spinner[1])) return true
    const entry = ENTRY_RE.exec(line)
    return entry !== null && entry[1].trim().length > 0
  })
}

/**
 * Completed-turn status body: "Brewed for 4m 15s" — past-tense verb plus
 * elapsed time. Checked before the live hints because completed lines can
 * also carry counters ("Baked for 1m 6s · ↓ 2.1k tokens").
 */
const COMPLETED_STATUS_RE = /^\w+ed for\s+\d/i
/**
 * In-flight markers on a spinner body: streaming ellipsis, parenthesised
 * progress, token counters, or the (older-TUI) interrupt hint.
 */
const LIVE_HINT_RE = /…|\(|esc to interrupt|tokens/i

/**
 * True when a spinner status body reads as an in-flight turn, e.g.
 * "Honking… (23m 20s · ↓ 24.5k tokens)" — as opposed to a completed one
 * like "Brewed for 4m 15s".
 */
export function isLiveStatus(status: string): boolean {
  return !COMPLETED_STATUS_RE.test(status) && LIVE_HINT_RE.test(status)
}

/**
 * Agent TUIs paint a live spinner line only while a turn is actively
 * running, so it identifies a live turn even when the tracker never saw the
 * prompt (e.g. a tmux reattach mid-turn) — unlike finished-turn status lines
 * or transcript redraws.
 */
export function detectLiveWork(chunk: string): boolean {
  const plain = stripTermNoise(chunk).replace(CSI_RE, '')
  if (/esc to interrupt/i.test(plain)) return true
  return plain.split('\n').some((line) => {
    const spinner = SPINNER_LINE_RE.exec(line)
    return spinner !== null && isLiveStatus(spinner[1])
  })
}
