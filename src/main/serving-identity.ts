import { relayHandle, type HandleSource } from './legacy-identity'

/**
 * THE NAME THE DOORS ARE PUBLISHED UNDER, WHEN IT CHANGES (V3-FIX-SERVING-ID).
 *
 * `relayHandle` is a pure table and it has always been right. What was wrong is
 * that its answer was taken ONCE, at module load, into a `const` — so a Mac
 * that booted local-only and then claimed an account went on publishing its
 * doors under whatever the environment or its old key said. Everything on
 * screen said @magpie; cookrew.dev listed @drej/team. A seat bought against
 * @magpie/team then cannot admit anyone at that door, and the cut-1 promise
 * that a seat follows the person quietly does not hold on that machine until
 * it is restarted.
 *
 * This is the third time the same shape has been found: the certificate
 * `ensure` pass was boot-and-hourly and served self-signed for up to an hour
 * after a claim ("the first run of the product, every time"), the approval
 * queue was started under `if (accounts.account())` at module load and never
 * announced a join, and this. The lesson each time is the same — a fact that
 * can change after boot must be resolved from the moment it changes, not from
 * the order the module happened to run in.
 *
 * SO THE DECISION LIVES HERE, PURE. The caller re-resolves whenever the
 * account may have changed and does what this says; a test can walk every
 * transition a real Mac can make without a relay, a registry or a clock.
 */

/** What the caller is serving under now, and what it should do about it. */
export interface ServingChange {
  /** The freshly resolved handle. Empty when this Mac can serve nothing. */
  handle: string
  source: HandleSource | 'none'
  /** `relayHandle`'s line for the log, or null. */
  note: string | null
  /** Did the answer move at all? */
  changed: boolean
  /**
   * Must the doors already on the relay be taken down and listed again?
   *
   * ONLY when they are listed under a name that is no longer this Mac's AND
   * there is a new name to list them under. A door's address is built from the
   * handle, so republishing moves it — links people hold to the old address
   * stop resolving. That is the right trade exactly once: while the door is
   * listed under a name the account cannot prove, it cannot honour a seat, so
   * the link that still works is a link to a door that refuses the person it
   * was bought for.
   */
  republish: boolean
}

export interface ServingInput {
  /**
   * The handle the doors on the relay are currently listed under, or '' when
   * nothing is served. Read from the relay's own held doors rather than from
   * the last resolution: what matters is what cookrew.dev has, not what this
   * process last decided.
   */
  serving: string
  account: string | null
  legacy: string | null
  env: string | null
}

export function servingChange(input: ServingInput): ServingChange {
  const resolved = relayHandle({ account: input.account, legacy: input.legacy, env: input.env })
  const changed = resolved.handle !== input.serving
  /**
   * NOTHING IS REPUBLISHED WHEN THE NEW ANSWER IS "NO NAME".
   *
   * Signing out is the way to get here: the account goes, and neither a legacy
   * key nor the environment names anything. The doors are then listed under a
   * name this Mac no longer holds a session for — but taking somebody's doors
   * down as a side effect of signing out of a sheet is a destructive surprise
   * nobody asked for, and the callers those doors are carrying are real. The
   * caller says so in the log and leaves them up; withdrawing is a verb the
   * owner has, on the surface where they can see what it costs.
   */
  const republish = changed && resolved.handle !== '' && input.serving !== ''
  return {
    handle: resolved.handle,
    source: resolved.source,
    note: resolved.note,
    changed,
    republish,
  }
}

/**
 * TAKE EVERY DOOR DOWN AND PUT IT BACK UNDER THE NEW NAME.
 *
 * Separated from `index.ts` because this is the part that moves state a person
 * paid for, and it has three rules worth holding still:
 *
 *   ONE AT A TIME. A relay dial per door, all at once, against a registry that
 *   is about to list them all — the serial walk is slower and is the version
 *   whose failure mode is "some doors moved", not "the machine hammered
 *   cookrew.dev while the owner watched".
 *
 *   A DOOR THAT FAILS DOES NOT STOP THE REST. Each is independent; the one
 *   that could not be re-listed is reported and the others still move. Stopping
 *   at the first failure would leave the remaining doors under the old name
 *   with nothing scheduled to try again.
 *
 *   WITHDRAW BEFORE SERVE. `serve` is idempotent per slug and returns the held
 *   door untouched, so re-serving without withdrawing first is a no-op — which
 *   is exactly how a "fix" here could look like it ran and change nothing.
 */
export async function republishDoors(deps: {
  slugs: () => readonly string[]
  withdraw: (slug: string) => Promise<void>
  serve: (slug: string) => Promise<void>
  log?: (message: string) => void
}): Promise<{ moved: number; failed: readonly string[] }> {
  const log = deps.log ?? ((): void => undefined)
  const failed: string[] = []
  let moved = 0
  for (const slug of deps.slugs()) {
    try {
      await deps.withdraw(slug)
      await deps.serve(slug)
      moved += 1
    } catch (error) {
      failed.push(slug)
      log(`[cookrew] ${slug} could not be re-listed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { moved, failed }
}
