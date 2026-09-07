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

/**
 * THE WAYS ONE CANDIDATE CAN END, and each of them is a different story.
 *
 * FOUR OF THESE USED TO BE ONE WORD. Until the probe learned to say why it
 * failed (path/hello-result.ts), a timeout, a browser refusing before it
 * connected, a certificate failure and a 421 all arrived here as 'no-answer' —
 * which is what put four identical rows in front of the owner and left nobody,
 * including the agent reading the screenshot, able to tell them apart.
 *
 * 'no-answer' is kept because a row is a stored value and the word must stay
 * spellable; no race produces it any more.
 */
export type AttemptOutcome =
  | 'answered'
  | 'no-answer'
  | 'refused'
  | 'unverified'
  | 'timeout'
  | 'blocked'
  | 'network'
  | 'http'

export interface PathAttempt {
  /**
   * THE ADDRESS, NOT THE NAME. `192-168-1-24.<deviceId>.d.cookrew.dev` carries
   * a permanent device identifier in a label, and certificate transparency
   * already publishes enough of those. The row says 192.168.1.24:8643, which
   * is the part a reader can act on.
   */
  readonly name: string
  readonly outcome: AttemptOutcome
  /** Present only for 'http': the status something on that port actually said. */
  readonly status?: number
  /** The measured round trip, or null where there was nothing to measure. */
  readonly ms: number | null
  /** The plane this candidate would have become. */
  readonly plane: 'LAN' | 'TAILNET'
  readonly chosen: boolean
  /**
   * The browser's own words, scrubbed of anything address-shaped.
   *
   * A reader who has been told the kind sometimes wants the exact exception —
   * it is the difference between filing a bug and guessing at one. It is never
   * the sentence: the sentence is ours, in path-copy.ts.
   */
  readonly detail?: string
  /**
   * WHICH ADDRESS-SPACE VARIANT THE VERDICT IS ABOUT, where it is news.
   *
   * 'none' on an answer means the probe only got through after dropping the
   * local-network annotation; 'none' on 'blocked' means the browser refused it
   * with AND without one. Both are the signature of a system proxy hiding the
   * address from Chrome (152, 2026-09-08), and both change what a reader should
   * do next. Spelled here rather than imported so this store keeps importing
   * nothing; the source of the word is local-network.ts · AddressSpaceHint.
   */
  readonly hint?: 'local' | 'none'
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
