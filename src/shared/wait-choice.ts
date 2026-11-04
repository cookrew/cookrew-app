/**
 * THE WAIT CHOICE BOX's reading (owner task, 2026-11-04; cut
 * docs/avatar-send-tasks/g-choice). The turn tracker already says an agent
 * waits on you (turn.ts · detectAttention) and keeps the question's lines;
 * this turns them into the menu its TUI is showing, so the prompt box can
 * offer the same answers as rows. Anything it cannot read is null: no box,
 * the keys stay.
 *
 *   menu  Claude Code permission, plan-approval and question menus
 *         ("❯ 1. Yes"), Codex approvals ("› 1. Yes, proceed (y)"). Read as
 *         the LAST numbered block on screen, counted from 1, with the TUI's
 *         cursor on a row or its own footer under it ("Esc to cancel"), and
 *         nothing much after it: a numbered list in a reply is not a menu.
 *   yn    a confirm ending the screen: "(y/n)?", "[Y/n]", npx's "(y)".
 *
 * A QUESTION TOOL (AskUserQuestion) has more in it (tests/wait-choice-tabs.test.ts,
 * keys measured on a live pane): a tab row of questions, a question with no
 * "?", descriptions under each row, a row to type in, a chat row, and in a
 * multi-select ticks and an unnumbered Submit. It can run to 30 lines on a
 * narrow pane, so the whole screen is read here (waitChoiceOfScreen), not the
 * activity's summary tail.
 *
 * Read against real panes, Claude Code 2.1.316 and codex-cli 0.166.0
 * (tests/fixtures/wait-choice). Pure: no DOM, no terminal.
 */

import { cleanTurnLines, stripTermNoise } from './turn'

/** What a row does beyond picking: a tick, words typed in it, the multi-select's Submit, leaving to chat. */
export type WaitRole = 'toggle' | 'type' | 'submit' | 'chat'

export interface WaitOption {
  /** The key on the row: its number, or y / n. */
  readonly key: string
  readonly label: string
  /** A line under it (a question tool's description, a hint after " · "). */
  readonly detail: string | null
  /** Absent: the row picks. */
  readonly role?: WaitRole
  /** A multi-select row's tick. */
  readonly checked?: boolean
}

/** One answer on a question tool's Review tab. */
export interface WaitReview {
  readonly question: string
  readonly answer: string
}

export interface WaitChoice {
  readonly kind: 'menu' | 'yn'
  readonly question: string
  /** What it is about, when the screen says: "Edit · a.ts · +1 −1", "$ touch c.txt". */
  readonly sub: string | null
  readonly options: readonly WaitOption[]
  /** The row the TUI's cursor is on (a confirm's default), if known. */
  readonly cursor: number | null
  /** The row that is the TUI's own Esc ("No", "Tell Claude what to change"): Esc, then type. */
  readonly escIndex: number | null
  /** A question tool's tabs: how many of its questions are answered. */
  readonly steps?: { readonly done: number; readonly total: number }
  /** What the Review tab says will be sent. */
  readonly review?: readonly WaitReview[]
}

const OPTION_RE = /^(\s*)([❯›>▶►]\s*)?(\d{1,2})[.)]\s+(\S.*)$/
/** A menu's own footer: the TUI is showing a selector. */
const FOOTER_RE = /esc to cancel|enter to (select|confirm)|press enter|↑\/↓|enter continue|esc back/i
/** Most lines a menu's footer and frame leave under its last row. */
const MAX_AFTER = 4
/** How far above the rows a question is looked for. */
const QUESTION_REACH = 10
/**
 * Where the question's region ends, going up: a rule, an entry of the
 * transcript (Claude's ⏺, Codex's •), a question tool's ☐ heading, a prompt
 * echo (❯ or › not before a number).
 */
