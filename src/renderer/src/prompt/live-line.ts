import { registerScopeState } from '../machine-scope'
import { useEffect } from 'react'
import type { TerminalActivity } from '../../../shared/turn'
import { useActivity, activityStore } from '../activity-thumb-store'
import { inputRefused } from './input-refused'
import { cookrew } from '../api'
import { agentRefs, artifactRefs, expandRefs, pendingName, type NamedAgent, type PromptArtifact } from './artifact-refs'
import { draftKey, getDraft, setDraft } from './prompt-draft'
import { draftOf, pictureTokens, shownWords, withShownWords } from './draft-pictures'

/**
 * THE DRAFT IS THE AGENT'S OWN INPUT LINE (owner, 2026-11-01: the prompt box
 * "同步 LIVE"). An agent's draft — the prompt box carrying @agent, its card's
 * reply box — is typed into the agent's terminal as it is written, so LIVE
 * shows the same words in the agent's own input box, and Enter (here or
 * there) submits them. Words typed in LIVE come back the other way: the
 * tracker reads what sits unsent in the box (TerminalActivity.pendingInput)
 * and the draft takes it.
 *
 * Held back while the agent asks a question: a letter typed into a
 * permission menu is an answer. The words wait in the draft and go in with
 * the next keystroke after the question, or with Enter.
 *
 * Best effort, like the tracker's own reading: the line is assumed to end at
 * the cursor. An edit made in LIVE with the arrow keys is not seen.
 *
 * A picture's path waits for Enter (owner, 2026-11-16: a Chinese message with a
 * screenshot reached Codex as "5 /Users/…/Screenshot_….jpg"). An agent folds a
 * path that arrives as one burst into ONE element (Codex: [Image #1]), and one
 * Backspace takes the element: every later edit's Backspaces over the path, 71
 * by this count, took it with the first and the owner's words with the rest.
 * So the line carries the words, and the paths go last, with the send from the
 * box. Enter pressed in LIVE itself sends the words only, and the draft empties.
 */

const BACKSPACE = '\x7f'
/**
 * The longest draft kept on the agent's line, in bytes. Claude folds a long paste
 * into one [Pasted text] token, and a single Backspace takes all of it: the box
 * would still hold the words and Enter send nothing (measured: 1535 characters,
 * 0 received; 535 stayed unfolded). Past this the words wait in the draft and go
 * whole with Enter. Under main's paste limit (enter-pacing.ts), so what is on the
 * line is always plain keys.
 */
export const LINE_MAX = 500
const overLine = (text: string): boolean => new TextEncoder().encode(text).length > LINE_MAX
/** After a keystroke here the tracker's reading lags behind it: ours is the truth for this long. */
export const QUIET_MS = 1200

interface Line {
  /** What this app believes it has typed into the agent's input line. */
  readonly typed: string
  /** The tracker's last reading of that line. */
  readonly seen: string
  readonly editedAt: number
}

let lines = new Map<string, Line>()

const withLine = (agentId: string, line: Line): void => {
  lines = new Map(lines).set(agentId, line)
}

// What the app believes is typed into each agent's line, and which lines have
// nothing behind them, is about terminals of ONE machine. Kept across a
// change, a later send would count backspaces for a line it never typed.
registerScopeState('typed lines', () => {
  lines = new Map()
  held = new Set()
})

// Keys refused never reached the line: it holds what was last seen on it, so
// the next send types the words again instead of a bare Enter.
inputRefused.subscribe((agentId) => {
  const line = lines.get(agentId)
  if (line) withLine(agentId, { ...line, typed: line.seen })
})

/** The keys that turn one input line into another: back over what differs, type the rest. */
export function keysFor(from: string, to: string): string {
  const was = Array.from(from)
  const next = Array.from(to)
  let same = 0
  while (same < was.length && same < next.length && was[same] === next[same]) same += 1
  return BACKSPACE.repeat(was.length - same) + next.slice(same).join('')
}

/** The tracker's reading is trimmed: what it left off the end is still on the line. */
const SPARE_BACKSPACES = 16

/**
 * keysFor, for a line that may be folded: only one that came from LIVE gets this
 * long. Words after it just follow it, but any other edit clears it and types it
 * all again. Backspaces clear a fold and plain words alike, and spare ones fall on
 * an empty line (measured; Ctrl-U only takes one wrapped row of unfolded words).
 */
