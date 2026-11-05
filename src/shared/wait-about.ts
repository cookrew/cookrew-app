/**
 * WHAT A WAITING AGENT ASKS TO DO (owner, 2026-11-05: "Do you want to proceed?"
 * stood on the card, and what it would proceed with stood behind it). A
 * permission's question says nothing by itself; the TUI's box over it does:
 *
 *   ─────────────────────
 *    Bash command             the tool
 *    Rebuild the bundle       what it says it does          title
 *   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 *    │ rm -rf shots/*         the command, the diff, the plan   body
 *   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 *    │ Dangerous rm …         why it asks, and for how long     notes
 *    ⚠ … block this request in 1:56
 *
 *    Do you want to proceed?
 *    ❯ 1. Yes
 *
 * A long command on a phone's pane (43 x 29) is far taller than the screen, so
 * the screen alone holds only the end of it: `partial`. The rest stands in the
 * pane's history, and wholeBrief takes it from there, but only if that history
 * ends the way the screen does: a mirror's scrollback and a pane's history hold
 * old frames, and another command over these rows is worse than none.
 *
 * Read against real panes, Claude Code 2.1.316 and codex-cli 0.166.0
 * (tests/wait-about.test.ts). Pure: no DOM, no terminal.
 */

import { stripTermNoise } from './turn'

export interface WaitAbout {
  /** What the box says it does, a file, Codex's reason. */
  readonly title: string | null
  /** Why it asks: a warning, a countdown. */
  readonly notes: readonly string[]
  /** What would run or change: command, diff, plan. */
  readonly body: readonly string[]
  /** The box's top is off the screen: `body` is only the end of it. */
  readonly partial: boolean
  /** briefId of a body too long to ride whole: what is cut out still counts. */
  readonly sum?: string
}

/** What a choice carries: `about` is the menu's own, the rest of WaitChoice is for wholeBrief to keep. */
interface Briefed {
  readonly about?: WaitAbout
}

/**
 * Rules, frames and entries stand at column 0, and everything inside the box
 * has its margin: so a command cannot draw a box of its own (a heredoc with a
 * frame and a rule in it would otherwise put its words over what really runs).
 */
const RULE_RE = /^[╌┄┈]{6,}\s*$/
const FRAME_RE = /^[─━]{6,}/
/** An entry of the transcript or a prompt echo: nothing above it is the box's. */
const ENTRY_RE = /^(?:[⏺●•]\s|[❯›]\s+(?!\d{1,2}[.)]\s))/
const BAR_RE = /^\s?[│┃]\s?/
/** Where the menu starts: the box is what stands over its row 1. */
const FIRST_ROW_RE = /^\s*(?:[❯›>▶►]\s*)?1[.)]\s+\S/
const WARN_RE = /^\s*⚠/
const TIP_RE = /^Tip:.*?\bbelow\b\s*/i
const COMMAND_RE = /^\s*\$\s+\S/
const CODEX_ASKS_RE = /^\s*would you like\b/i
const REASON_RE = /^\s*Reason:\s*/
/** What a barred row leaves of the pane: its bar on the left, a column free on the right. */
const BAR_COLS = 4
/** What rides each activity push: the command's start and its end. */
const HEAD_ROWS = 80
const TAIL_ROWS = 40
/** Rows a screen and a history must end in together to be taken for one box. */
const ROWS_IN_COMMON = 2

const isBlank = (row: string): boolean => row.trim() === ''
const isEntry = (row: string): boolean => ENTRY_RE.test(row)
const isRule = (row: string): boolean => RULE_RE.test(row)

const CJK_RE = /[\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60]/u
/** Wrapped lines back into one: Chinese takes no space where the pane broke it. */
export function joined(parts: readonly string[]): string {
  return parts.reduce((text, part) => (text === '' ? part : `${text}${CJK_RE.test(text.at(-1) ?? '') && CJK_RE.test(part[0] ?? '') ? '' : ' '}${part}`), '')
}

