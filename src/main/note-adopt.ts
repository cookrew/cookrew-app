import { legacyNoteName, noteNameFromContent } from '../shared/model'
import type { CanvasNode, NoteNodeData } from '../shared/model'

/**
 * A NOTE WITH THE SAME NAME IS THE SAME NOTE.
 *
 * `cookrew note create "content"` names the card after the content's first
 * line. When that name is already a note on the caller's canvas, the caller
 * meant THAT note: a second agent writing "# The report" next to the first
 * one's must be wired to it, not handed "the-report (2)" (owner ruling
 * 2026-10-11, the rule `browser create` already follows).
 */

const NAME_BEARING = /[\p{L}\p{N}]/u
const LEADING_MARKDOWN = /^[\s#>*\-]+/

/**
 * The names a note's first line claims, lower-cased: the slug the store would
 * mint, and the plain title (for a note the owner renamed by hand). Empty when
 * the first line names nothing — a bare `note create` stays a new card.
 */
export function claimedNoteNames(content: string): string[] {
  const firstLine = content.split('\n')[0] ?? ''
  if (!NAME_BEARING.test(firstLine)) return []
  const title = firstLine.replace(LEADING_MARKDOWN, '').trim()
  return [...new Set([noteNameFromContent(content), legacyNoteName(content), title].map((name) => name.toLowerCase()))]
}

/** The note on this canvas whose name the content's first line claims, if any. */
export function findClaimedNote(content: string, nodes: readonly CanvasNode[]): NoteNodeData | undefined {
  const names = claimedNoteNames(content)
  if (names.length === 0) return undefined
  return nodes.find(
    (node): node is NoteNodeData => node.kind === 'note' && names.includes(node.name.toLowerCase())
  )
}

/** What the caller is told when its `note create` adopted an existing note. */
export function adoptedNoteAnswer(note: NoteNodeData, holders: readonly string[], alreadyWired: boolean): string {
  return (
    `Note "${note.name}" already exists on this canvas` +
    (holders.length > 0 ? ` (wired to ${holders.join(', ')})` : '') +
    ` — ${alreadyWired ? 'already wired to you' : 'now wired to you too'}.` +
    ` Its content is untouched: use cookrew note write "${note.name}" "content" to replace it,` +
    ' or pass --new to create a second note.'
  )
}
