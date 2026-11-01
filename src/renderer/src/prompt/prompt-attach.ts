import { shellQuotePath } from '../../../shared/attach'
import { imageFilesFromClipboardItems, saveClipboardImages, type ClipboardItemLike } from '../clipboard-image'

/**
 * SCREENSHOTS IN THE PROMPT BOX (owner, 2026-11-01). A screenshot pasted into
 * a prompt box, or a file dropped on it, is saved the way the terminal saves
 * one (clipboard-image.ts, dropped-files.ts, the attach store), and its absolute path goes into
 * the draft at the caret. The draft is the agent's own input line
 * (live-line.ts), so the agent reads the file itself, as it does a path the
 * paperclip pastes; a new agent's first prompt carries it the same way.
 *
 * The pure parts; the box's wiring is use-prompt-attach.ts.
 */

export interface Caret {
  start: number
  end: number
}

/** The draft with `paths` put in at the caret (or at the end), set apart by spaces, and where the caret goes. */
export function withPaths(text: string, at: Caret | null, saved: readonly string[]): { text: string; caret: number } {
  const start = at ? Math.min(Math.max(0, at.start), text.length) : text.length
  // A store that saved nothing (the demo's) hands back '': nothing to put in.
  const paths = saved.filter((p) => p !== '')
  if (paths.length === 0) return { text, caret: start }
  const end = at ? Math.min(Math.max(start, at.end), text.length) : text.length
  const before = text.slice(0, start)
  const after = text.slice(end)
  const lead = before && !/\s$/u.test(before) ? ' ' : ''
  const trail = /^\s/u.test(after) ? '' : ' '
  const put = `${lead}${paths.map(shellQuotePath).join(' ')}${trail}`
  return { text: before + put + after, caret: before.length + put.length }
}

/**
 * The paths go where the caret was when the screenshot came in — unless the
 * draft moved on while it was saved: then at the end, past the new words.
 */
export function insertAttached(then: string, now: string, at: Caret | null, paths: readonly string[]): { text: string; caret: number } {
  return withPaths(now, now === then ? at : null, paths)
}

/** The images a paste carries; none for a text paste, which the box takes as typed. */
export function pastedImages<F>(data: { items?: ArrayLike<ClipboardItemLike<F>> } | null): F[] {
  return data?.items ? imageFilesFromClipboardItems(Array.from(data.items)) : []
}

export { saveClipboardImages }