const WIDE_RE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}]/u
const colsOf = (row: string): number => [...row].reduce((cols, ch) => cols + (WIDE_RE.test(ch) ? 2 : 1), 0)

/** A line cut at a column: a Chinese character takes two. */
export function clipped(line: string, width: number): string {
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
 * Did this barred row and the next break inside one word? A word wider than the
 * box is cut at its edge: the row runs to the edge, and its last word and the
 * next row's first would not have fitted on a row together.
 */
function brokeAtEdge(row: string, next: string, width: number): boolean {
  if (!BAR_RE.test(row) || !BAR_RE.test(next)) return false
  const room = width - BAR_COLS
  const said = row.replace(BAR_RE, '')
  if (colsOf(said) < room) return false
  return colsOf(said.split(' ').at(-1) ?? '') + colsOf(next.replace(BAR_RE, '').split(' ')[0]) > room
}

/** A paragraph's rows back into its words. */
function flowed(rows: readonly string[], width: number): string {
  return rows.reduce((text, row, i) => {
    const said = row.replace(BAR_RE, '').trim()
    if (i === 0) return said
    return brokeAtEdge(rows[i - 1], row, width) ? `${text}${said}` : joined([text, said])
  }, '')
}

/**
 * The rows between the rules: their bars and the box's margin out, a command's
 * own indent kept. Rows stay as the pane drew them: joining a broken word is a
 * guess, and a wrong one would hide what runs from whoever approves it.
 */
function bodyOf(rows: readonly string[]): string[] {
  const lines = rows.map((row) => (BAR_RE.test(row) ? row.replace(BAR_RE, '') : row.replace(/^ /, '')))
  const first = lines.findIndex((l) => !isBlank(l))
  return first < 0 ? [] : lines.slice(first, lines.findLastIndex((l) => !isBlank(l)) + 1)
}

/** Under the last rule: the question is the last paragraph, the notes what stands over it. */
function notesOf(rows: readonly string[], width: number): string[] {
  const kept = rows.filter((row) => !FRAME_RE.test(row))
  const end = kept.findLastIndex((row) => !isBlank(row))
  const said = kept.slice(0, Math.max(kept.slice(0, end + 1).findLastIndex(isBlank), 0))
  const notes = said.reduce<string[][]>((all, row, i) => {
    if (isBlank(row)) return all
    const last = all.at(-1)
    const opens = !last || isBlank(said[i - 1]) || WARN_RE.test(row) || BAR_RE.test(row) !== BAR_RE.test(said[i - 1])
    return opens ? [...all, [row]] : [...all.slice(0, -1), [...last, row]]
  }, [])
  return notes.map((rowsOfNote) => flowed(rowsOfNote, width))
}

/** Between the frame and the first rule: the tool's name, then its words. Null: the head is not on these rows. */
function headOver(rows: readonly string[], width: number): { title: string | null } | null {
  const frame = rows.findLastIndex((row) => FRAME_RE.test(row))
  const under = rows.slice(frame + 1).filter((row) => !isBlank(row))
  if (frame < 0 || under.length === 0 || under.some(isEntry)) return null
  return { title: flowed(under.slice(1), width).replace(TIP_RE, '').trim() || null }
}

/** Claude Code's box over the menu. */
function boxOver(above: readonly string[]): WaitAbout | null {
  const low = above.findLastIndex(isRule)
  if (low < 0 || above.slice(low).some(isEntry)) return null
  const width = colsOf(above[low].trim())
  const rows = above.map((row) => clipped(row, width))
  const entry = rows.slice(0, low).findLastIndex(isEntry)
  const high = rows.slice(0, low).findLastIndex(isRule)
  const closed = high > entry
  const head = closed ? headOver(rows.slice(0, high), width) : null
  return {
    title: head?.title ?? null,
    notes: notesOf(rows.slice(low + 1), width),
    body: bodyOf(rows.slice((closed ? high : entry) + 1, low)),
    partial: head === null
  }
}

/** Codex's approval: "Reason: …" and "$ command" under its question. */
function codexOver(above: readonly string[]): WaitAbout | null {
  // An entry at column 0 proves the top is on the screen: a tall command's rows
  // are all indented, and one of them may read like the question and a $ row.
  const entry = above.findLastIndex(isEntry)
  if (entry < 0) return null
  const own = above.slice(entry + 1)
  const rows = own.slice(Math.max(own.findIndex((row) => CODEX_ASKS_RE.test(row)), 0))
  const command = CODEX_ASKS_RE.test(rows[0] ?? '') ? rows.findIndex((row) => COMMAND_RE.test(row)) : -1
  if (command < 0) return null
  const reason = rows.slice(0, command).findIndex((row) => REASON_RE.test(row))
  const end = reason < 0 ? -1 : rows.findIndex((row, i) => i > reason && isBlank(row))
  const title = reason < 0 ? null : joined(rows.slice(reason, end < 0 ? command : end).map((row) => row.replace(REASON_RE, '').trim()))
  return { title, notes: [], body: rows.slice(command).filter((row) => !isBlank(row)).map((row) => row.trim()), partial: false }
}

/** What the box over a screen's last menu says, read from its raw rows: cleaning takes frames and a command's own words. */
export function aboutOfScreen(screen: string): WaitAbout | null {
  const rows = stripTermNoise(screen)
    .split('\n')
    .map((row) => row.replace(/\s+$/g, ''))
  const top = rows.findLastIndex((row) => FIRST_ROW_RE.test(row))
  if (top < 0) return null
  const above = rows.slice(0, top)
  return boxOver(above) ?? codexOver(above)
}

/** A box's notes, its countdown aside: that one runs on. */
const steadyNotes = (about: WaitAbout): string => about.notes.filter((note) => !WARN_RE.test(note)).join('\n')

/**
 * Does the read end the way the screen does, and say the same over the
 * question? That is all a screen can tell: two boxes alike in all it shows pass
 * here, which is why an answer names the whole of what it approves (briefId).
 */
function sameBox(shown: WaitAbout, read: WaitAbout): boolean {
  const notes = steadyNotes(shown)
  if (notes !== steadyNotes(read)) return false
  if (shown.body.length < ROWS_IN_COMMON && notes === '') return false
  return read.body.join('\n').endsWith(shown.body.join('\n'))
}

function capped(body: readonly string[]): readonly string[] {
  const hidden = body.length - HEAD_ROWS - TAIL_ROWS
  return hidden > 0 ? [...body.slice(0, HEAD_ROWS), `… ${hidden} more lines …`, ...body.slice(-TAIL_ROWS)] : body
}

/**
 * A menu with its box whole, if `read` (the pane's history) has the top this
 * screen lost. The notes stay the screen's: a countdown runs on. The same object
 * back when it has not.
 */
export function wholeBrief<T extends Briefed>(choice: T, read: WaitAbout | null): T {
  const shown = choice.about
  if (!shown?.partial || !read || read.partial || !sameBox(shown, read)) return choice
  return { ...choice, about: { ...read, notes: shown.notes, body: capped(read.body), sum: briefId(read) } }
}

/** A short name for a long text (cyrb53). Not a secret: it only tells two commands apart. */
function hashed(text: string): string {
  let a = 0xdeadbeef
  let b = 0x41c6ce57
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    a = Math.imul(a ^ code, 2654435761)
    b = Math.imul(b ^ code, 1597334677)
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909)
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909)
  return `${(b >>> 0).toString(36)}.${(a >>> 0).toString(36)}`
}

/**
 * What a Yes approves, as an answer names it (main/menu-answer.ts): the menu's
 * own identity holds no command, and a tall box has no sub, so two different
 * commands under one question are the same menu. The notes stay out: a countdown
 * must not make an answer stale.
 */
export function briefId(about: WaitAbout | undefined): string {
  if (!about) return ''
  return about.sum ?? hashed([about.title ?? '', ...about.body].join('\n'))
}
