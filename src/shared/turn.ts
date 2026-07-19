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
  startedAt: number
  endedAt: number
}

/** Cap on retained turn records per terminal (oldest dropped first). */
export const MAX_TURN_HISTORY = 100

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
}

/**
 * Accumulate typed input into a prompt line, best effort. Handles Enter
 * (submit), backspace, ctrl-c/ctrl-u (clear) and strips escape sequences.
 */
export function feedPromptBuffer(buffer: string, data: string): PromptFeed {
  const submitted: string[] = []
  let line = buffer
  const plain = stripTermNoise(data).replace(CSI_RE, '')
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
  return { buffer: line, submitted }
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
