// WHEN THE RAIL FETCHES HISTORY (D1, T5 QA 2026-09-07).
//
// THE DEFECT. useStream has exposed `pageBack()` and `atOldest` since T3 and
// NOTHING CALLED THEM. The loaded set was therefore the newest 100 rows
// (/stream/open's own page) unioned with whatever the drawer's oldest-20
// prefetch happened to pull, so on a 1,048-row card T16…T950 were reachable
// only as a side effect of scrubbing — and the rail's scale said otherwise.
//
// THE POLICY, and why it is a pure function. Two surfaces need history: a
// scrub or a keyboard step that walks toward the oldest loaded row, and a
// drawer opened at a checkpoint this client has never indexed. Both reduce to
// one question — "is the position being reached close to, or older than, the
// oldest row I hold?" — and answering it here rather than inside the hook is
// what lets the trigger be argued as arithmetic instead of reproduced by hand
// at phone width.
//
// ONE PAGE IN FLIGHT. A scrub is a stream of pointer events, and a policy that
// fired per event would put ten identical `?before=` requests on the wire and
// merge ten copies of the same page. `inFlight` is the whole guard, and the
// hook coalesces onto the page already running rather than queueing another.

import type { StreamCheckpoint } from './stream-types'

/**
 * How close to the oldest loaded row a position must come before the next
 * page is fetched.
 *
 * Ten rows, not one: the page has to be ON THE WIRE before the scrub arrives,
 * or the rail draws a gap for as long as the round trip takes. Ten rows of a
 * 100-row page is a tenth of a screenful of warning, which is the same shape
 * of lead the drawer's own prefetch uses.
 */
export const PAGE_BACK_THRESHOLD = 10

/** The oldest ordinal this client holds, or null when it holds nothing. */
export function oldestOrdinal(index: readonly StreamCheckpoint[]): number | null {
  return index[0]?.ordinal ?? null
}

/** Is `ordinal` inside what this client has already indexed? */
export function isOrdinalLoaded(index: readonly StreamCheckpoint[], ordinal: number): boolean {
  const oldest = oldestOrdinal(index)
  return oldest !== null && ordinal >= oldest
}

export interface PageBackInput {
  /** The stream ordinal a surface just reached. */
  reached: number
  /** The oldest ordinal loaded; null when nothing is. */
  oldestLoaded: number | null
  /** True once the server has said there is nothing older. */
  atOldest: boolean
  /** True while a page is already on the wire. */
  inFlight: boolean
}

/**
 * Should this reach put one more page of history on the wire?
 *
 * `atOldest` STOPS IT, unconditionally: the server's null backwards cursor is
 * the end of the chain, and a rail that kept asking would poll a card that has
 * no more history for as long as someone held the scrub at the top.
 */
export function shouldPageBack(input: PageBackInput): boolean {
  if (input.atOldest || input.inFlight) return false
  if (input.oldestLoaded === null) return false
  return input.reached - input.oldestLoaded <= PAGE_BACK_THRESHOLD
}

/**
 * A bound on how many pages one `ensureLoaded` may fetch.
 *
 * The loop's real stop is the position itself — it ends the moment the page
 * that contains the checkpoint has landed — and this is the backstop for a
 * server that keeps answering with a cursor that does not advance. Derived
 * from the chain's own length so it scales with the card rather than with a
 * number somebody guessed: every page is `pageSize` rows, plus one for the
 * partial page at the end and one for the round-up.
 */
export function maxPageBackSteps(total: number, pageSize: number): number {
  if (!Number.isFinite(total) || total <= 0 || pageSize <= 0) return 1
  return Math.ceil(total / pageSize) + 1
}

/** What the runner reads before every decision. Read FRESH each time — a page
 *  that lands mid-loop changes all three. */
export interface PageBackState {
  oldestLoaded: number | null
  atOldest: boolean
  /** The chain's length, which bounds how many pages a catch-up may fetch. */
  total: number
}

export interface PageBackPort {
  state: () => PageBackState
  /** Fetch ONE page older than what is loaded and fold it in. Must not throw:
   *  a failed page is reported as data by its caller, never as an exception
   *  into a rail render. */
  fetch: () => Promise<void>
  pageSize: number
}

export interface PageBackRunner {
  /** One page, coalescing onto the page already on the wire. */
  pageBack: () => Promise<void>
  /** The trigger — see shouldPageBack. Fire as often as a scrub does. */
  reach: (ordinal: number) => void
  /** Page until `ordinal` is loaded, the chain's oldest is, or nothing moves. */
  ensureLoaded: (ordinal: number) => Promise<void>
  inFlight: () => boolean
}

/**
 * The paging engine, with no React in it.
 *
 * Everything the hook contributes is a ref and a transport call; the ORDER of
 * decisions — coalesce, threshold, bound, stop on no progress — is here, so it
 * can be driven by a test that never mounts anything.
 */
export function createPageBackRunner(port: PageBackPort): PageBackRunner {
  let running: Promise<void> | null = null

  const pageBack = (): Promise<void> => {
    if (running !== null) return running
    if (port.state().atOldest) return Promise.resolve()
    let run: Promise<void>
    try {
      // Promise.resolve(...) BEFORE the flag is set, and the `finally` chained
      // onto it rather than wrapped around it: an async IIFE runs
      // synchronously to its first await, so a port that threw synchronously
      // would clear the flag and then have it re-assigned to an
      // already-rejected promise — the rail would never page again (review,
      // T5 QA 2026-09-07).
      run = Promise.resolve(port.fetch())
        .finally(() => {
          running = null
        })
        // Swallowed so `void pageBack()` from a pointer event can never become
        // an unhandled rejection, and so a coalescing caller is handed a
        // promise it can await; the port owns reporting the failure as data.
        .catch(() => undefined)
    } catch {
      // A port that throws before it returns a promise costs this page and
      // nothing else.
      running = null
      return Promise.resolve()
    }
    running = run
    return run
  }

  return {
    pageBack,
    inFlight: () => running !== null,
    reach(ordinal) {
      const { oldestLoaded, atOldest } = port.state()
      if (!shouldPageBack({ reached: ordinal, oldestLoaded, atOldest, inFlight: running !== null })) {
        return
      }
      void pageBack()
    },
    async ensureLoaded(ordinal) {
      const steps = maxPageBackSteps(port.state().total, port.pageSize)
      for (let step = 0; step < steps; step += 1) {
        const before = port.state()
        if (before.atOldest) return
        if (before.oldestLoaded !== null && before.oldestLoaded <= ordinal) return
        await pageBack()
        const after = port.state()
        // NO PROGRESS, NO SECOND ASK. A page that added no older row means
        // this server cannot reach further, and looping on it would be the
        // rail polling forever for history that is not there.
        if (after.oldestLoaded === before.oldestLoaded && after.atOldest === before.atOldest) {
          return
        }
      }
    }
  }
}
