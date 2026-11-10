/**
 * "OPEN THIS TEAM" — asked from outside the import sheet.
 *
 * A team is opened in the app, and the one way in is the import sheet with the
 * team's address already in its field: it reads the face, shows the price and
 * still asks before a card is placed. A `cookrew://import/@handle/team` link
 * arrives there through main; this is the same arrival for a button that is
 * already inside the app — the Seats tab's OPEN, which used to send people to
 * the team's page at cookrew.dev until 0.6.0 removed the page.
 *
 * The same shape as the account sheet's seam (account/open-request.ts): App
 * owns the sheet and listens, anybody may ask, and no DOM event carries it, so
 * a test can hold both ends in Node. More than one listener is expected — the
 * account sheet listens too, to get out of the way.
 */

type Listener = (address: string) => void

const listeners = new Set<Listener>()

/** Subscribe; the unsubscribe is the return. */
export function onImportRequest(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Whether anything would answer: a surface with no import sheet should not offer the button. */
export const importRequestable = (): boolean => listeners.size > 0

/**
 * Ask for the import sheet on `address` (`@owner/team`). False when nothing is
 * listening, so a caller can say so rather than wait for a sheet that will
 * not appear.
 */
export function requestImport(address: string): boolean {
  for (const listener of listeners) listener(address)
  return listeners.size > 0
}