const STOP_RE = /^\s*(?:[╌┄┈─━-]{6,}|[⏺●•☐☒]\s|[❯›]\s+(?!\d{1,2}[.)]\s))/
/** A question tool's tab row: "←  ☒ dns-edge  ☐ scope  ✔ Submit  →". */
const TABS_RE = /^\s*←\s.*[☐☒].*→\s*$/
/** A multi-select's Submit: no number, its own cursor. */
const SUBMIT_RE = /^\s*([❯›>▶►]\s*)?Submit\s*$/
const TICK_RE = /^\[([ xX✔✓])\]\s+(.*)$/
const CHAT_RE = /^chat about this\b/i
const TYPE_RE = /^type something\.?$/i
const QUOTE_RE = /^\s*[│┃]\s?/
/** Most lines a question tool's question runs to. */
const TOOL_QUESTION_REACH = 16
/** How far up a screen a menu is looked for. */
const SCREEN_TAIL = 80
const FRAME_RE = /^[─━]{30,}/
/** An entry of the transcript or a prompt echo: what came before this question. */
const ENTRY_RE = /^\s*(?:[⏺●•]\s|[❯›]\s+(?!\d{1,2}[.)]\s))/
const HEADING_RE = /^\s*[☐☒]\s*/
const RULE_RE = /^\s*[╌┄┈]{6,}\s*$/
/** Shortcut hints the labels carry: "(y)", "(p)", "(esc)", "(shift+tab)", "shift+tab to …". */
const HINT_RE = /\s*\((?:esc|shift\+tab|ctrl\+\w|[a-z])\)\s*$/i
const HINT_LINE_RE = /^\(?(?:esc|shift\+tab|ctrl\+\w)\)?(?:\s+to\b.*)?$/i
/** The rows that ARE the TUI's own Esc: reject, and hand the prompt back to be typed in. */
const ESC_LABEL_RE = /^(?:no|no, and tell (?:claude|codex|it) what to do differently|no, keep planning|tell (?:claude|codex) what to change)\.?$/i
const YN_RE = /^(.*?)\s*[([]\s*([yY])(?:\s*\/\s*([nN]))?\s*[)\]]\s*([?:]?)\s*$/
/** Claude Code's tool boxes, as their header reads, and the word the sub uses. */
const TOOL_HEADS: Record<string, string> = {
  'edit file': 'Edit',
  'create file': 'Create',
  'write file': 'Write',
  'bash command': 'Bash',
  'read file': 'Read',
  'fetch': 'Fetch',
  'web search': 'Search',
  'edit notebook': 'Notebook'
}

interface Row {
  readonly at: number
  readonly indent: number
  readonly number: number
  readonly cursor: boolean
  readonly text: string
  readonly more: string[]
  readonly submit?: true
}

const isBlank = (line: string): boolean => line.trim() === ''

/** The numbered blocks on screen, top to bottom, each with the line after its last row. */
function blocksOf(lines: readonly string[]): Array<{ rows: Row[]; end: number }> {
  const blocks: Array<{ rows: Row[]; end: number }> = []
  let open: { rows: Row[]; end: number } | null = null
  lines.forEach((line, at) => {
    const m = OPTION_RE.exec(line)
    const indent = m ? m[1].length + (m[2]?.length ?? 0) : 0
    const last = open?.rows[open.rows.length - 1]
    if (m) {
      const number = Number(m[3])
      const row: Row = { at, indent, number, cursor: m[2] !== undefined, text: m[4].trim(), more: [] }
      if (open && last && number === last.number + 1 && Math.abs(indent - last.indent) <= 2) {
        open.rows.push(row)
        open.end = at + 1
        return
      }
      open = { rows: [row], end: at + 1 }
      blocks.push(open)
      return
    }
    if (!open || !last) return
    if (isBlank(line)) return
    const submit = SUBMIT_RE.exec(line)
    if (submit && TICK_RE.test(last.text)) {
      open.rows.push({ at, indent: last.indent, number: last.number, cursor: submit[1] !== undefined, text: 'Submit', more: [], submit: true })
      open.end = at + 1
      return
    }
    // Deeper than the row's number: its wrap, its description, its hint.
    if (line.search(/\S/) > last.indent + 1) {
      last.more.push(line.trim())
      open.end = at + 1
      return
    }
    open = null
  })
  return blocks
}