function lineKeys(from: string, to: string): string {
  if (!overLine(from) || to.startsWith(from)) return keysFor(from, to)
  return BACKSPACE.repeat(Array.from(from).length + SPARE_BACKSPACES) + to
}

/**
 * What the agent's line should hold for this draft. "@Other …" is for
 * Other, so none of it goes into this agent's line — nor does an "@" that is
 * still on its way to naming an agent. "@Self …" is just the words. A whole
 * "#Name", or a teammate's "@Name" among the words, goes in as the command
 * that reaches it (artifact-refs.ts); one still being typed waits for its name.
 */
export function lineTextFor(
  text: string,
  targetId: string,
  mention: { id: string; text: string } | null,
  agents: readonly NamedAgent[],
  artifacts: readonly PromptArtifact[] = []
): string {
  let body = text
  if (mention) body = mention.id === targetId ? mention.text : ''
  else {
    // The words, not the picture paths after them (draft-pictures.ts).
    const naming = /^\s*@(\S*)$/u.exec(shownWords(text))
    if (naming && agents.some((a) => a.name.toLowerCase().startsWith(naming[1].toLowerCase()))) return ''
  }
  const words = shownWords(body)
  const teammates = agents.filter((a) => a.id !== targetId)
  const pending = pendingName(words, { '@': teammates.map((a) => a.name), '#': artifacts.map((a) => a.name) })
  if (pending) body = withShownWords(body, words.slice(0, pending.start))
  return expandRefs(body, artifactRefs(body, artifacts), agentRefs(body, teammates))
}

/** Cards that cannot start: the draft stays in the box and goes whole on a send. */
let held: ReadonlySet<string> = new Set()

/**
 * The cards whose line has nothing behind it. A line newly held forgets what it
 * typed: those keys reached no process, and counting them left a later send
 * with only its Enter to send.
 */
export function holdLines(ids: readonly string[]): void {
  const next = new Set(ids)
  for (const id of next) {
    if (!held.has(id)) withLine(id, { ...lineOf(id), typed: '', seen: '', editedAt: Date.now() })
  }
  held = next
}

/** Keys a failed wake lost (main's `terminal.keys-lost`): a send must carry those words itself. */
export function forgetTyped(agentId: string): void {
  const line = lineOf(agentId)
  withLine(agentId, { ...line, typed: line.seen })
}

function lineOf(agentId: string): Line {
  const known = lines.get(agentId)
  if (known) return known
  const pending = activityStore.get(agentId)?.pendingInput ?? ''
  const line = { typed: pending, seen: pending, editedAt: 0 }
  withLine(agentId, line)
  return line
}

/**
 * Bring the agent's input line to `text`: its words only, unless `force` (an
 * explicit send), which types its picture paths too, last. Withheld while it
 * asks a question, or while the words are past LINE_MAX, unless `force`; the
 * draft keeps the words either way.
 */
export function typeLine(agentId: string, text: string, force = false): void {
  const line = lineOf(agentId)
  const now = Date.now()
  // The send (force) takes the pictures too, after every word; an edit only the words.
  const want = force ? text : shownWords(text)
  if (!force && (held.has(agentId) || overLine(want) || activityStore.get(agentId)?.phase === 'waiting')) {
    withLine(agentId, { ...line, editedAt: now })
    return
  }
  const keys = lineKeys(line.typed, want)
  withLine(agentId, { ...line, typed: want, editedAt: now })
  if (keys) cookrew().ptyInput(agentId, keys)
}

/**
 * WHICH LINES ARE REBUILT ON THE SEND (owner, 2026-11-17: Codex input is still
 * cut off, fix it at the root). Everything above edits the line by what this app BELIEVES it
 * holds, and Codex's line is not a plain one: a path becomes one [Image #1],
 * a fast burst is held as a paste, LIVE and other devices type and move the
 * cursor in it. Whenever the belief is wrong, Backspaces counted from it eat
 * the owner's words, and the send submitted what was left. So a send to Codex
 * does not trust the belief: it clears the whole box and puts the draft in
 * whole. Codex agents only: measured there (codex 0.169, idle and mid-turn,
 * over a folded picture, a second line and a moved cursor). Claude's Ctrl-U
 * takes one wrapped row, so its line keeps the typed send.
 */
let rebuilt: ReadonlySet<string> = new Set()

