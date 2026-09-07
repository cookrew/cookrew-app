import { landedFromRelay } from './pairing-scope'

/**
 * DID THIS PAGE ARRIVE FROM THE RELAY, AND HAS ANYBODY BEEN TOLD?
 *
 * The OPEN ON WI-FI button is the one navigation a relayed companion may make
 * (path/direct-offer.ts). The phone that pressed it lands on the Mac's own
 * trusted name — an address the reader did not type and has probably never
 * seen — while the cookrew.dev URL they DO know has vanished from the bar. One
 * line, once, is what that swap owes them.
 *
 * READ AT MODULE LOAD, AND THAT IS THE WHOLE DESIGN. The boot takes both the
 * token and `from=relay` off the URL (auth-gate.ts · `scrubPairingFromUrl`),
 * and it does so from INSIDE a function — so any module body runs first. Ask
 * the question later and the answer is always no, which is the kind of bug
 * that only shows up on a real phone. There is no ordering to get right here
 * because there is no ordering: importing this file is the capture.
 *
 * SHAPED LIKE local-network-gate.ts — a value, a set of listeners, a subscribe
 * — because the thing that reads it is React and the thing that sets it is a
 * URL.
 */

/** `window.location.search` as it was before anything scrubbed it. */
const bootSearch = (): string => {
  try {
    return (
      (globalThis as { window?: { location?: { search?: string } } }).window?.location?.search ?? ''
    )
  } catch {
    // Some embedded web views throw on touching the location. Not knowing how
    // this page was reached is the same answer as "ordinarily".
    return ''
  }
}

let arrived = landedFromRelay(bootSearch())
const listeners = new Set<(next: boolean) => void>()

/** True while the note still has something to say. */
export const landedDirect = (): boolean => arrived

/**
 * The reader has read it. Not persisted anywhere on purpose: the marker is
 * already off the URL, so the next load cannot raise the note again and there
 * is nothing left for a stored flag to suppress.
 */
export const dismissLandedNote = (): void => {
  if (!arrived) return
  arrived = false
  for (const listener of listeners) listener(arrived)
}

export const subscribeLandedNote = (listener: (next: boolean) => void): (() => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Test seam: the module is a singleton and a test needs to stand elsewhere. */
export const resetLandedNote = (search = ''): void => {
  arrived = landedFromRelay(search)
  listeners.clear()
}
