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
 * Read against real panes, Claude Code 2.1.316 and codex-cli 0.166.0
 * (tests/fixtures/wait-choice). Pure: no DOM, no terminal.
 */

export interface WaitOption {
  /** The key on the row: its number, or y / n. */
  readonly key: string
  readonly label: string
  /** A line under it (a question tool's description, a hint after " · "). */
  readonly detail: string | null
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

/** A row's label and the line under it, hints out. */
function optionOf(row: Row, key: string): WaitOption {
  const [head, ...tail] = row.text.split(' · ')
  const extra = [...(tail.length ? [tail.join(' · ')] : []), ...row.more].map((l) => l.replace(HINT_RE, '').trim()).filter((l) => l !== '' && !HINT_LINE_RE.test(l))
  // A wrapped label goes on in lower case; a description starts a sentence.
  const wraps = extra.length > 0 && /^[a-z(`]/.test(extra[0]) && row.more.length > 0 && tail.length === 0
  const label = (wraps ? `${head} ${extra[0]}` : head).replace(HINT_RE, '').trim()
  const rest = wraps ? extra.slice(1) : extra
  return { key, label, detail: rest.length ? rest.join(' ') : null }
}

/** The question: the topmost line asking something in the region over the rows, cut at its last "?". */
function questionOver(lines: readonly string[], top: number): { text: string; at: number } | null {
  let found: { text: string; at: number } | null = null
  for (let at = top - 1; at >= Math.max(0, top - QUESTION_REACH); at -= 1) {
    const line = lines[at]
    if (STOP_RE.test(line)) break
    if (line.includes('?')) found = { text: line.trim(), at }
  }
  if (!found) return null
  let text = found.text.slice(0, found.text.lastIndexOf('?') + 1)
  // A question the pane wrapped: its first half sits above, unfinished.
  for (let at = found.at - 1, n = 0; at >= 0 && n < 2; at -= 1, n += 1) {
    const above = lines[at].trim()
    if (above === '' || STOP_RE.test(lines[at]) || /[.?!:]$/.test(above)) break
    text = `${above} ${text}`
  }
  return { text, at: found.at }
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
  const asked = questionOver(lines, top)
  // A cursor and no menu footer: only a real question makes it a menu (a
  // prompt echo "❯ 1. rename foo" is a cursor-looking row too).
  const footed = after.some((l) => FOOTER_RE.test(l))
  if (!footed && !asked) return null
  const question = asked?.text ?? headingOver(lines, top)
  if (!question) return null
  const options = block.rows.map((row) => optionOf(row, String(row.number)))
  const marked = block.rows.findIndex((r) => /\(esc\)\s*$/i.test(r.text))
  // Claude's "No" and "Tell Claude what to change" ARE its Esc (measured on
  // 2.1.316: either one rejects and hands the prompt back to be typed in).
  const escByWord = askedByTool(lines, top, after) ? -1 : options.map((o) => ESC_LABEL_RE.test(o.label)).lastIndexOf(true)
  const escIndex = marked >= 0 ? marked : escByWord >= 0 ? escByWord : null
  const sub = asked ? subOver(lines, asked.at, top, lines[asked.at]) : subOver(lines, top, top, question)
  return { kind: 'menu', question, sub: sub === question ? null : sub, options, cursor, escIndex }
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

const DOWN = '\x1b[B'
const UP = '\x1b[A'
export const ESC = '\x1b'

/**
 * The keys a row sends into the agent's terminal: its number for a menu row,
 * the Esc row too (Claude Code and Codex both take a number at once, wherever
 * the cursor is; Claude's "No" does what Esc does, measured), arrows from the
 * cursor and Enter past 9, a letter and Enter for a confirm. Null when the row
 * cannot be reached.
 */
export function choiceKeys(choice: WaitChoice, index: number): string | null {
  const option = choice.options[index]
  if (!option) return null
  if (choice.kind === 'yn') return `${option.key}\r`
  if (index < 9) return String(index + 1)
  if (choice.cursor === null) return null
  const step = index - choice.cursor
  return (step > 0 ? DOWN : UP).repeat(Math.abs(step)) + '\r'
}

/**
 * The row a key pressed with the box empty answers: its digit, or a lower-case
 * y / n (a capital starts a sentence: "No, use pnpm" is words, not an answer).
 */
export function keyChoice(choice: WaitChoice, key: string): number | null {
  const at = choice.options.findIndex((o) => o.key === key)
  return at >= 0 ? at : null
}

/** One question, wherever its cursor stands: an answered one is known when it shows again. */
export function choiceSig(choice: WaitChoice): string {
  return [choice.kind, choice.question, choice.sub ?? '', ...choice.options.map((o) => o.label)].join('\u0000')
}
