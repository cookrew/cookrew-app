import { statusWord, type InkStatus } from '../zoom/ink-status'

/**
 * What the bar says under an agent's name in its full view on a phone (owner,
 * 2026-11-02): the state in one word, then what it has open, counted. Nothing
 * open says nothing — "nothing open" repeated the sheet's own empty line.
 */
export function fullRouteWords(status: InkStatus, counts: { readonly browsers: number; readonly notes: number }): string[] {
  const words = [statusWord(status)]
  if (counts.browsers > 0) words.push(`${counts.browsers} browser${counts.browsers === 1 ? '' : 's'}`)
  if (counts.notes > 0) words.push(`${counts.notes} note${counts.notes === 1 ? '' : 's'}`)
  return words
}
