import { useEffect } from 'react'
import type { TerminalActivity } from '../../../shared/turn'
import { useActivity, activityStore } from '../activity-thumb-store'
import { cookrew } from '../api'
import { draftKey, getDraft, setDraft } from './prompt-draft'

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

/** The keys that turn one input line into another: back over what differs, type the rest. */
export function keysFor(from: string, to: string): string {
  const was = Array.from(from)
  const next = Array.from(to)
  let same = 0
  while (same < was.length && same < next.length && was[same] === next[same]) same += 1
  return BACKSPACE.repeat(was.length - same) + next.slice(same).join('')
}

/**
 * What the agent's line should hold for this draft. "@Other …" is for
 * Other, so none of it goes into this agent's line — nor does an "@" that is
 * still on its way to naming an agent. "@Self …" is just the words.
 */
export function lineTextFor(text: string, targetId: string, mention: { id: string; text: string } | null, agentNames: readonly string[]): string {
  if (mention) return mention.id === targetId ? mention.text : ''
  const naming = /^\s*@(\S*)$/u.exec(text)
  if (naming && agentNames.some((name) => name.toLowerCase().startsWith(naming[1].toLowerCase()))) return ''
  return text
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
 * Bring the agent's input line to `text`. Withheld while it asks a question,
 * unless `force` (an explicit send); the draft keeps the words either way.
 */
export function typeLine(agentId: string, text: string, force = false): void {
  const line = lineOf(agentId)
  const now = Date.now()
  if (!force && activityStore.get(agentId)?.phase === 'waiting') {
    withLine(agentId, { ...line, editedAt: now })
    return
  }
  const keys = keysFor(line.typed, text)
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
