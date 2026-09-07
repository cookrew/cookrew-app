import {
  PATH_REPORT_MAX_ATTEMPTS,
  type PathReport,
  type PathReportAttempt
} from '../../../shared/path-report'
import type { PathAttempt } from '../path-attempts'

/**
 * THE PHONE TELLS THE MAC WHAT IT FOUND, so nobody has to photograph a screen.
 *
 * The panel answers the reader who is holding the phone. This answers everyone
 * else: the owner at the desk, and the agent asked why the companion is on the
 * relay. Both used to be served by a photograph of a phone screen showing four
 * rows that said "no answer" — which cannot be diffed, cannot be asked a
 * follow-up question, and is gone the moment the sheet is closed.
 *
 * ONE POST PER RACE, AND NOT ONE MORE. A race already happens at most once a
 * minute, so the guards here are not a rate limit in the usual sense — they
 * exist because a diagnostic must never become traffic. Two of them:
 *
 *   NOTHING WHILE ONE IS IN FLIGHT. On a phone that has just lost the LAN, the
 *   post itself can be the request that hangs; a second race arriving on the
 *   timer must not queue a second one behind it.
 *
 *   A FLOOR UNDER THE GAP. Pressing ALLOW starts a race beside the timer's, and
 *   the two describe the same moment. The second is dropped.
 *
 * A FAILED REPORT IS NOT AN INCIDENT. It runs on the same plane that is
 * already in trouble; the whole point of it is to describe a path that does not
 * work, so it must never throw into a race loop or count against anything.
 */

/** Far below the 60 s race clock, and far above two races landing together. */
export const PATH_REPORT_MIN_GAP_MS = 5_000

/**
 * The rows, as the wire carries them: the panel's own words minus the two
 * fields that are the panel's business — `plane`, which is per row and already
 * in the settled plane, and `chosen`, which is a drawing instruction.
 */
export const reportedAttempts = (
  attempts: readonly PathAttempt[]
): readonly PathReportAttempt[] =>
  attempts.slice(0, PATH_REPORT_MAX_ATTEMPTS).map((attempt) => ({
    name: attempt.name,
    outcome: attempt.outcome,
    ms: attempt.ms,
    ...(attempt.status !== undefined ? { status: attempt.status } : {}),
    ...(attempt.detail !== undefined ? { detail: attempt.detail } : {})
  }))

export interface PathReporterDeps {
  /** Send it. Rejects on anything but a clean acceptance. */
  readonly post: (report: PathReport) => Promise<void>
  readonly now?: () => number
  readonly minGapMs?: number
  /** Optional, and deliberately quiet by default — see the docblock. */
  readonly log?: (message: string) => void
}

/**
 * A reporter with its two guards, as a value.
 *
 * Returns whether the report was SENT, so a test can assert "once per race"
 * rather than counting requests through a stubbed network.
 */
export const createPathReporter = (
  deps: PathReporterDeps
): ((report: PathReport) => Promise<boolean>) => {
  const now = deps.now ?? ((): number => Date.now())
  const gap = deps.minGapMs ?? PATH_REPORT_MIN_GAP_MS
  let inFlight = false
  let lastAt: number | null = null

  return async (report: PathReport): Promise<boolean> => {
    if (inFlight) return false
    const at = now()
    if (lastAt !== null && at - lastAt < gap) return false
    inFlight = true
    lastAt = at
    try {
      await deps.post(report)
      return true
    } catch (error) {
      // The plane this went over is the one being complained about. Saying so
      // is all that can be done, and it is not worth a race loop's stability.
      deps.log?.(`path report not delivered: ${String(error)}`)
      return false
    } finally {
      inFlight = false
    }
  }
}

/** The fetch this needs, narrowed so a test needs no browser. */
export type ReportFetch = (
  url: string,
  init: RequestInit
) => Promise<{ readonly ok: boolean; readonly status: number }>

export interface PostPathReportDeps {
  /** Already scoped by apiPath, and NEVER carrying a query string. */
  readonly url: string
  readonly headers: Record<string, string>
  readonly fetch: ReportFetch
}

/**
 * One POST, on whichever plane is carrying the session.
 *
 * The credential travels in the Authorization header, exactly where every
 * other companion route puts it and nowhere else: a body that echoed a token
 * would put a bearer secret into a diagnostic buffer, a log line and the
 * output of the curl this whole feature exists to make possible.
 */
export const postPathReport = async (
  report: PathReport,
  deps: PostPathReportDeps
): Promise<void> => {
  const response = await deps.fetch(deps.url, {
    method: 'POST',
    headers: { ...deps.headers, 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(report)
  })
  if (!response.ok) throw new Error(`the desktop refused the path report: ${response.status}`)
}