/**
 * What these agents run: an agent whose harness rebuilds its line on a send
 * (shared/harness-ui.ts LINE_REBUILT_ON_SEND — Codex today). Agents
 * not named keep what they were, so the active workspace's cards and the
 * fleet's other workspaces can each say what they know (Dock.tsx).
 */
export function noteLineAgents(agents: readonly { readonly id: string; readonly rebuild: boolean }[]): void {
  const next = new Set(rebuilt)
  for (const agent of agents) {
    if (agent.rebuild) next.add(agent.id)
    else next.delete(agent.id)
  }
  if (next.size !== rebuilt.size || [...next].some((id) => !rebuilt.has(id))) rebuilt = next
}

/**
 * Codex's lines, in order: what is before the cursor, all that follows (a
 * Ctrl-K at a line's end takes only its break, so two per line), then each
 * line above. Spare keys fall on an empty box and do nothing there.
 */
const KILL_LINES = 8
export const CODEX_CLEAR = '\x15' + '\x0b'.repeat(2 * KILL_LINES) + '\x7f\x15'.repeat(KILL_LINES)
const PASTE_OPEN = '\x1b[200~'
const PASTE_CLOSE = '\x1b[201~'
const pasted = (text: string): string => `${PASTE_OPEN}${text}${PASTE_CLOSE}`

/**
 * The keys that make Codex's box hold exactly `text`: the words as one paste,
 * each picture as its own (so it attaches), a space before each so a picture
 * Codex cannot read stays a path of its own.
 */
function rebuildKeys(text: string): string {
  const words = shownWords(text).trim()
  const pictures = pictureTokens(text).map((token, i) => (words || i > 0 ? ' ' : '') + pasted(token))
  return CODEX_CLEAR + (words ? pasted(words) : '') + pictures.join('')
}

/** Enter on the agent's line, holding `text` (an empty text submits what is there). */
export function submitLine(agentId: string, text: string): void {
  if (text && rebuilt.has(agentId)) cookrew().ptyInput(agentId, rebuildKeys(text))
  else if (text) typeLine(agentId, text, true)
  cookrew().ptyInput(agentId, '\r')
  endLine(agentId)
}

/** The line was submitted by other means: it is empty now, and so is its draft. */
export function endLine(agentId: string): void {
  withLine(agentId, { ...lineOf(agentId), typed: '', seen: '', editedAt: Date.now() })
  setDraft(draftKey(agentId), '')
}

/**
 * The tracker read the agent's line. Words typed there (in LIVE, on another
 * device) become the draft — unless they are only this app's own keys, late.
 * A reading that never moves is not trusted to mean anything: a terminal
 * whose input the tracker cannot see would otherwise wipe every draft.
 */
export function observeLine(agentId: string, activity: TerminalActivity | undefined, now = Date.now()): void {
  if (!activity || activity.mirrorless) return
  const pending = activity.pendingInput ?? ''
  const known = lines.get(agentId)
  if (!known) {
    withLine(agentId, { typed: pending, seen: pending, editedAt: 0 })
    if (pending && !getDraft(draftKey(agentId))) setDraft(draftKey(agentId), pending)
    return
  }
  if (pending === known.seen) return
  const read = { ...known, seen: pending }
  if (now - known.editedAt < QUIET_MS || pending === known.typed.trim()) {
    withLine(agentId, read)
    return
  }
  withLine(agentId, { ...read, typed: pending })
  // A draft waiting in the box is not on the line: the line has no say over it.
  const draft = getDraft(draftKey(agentId))
  const words = shownWords(draft)
  if (overLine(words) && words.trim() !== known.typed.trim()) return
  // The line has the words; the draft's pictures were never on it, so they stay —
  // unless the line was emptied there (Enter or a clear in LIVE): they go with the words.
  const pictures = pending === '' ? [] : pictureTokens(draft).filter((token) => !pending.includes(token))
  setDraft(draftKey(agentId), draftOf(pending, pictures))
}

/** Keep the agent's draft in step with its line while a box for it is on screen. */
export function useLiveLine(agentId: string | null): TerminalActivity | undefined {
  const activity = useActivity(agentId ?? '')
  useEffect(() => {
    if (agentId) observeLine(agentId, activity)
  }, [agentId, activity])
  return activity
}

export function resetLinesForTests(): void {
  lines = new Map()
  rebuilt = new Set()
}
