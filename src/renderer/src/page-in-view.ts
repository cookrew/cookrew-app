/**
 * IS ANYONE LOOKING? A mounted view is not a look: the window can sit behind
 * another app with an agent's full view open, and a reply landing there was
 * read on the spot while its chime rang to an empty room (owner, 2026-11-06).
 * Read it at the moment something arrives or opens, never on return: coming
 * back to the window does not read what landed while you were away.
 */
export function pageInView(page: Pick<Document, 'visibilityState' | 'hasFocus'> = document): boolean {
  return page.visibilityState === 'visible' && page.hasFocus()
}
