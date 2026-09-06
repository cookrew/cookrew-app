/**
 * WHAT THE LAST RACE ACTUALLY DID, kept so somebody can be shown it.
 *
 * The badge is a conclusion — one word — and a conclusion with no evidence
 * behind it is the thing every product in this survey gets asked about. Home
 * Assistant's "Connected via" is reported as unreliable by its own users, and
 * what they mean is that they have no way to check it. Plex publishes its
 * connection list; Chrome Remote Desktop has a stats panel; Syncthing spells
 * transport and locality together. The ones without an explainer have the
 * support threads.
 *
 * ONE RACE AT A TIME AND ONLY THE LAST ONE. A log would be a second thing to
 * bound, page and eventually leak; the question a reader actually has is "why
 * is it like this NOW", and that is answered by the most recent race and
 * nothing before it.
 *
 * SHAPED LIKE path-link.ts on purpose — a value, a set of listeners, a
 * subscribe — because the thing that writes it is a race loop that knows
 * nothing about React.
 */

/** The four ways one candidate can end, and they are four different stories. */
export type AttemptOutcome = 'answered' | 'no-answer' | 'refused' | 'unverified'

export interface PathAttempt {
  /**
   * THE ADDRESS, NOT THE NAME. `192-168-1-24.<deviceId>.d.cookrew.dev` carries
   * a permanent device identifier in a label, and certificate transparency
   * already publishes enough of those. The row says 192.168.1.24:8643, which
   * is the part a reader can act on.
   */
  readonly name: string
  readonly outcome: AttemptOutcome
  /** The measured round trip, or null where there was nothing to measure. */
  readonly ms: number | null
  /** The plane this candidate would have become. */
  readonly plane: 'LAN' | 'TAILNET'
  readonly chosen: boolean
}

export interface PathAttempts {
  readonly attempts: readonly PathAttempt[]
  /** Where the session actually ended up. */
  readonly settled: 'LAN' | 'TAILNET' | 'RELAY'
}

const EMPTY: PathAttempts = { attempts: [], settled: 'RELAY' }

let state: PathAttempts = EMPTY
const listeners = new Set<(next: PathAttempts) => void>()

export const pathAttempts = (): PathAttempts => state

export const recordAttempts = (
  attempts: readonly PathAttempt[],
  settled: 'LAN' | 'TAILNET' | 'RELAY'
): void => {
  state = { attempts: [...attempts], settled }
  for (const listener of listeners) listener(state)
}

export const subscribePathAttempts = (listener: (next: PathAttempts) => void): (() => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Test seam: the module is a singleton and a test needs a clean one. */
export const resetPathAttempts = (): void => {
  state = EMPTY
  listeners.clear()
}
