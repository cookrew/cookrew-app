import { registerScopeState } from '../machine-scope'
import { useEffect } from 'react'
import type { TerminalActivity } from '../../../shared/turn'
import { useActivity, activityStore } from '../activity-thumb-store'
import { inputRefused } from './input-refused'
import { cookrew } from '../api'
import { agentRefs, artifactRefs, expandRefs, pendingName, type NamedAgent, type PromptArtifact } from './artifact-refs'
import { draftKey, getDraft, setDraft } from './prompt-draft'
import { shownWords, withShownWords } from './draft-pictures'

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
 * Bring the agent's input line to `text`. Withheld while it asks a question, or
 * while the text is past LINE_MAX, unless `force` (an explicit send); the draft
 * keeps the words either way.
 */
export function typeLine(agentId: string, text: string, force = false): void {
  const line = lineOf(agentId)
  const now = Date.now()
  if (!force && (held.has(agentId) || overLine(text) || activityStore.get(agentId)?.phase === 'waiting')) {
    withLine(agentId, { ...line, editedAt: now })
    return
  }
  const keys = lineKeys(line.typed, text)
  withLine(agentId, { ...line, typed: text, editedAt: now })
  if (keys) cookrew().ptyInput(agentId, keys)
}

/** Enter on the agent's line, holding `text` (an empty text submits what is there). */
export function submitLine(agentId: string, text: string): void {
  if (text) typeLine(agentId, text, true)
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
  if (overLine(draft) && draft.trim() !== known.typed.trim()) return
  setDraft(draftKey(agentId), pending)
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
}
