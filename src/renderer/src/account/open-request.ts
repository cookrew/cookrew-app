/**
 * "OPEN THE ACCOUNT SHEET" — asked from outside the account surface.
 *
 * The gate sheet's identify step (G1) must open the account sheet IN PLACE:
 * the person signs in or registers, and the walk resumes without the gate
 * closing. The account surface is one hook mounted by App; the gate sheet is
 * a great-grandchild of a different sheet. Threading a callback through every
 * layer between them would make three components carry a prop they do not
 * read, so the request is a tiny seam instead: the surface listens, anybody
 * may ask. No DOM events, so a test can hold both ends in Node.
 *
 * WHAT COMES BACK is not a result. Success is observed the way every other
 * account change is — `onAccountChanged` from main — which is what lets the
 * gate re-run itself whether the person signed in here, in the header, or on
 * the lock screen.
 */

type Listener = () => void

const listeners = new Set<Listener>()

/** The surface subscribes once; the unsubscribe is the return. */
export function onAccountSheetRequest(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Ask the mounted account surface to open. False when nothing is listening —
 * the phone companion and the demo tab have no owner surface, and a caller
 * that gets false should say so rather than wait for a sheet that will not
 * appear.
 */
export function requestAccountSheet(): boolean {
  for (const listener of listeners) listener()
  return listeners.size > 0
}