const CJK_RE = /[\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60]/u
/** Wrapped lines back into one: Chinese takes no space where the pane broke it. */
function joined(parts: readonly string[]): string {
  return parts.reduce((text, part) => (text === '' ? part : `${text}${CJK_RE.test(text.at(-1) ?? '') && CJK_RE.test(part[0] ?? '') ? '' : ' '}${part}`), '')
}

/** A row's label and the line under it, hints out. */
function optionOf(row: Row, key: string): WaitOption {
  const tick = TICK_RE.exec(row.text)
  const [head, ...tail] = (tick ? tick[2] : row.text).split(' · ')
  const extra = [...(tail.length ? [tail.join(' · ')] : []), ...row.more].map((l) => l.replace(HINT_RE, '').trim()).filter((l) => l !== '' && !HINT_LINE_RE.test(l))
  // A wrapped label goes on in lower case; a description starts a sentence.
  const wraps = extra.length > 0 && /^[a-z(`]/.test(extra[0]) && row.more.length > 0 && tail.length === 0
  const label = (wraps ? `${head} ${extra[0]}` : head).replace(HINT_RE, '').trim()
  const rest = wraps ? extra.slice(1) : extra
  const option: WaitOption = { key, label, detail: rest.length ? joined(rest) : null }
  return tick ? { ...option, role: 'toggle', checked: tick[1] !== ' ' } : option
}

/** The question: the topmost line asking something in the region over the rows, cut at its last "?". */
function questionOver(lines: readonly string[], top: number): { text: string; at: number } | null {
  let found: { text: string; at: number } | null = null
  for (let at = top - 1; at >= Math.max(0, top - QUESTION_REACH); at -= 1) {
    const line = lines[at]
    if (STOP_RE.test(line)) break
    if (/[?？]/.test(line)) found = { text: line.trim(), at }
  }
  if (!found) return null
  let text = found.text.slice(0, Math.max(found.text.lastIndexOf('?'), found.text.lastIndexOf('？')) + 1)
  // A question the pane wrapped: its first half sits above, unfinished.
  for (let at = found.at - 1, n = 0; at >= 0 && n < 2; at -= 1, n += 1) {
    const above = lines[at].trim()
    if (above === '' || STOP_RE.test(lines[at]) || /[.?!:]$/.test(above)) break
    text = `${above} ${text}`
  }
  return { text, at: found.at }
}

/** The tool's tab row over the rows, if it has one. */
function tabsOver(lines: readonly string[], top: number): string | null {
  return lines.slice(Math.max(0, top - TOOL_QUESTION_REACH - 4), top).findLast((l) => TABS_RE.test(l)) ?? null
}

/** A question tool's question: all of it, its quote bar out, whatever it ends in. */
function toolQuestion(lines: readonly string[], top: number): { text: string; at: number } | null {
  const said: string[] = []
  let at = top
  for (let i = top - 1; i >= Math.max(0, top - TOOL_QUESTION_REACH); i -= 1) {
    const line = lines[i]
    if (TABS_RE.test(line) || STOP_RE.test(line)) break
    if (isBlank(line)) continue
    said.unshift(line.replace(QUOTE_RE, '').trim())
    at = i
  }
  return said.length ? { text: joined(said), at } : null
}

/** The Review tab: its question is the last line over the rows, the answers above it. */
function reviewOver(lines: readonly string[], top: number): { asked: { text: string; at: number }; review: WaitReview[] } | null {
  const from = lines.slice(0, top).findLastIndex((l) => /^\s*review your answers\s*$/i.test(l))
  if (from < 0) return null
  const askAt = lines.slice(0, top).findLastIndex((l) => !isBlank(l))
  if (askAt <= from) return null
  const review: WaitReview[] = []
  let question: string[] = []
  for (const line of lines.slice(from + 1, askAt)) {
    const text = line.trim()
    if (text === '') continue
    if (text.startsWith('→')) {
      review.push({ question: joined(question), answer: text.replace(/^→\s*/, '') })
      question = []
      continue
    }
    question = [...question, text.replace(/^[●•]\s*/, '')]
  }
  return { asked: { text: lines[askAt].trim(), at: askAt }, review }
}

/** The plain heading over the rows when nothing asks ("☐ Color"). */
const headingOver = (lines: readonly string[], top: number): string | null => {
  for (let at = top - 1; at >= Math.max(0, top - 3); at -= 1) {
    const line = lines[at]
    if (isBlank(line)) continue
    if (HEADING_RE.test(line)) return line.replace(HEADING_RE, '').trim()
    return STOP_RE.test(line) ? null : line.trim()
  }
  return null
}

/** A question tool's menu (its ☐ heading over the rows): its "No" is an answer, not the TUI's Esc. */
const askedByTool = (lines: readonly string[], top: number, after: readonly string[]): boolean =>
  lines.slice(Math.max(0, top - 4), top).some((l) => HEADING_RE.test(l)) || after.some((l) => /enter to select/i.test(l))

/** What the question is about: Claude's tool box, Codex's command, a question tool's heading. */
function subOver(lines: readonly string[], question: number, top: number, whole: string): string | null {
  const from = lines.slice(0, question).findLastIndex((l) => ENTRY_RE.test(l)) + 1
  const region = lines.slice(from, question)
  const headAt = region.findIndex((l) => TOOL_HEADS[l.trim().toLowerCase()] !== undefined)
  if (headAt >= 0) {
    const word = TOOL_HEADS[region[headAt].trim().toLowerCase()]
    const after = region.slice(headAt + 1)
    const ruled = after.findIndex((l) => RULE_RE.test(l))
    const body = ruled >= 0 ? after.slice(ruled + 1) : []
    const end = body.findIndex((l) => RULE_RE.test(l))
    const inner = end >= 0 ? body.slice(0, end) : body
    if (word === 'Bash') {
      const command = inner.find((l) => !isBlank(l))
      return command ? `Bash · ${command.trim()}` : 'Bash'
    }
    const file = after.find((l) => !isBlank(l) && !RULE_RE.test(l))
    const plus = inner.filter((l) => /^\s*\d+\s+\+/.test(l)).length
    const minus = inner.filter((l) => /^\s*\d+\s+-/.test(l)).length
    const counts = plus + minus > 0 ? ` · +${plus} −${minus}` : ''
    return `${word}${file && ruled !== 0 ? ` · ${file.trim()}` : ''}${counts}`
  }
  const between = lines.slice(question + 1, top)
  const command = between.find((l) => /^\s*\$\s+\S/.test(l))
  if (command) return command.trim()
  if (/\bplan\b/i.test(whole)) return 'Plan'
  const heading = lines.slice(Math.max(0, question - 3), question).reverse().find((l) => HEADING_RE.test(l))
  return heading ? heading.replace(HEADING_RE, '').trim() || null : null
}

function menuOf(lines: readonly string[]): WaitChoice | null {
  const block = blocksOf(lines).at(-1)
  if (!block || block.rows.length < 2 || block.rows[0].number !== 1) return null
  const after = lines.slice(block.end).filter((l) => !isBlank(l))
  if (after.length > MAX_AFTER) return null
  const cursors = block.rows.flatMap((r, i) => (r.cursor ? [i] : []))
  const cursor = cursors.length === 1 ? cursors[0] : null
  if (cursor === null && !after.some((l) => FOOTER_RE.test(l))) return null

  const top = block.rows[0].at
  const tabs = tabsOver(lines, top)
  const tool = tabs !== null || askedByTool(lines, top, after)
  const reviewed = tool ? reviewOver(lines, top) : null
  const asked = reviewed?.asked ?? (tool ? toolQuestion(lines, top) : null) ?? questionOver(lines, top)
  // A cursor and no menu footer: only a real question makes it a menu (a
  // prompt echo "❯ 1. rename foo" is a cursor-looking row too).
  const footed = after.some((l) => FOOTER_RE.test(l))
  if (!footed && !asked) return null
  const question = asked?.text ?? headingOver(lines, top)
  if (!question) return null
  const options = withRoles(block.rows.map((row) => (row.submit ? { key: '', label: row.text, detail: null, role: 'submit' as const } : optionOf(row, String(row.number)))), tool)
  const marked = block.rows.findIndex((r) => /\(esc\)\s*$/i.test(r.text))
  // Claude's "No" and "Tell Claude what to change" ARE its Esc (measured on
  // 2.1.316: either one rejects and hands the prompt back to be typed in).
  const escByWord = tool ? -1 : options.map((o) => ESC_LABEL_RE.test(o.label)).lastIndexOf(true)
  const escIndex = marked >= 0 ? marked : escByWord >= 0 ? escByWord : null
  const sub = asked ? subOver(lines, asked.at, top, lines[asked.at]) : subOver(lines, top, top, question)
  const steps = tabs === null ? null : { done: (tabs.match(/☒/g) ?? []).length, total: (tabs.match(/[☐☒]/g) ?? []).length }
  return {
    kind: 'menu',
    question,
    sub: sub === question ? null : sub,
    options,
    cursor,
    escIndex,
    ...(steps ? { steps } : {}),
    ...(reviewed ? { review: reviewed.review } : {})
  }
}

/** A question tool's last rows: the row to type in stands before Submit or the chat row, whatever words it holds. */
function withRoles(options: readonly WaitOption[], tool: boolean): WaitOption[] {
  if (!tool) return [...options]
  const chat = options.findIndex((o) => CHAT_RE.test(o.label))
  const submit = options.findIndex((o) => o.role === 'submit')
  const end = submit >= 0 ? submit : chat
  const typed = end > 0 ? end - 1 : options.findIndex((o) => TYPE_RE.test(o.label))
  return options.map((option, i) => (i === chat ? { ...option, role: 'chat' } : i === typed ? { ...option, role: 'type' } : option))
}

function confirmOf(lines: readonly string[]): WaitChoice | null {
  const shown = lines.map((l, at) => ({ l, at })).filter(({ l }) => !isBlank(l))
  const last = shown.at(-1)
  if (!last) return null
  const m = YN_RE.exec(last.l.trim())
  if (!m) return null
  const asked = m[1].trim().replace(/[?:]$/, '').trim()
  const question = asked ? `${asked}?` : 'Go ahead?'
  const yes = m[2]
  const no = m[3]
  const cursor = no === undefined ? 0 : yes === 'Y' && no === 'n' ? 0 : yes === 'y' && no === 'N' ? 1 : null
  const above = shown.at(-2)?.l.trim() ?? null
  return {
    kind: 'yn',
    question,
    sub: above && !OPTION_RE.test(above) ? above : null,
    options: [
      { key: 'y', label: 'Yes', detail: null },
      { key: 'n', label: 'No', detail: null }
    ],
    cursor,
    escIndex: null
  }
}

/** The menu a waiting turn's lines show, or null. */
export function parseWaitChoice(lines: readonly string[]): WaitChoice | null {
  return menuOf(lines) ?? confirmOf(lines)
}

const WIDE_RE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}]/u

/** A line cut at a column: a Chinese character takes two. */
function clipped(line: string, width: number): string {
  let at = 0
  let col = 0
  for (const ch of line) {
    col += WIDE_RE.test(ch) ? 2 : 1
    if (col > width) return line.slice(0, at)
    at += ch.length
  }
  return line
}

/**
 * The TUI's own width: the rule nearest over the menu's last row. A pane once
 * wider keeps old text right of what the TUI redraws, and it would read as part
 * of the rows; older rules further up may be of another width altogether.
 */
function frameWidth(lines: readonly string[]): number | null {
  const lastRow = lines.findLastIndex((l) => OPTION_RE.test(l))
  const rule = (lastRow < 0 ? lines : lines.slice(0, lastRow + 1)).findLast((l) => FRAME_RE.test(l)) ?? lines.findLast((l) => FRAME_RE.test(l))
  return rule ? (FRAME_RE.exec(rule)?.[0].length ?? null) : null
}

/**
 * The menu a whole screen shows (the tracker's viewport, a pane read): its
 * last lines, cut to the TUI's frame. Null when it shows none.
 */
export function waitChoiceOfScreen(screen: string): WaitChoice | null {
  return parseWaitChoice(screenLines(screen))
}

function screenLines(screen: string): string[] {
  const lines = stripTermNoise(screen).split('\n').slice(-SCREEN_TAIL)
  const width = frameWidth(lines)
  const framed = width === null ? lines : lines.map((line) => clipped(line, width))
  return cleanTurnLines(framed.join('\n'))
}

/** Under the rows the transcript goes on, or the input box stands: the rows are history. */
const PAST_RE = /^\s*(?:[⏺●•]\s|[❯›>](?:\s|$))/
/** A plan's footer, which FOOTER_RE's words do not reach. */
const PLAN_FOOTER_RE = /ctrl\+g to edit/i

/**
 * Is a TUI holding a menu up? Sure enough to decide a turn's phase and to let
 * keys past the input box's guards, which the rows alone are not: a prompt echo
 * or a draft in the box itself ("❯ 1. a" under a question) reads as a menu. So
 * it takes what only a menu draws: its footer (wrapped in a narrow pane), its
 * tabs, its review. Rows without them leave the answer to the box's guards.
 */
export function menuHeldOnScreen(screen: string): boolean {
  const lines = screenLines(screen)
  const block = blocksOf(lines).at(-1)
  const choice = menuOf(lines)
  if (!block || !choice) return false
  const under = lines.slice(block.end)
  if (under.some((line) => PAST_RE.test(line))) return false
  if (choice.steps || choice.review) return true
  const footer = under.map((line) => line.trim()).join(' ')
  return FOOTER_RE.test(footer) || PLAN_FOOTER_RE.test(footer)
}

const DOWN = '\x1b[B'
const UP = '\x1b[A'
const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'
export const ESC = '\x1b'
/** What a menu takes from the tray: its own navigation, never a word or an Enter. */
export const MENU_KEYS: readonly string[] = [ESC, UP, DOWN, LEFT, RIGHT]

/** What is asked of a menu. The main process turns it into keys against the screen as it stands (main/menu-answer.ts). */
export type MenuAct =
  | { readonly kind: 'row'; readonly index: number }
  | { readonly kind: 'esc' }
  | { readonly kind: 'step'; readonly dir: -1 | 1 }
  | { readonly kind: 'words'; readonly text: string }
  | { readonly kind: 'key'; readonly seq: string }

const onWordsRow = (choice: WaitChoice): boolean => choice.cursor !== null && choice.options[choice.cursor]?.role === 'type'
const ticks = (choice: WaitChoice): boolean => choice.options.some((o) => o.role === 'toggle')

/**
 * What a row sends, one entry per write. Measured on Claude Code 2.1.316:
 * a digit takes a row at once, wherever the cursor is, but on the row to type
 * in a digit is a word, so from there rows are reached by arrows and Enter. In
 * a multi-select a digit on the words row only ticks it, and Submit has no
 * digit. Enter goes in a write of its own: in one burst with arrows the TUI
 * took the Enter on the row it started from.
 */
function rowKeys(choice: WaitChoice, index: number): string[] | null {
  const option = choice.options[index]
  if (!option) return null
  if (choice.kind === 'yn') return [`${option.key}\r`]
  const moved = (): string | null => {
    if (choice.cursor === null) return null
    const step = index - choice.cursor
    return (step > 0 ? DOWN : UP).repeat(Math.abs(step))
  }
  const thenEnter = (): string[] | null => {
    const moves = moved()
    if (moves === null) return null
    return moves ? [moves, '\r'] : ['\r']
  }
  if (option.role === 'type') {
    if (index === choice.cursor) return []
    if (!ticks(choice)) return [option.key]
    const moves = moved()
    return moves === null ? null : [moves]
  }
  if (option.role === 'submit' || onWordsRow(choice) || option.key.length !== 1) return thenEnter()
  // The row's own number: an unnumbered Submit stands between rows.
  return [option.key]
}

/** Row words typed from the box go to: move there, clear what it holds, type them, Enter where that takes it. */
function wordsKeys(choice: WaitChoice, text: string): string[] | null {
  const index = choice.options.findIndex((o) => o.role === 'type')
  const move = index < 0 ? null : rowKeys(choice, index)
  if (move === null) return null
  // Measured: words go in at the row's caret; Ctrl-E Ctrl-U empties it from any place.
  const clear = TYPE_RE.test(choice.options[index].label) ? [] : ['\x05\x15']
  // A multi-select's words tick their row, and Enter there would untick it.
  return [...move, ...clear, text, ...(ticks(choice) ? [] : ['\r'])]
}

/** The writes an act makes of this menu, in order; null when it cannot be done. */
export function answerKeys(choice: WaitChoice, act: MenuAct): string[] | null {
  if (act.kind === 'esc') return [ESC]
  if (act.kind === 'row') return rowKeys(choice, act.index)
  if (act.kind === 'words') return wordsKeys(choice, act.text)
  if (act.kind === 'key') return MENU_KEYS.includes(act.seq) ? [act.seq] : null
  // On the words row ← → are the caret's: step off it first.
  const arrow = act.dir < 0 ? LEFT : RIGHT
  return onWordsRow(choice) ? [UP, arrow] : [arrow]
}

/** A row's keys as one string. */
export function choiceKeys(choice: WaitChoice, index: number): string | null {
  return rowKeys(choice, index)?.join('') ?? null
}

/** A tick or a move to the words row: the menu stays up, showing what changed. */
export const staysOpen = (option: WaitOption | undefined): boolean => option?.role === 'toggle' || option?.role === 'type'

/** The row the box's words would go to, if the menu has one. */
export const hasWordsRow = (choice: WaitChoice | null): boolean => choice?.options.some((o) => o.role === 'type') ?? false

/**
 * The row a key pressed with the box empty answers: its digit, or a lower-case
 * y / n (a capital starts a sentence: "No, use pnpm" is words, not an answer).
 */
export function keyChoice(choice: WaitChoice, key: string): number | null {
  const at = choice.options.findIndex((o) => o.key === key)
  return at >= 0 ? at : null
}

/**
 * Which menu this is, ticks and typed words aside: what an answer names, so
 * the main process can refuse it if the screen has moved on (two quick ticks
 * are still the same menu).
 */
export function choiceId(choice: WaitChoice): string {
  return [choice.kind, choice.question, choice.sub ?? '', ...choice.options.map((o) => (o.role === 'type' ? '\u0001' : o.label))].join('\u0000')
}

/** One question, wherever its cursor stands: an answered one is known when it shows again. */
export function choiceSig(choice: WaitChoice): string {
  return [choice.kind, choice.question, choice.sub ?? '', ...choice.options.map((o) => `${o.checked ? '✓' : ''}${o.label}`)].join('\u0000')
}
