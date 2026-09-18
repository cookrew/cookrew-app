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

/**
 * "A JOIN CODE ARRIVED" — the same seam, for the other thing that opens a
 * card from outside (v3, D8).
 *
 * `cookrew://join#<code>` is parsed in main and delivered on the one deep-link
 * channel App already holds — the bridge keeps a SINGLE subscriber slot, so a
 * second listener in the account surface would silently replace App's and the
 * import links would stop arriving. App routes the verb here instead, which
 * costs one line there and keeps every deep link parsed in exactly one place.
 */
type JoinListener = (code: string) => void

const joinListeners = new Set<JoinListener>()

export function onJoinRequest(listener: JoinListener): () => void {
  joinListeners.add(listener)
  return () => {
    joinListeners.delete(listener)
  }
}

/** Ask the mounted surface to offer this code. False when nothing listens. */
export function requestJoin(code: string): boolean {
  for (const listener of joinListeners) listener(code)
  return joinListeners.size > 0
}
