import type { PathReport } from '../../../shared/path-report'

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
 * exist because a diagnostic must never become traffic. Four of them:
 *
 *   A RACE THAT TRIED NOTHING IS NOT A RACE. A report with no rows and no
 *   WebRTC row tells the Mac nothing, and on 2026-09-08 empty reports CLAIMED
 *   THE FLOOR below and the one race that had found something was dropped. An
 *   empty report is refused before any other guard is touched. (Since the
 *   per-machine names went, 2026-11-16, a race's rows are its WebRTC rows.)
 *
 *   NOTHING WHILE ONE IS IN FLIGHT. On a phone that has just lost the LAN, the
 *   post itself can be the request that hangs; a second race arriving on the
 *   timer must not queue a second one behind it.
 *
 *   A FLOOR UNDER THE GAP. Two races landing together (a timer and a network
 *   move) describe the same moment. The second is dropped.
 *
 *   AND THE SAME RACE, AGAIN, IS NOT NEWS. Reporting an identical race every
 *   minute would write 1,440 identical lines a day to the desktop's console
 *   and fill a twenty-deep buffer with twenty copies of one fact. Only the
 *   moment it CHANGES is worth a post.
 *
 * A FAILED REPORT IS NOT AN INCIDENT. It runs on the same plane that is
 * already in trouble; the whole point of it is to describe a path that does not
 * work, so it must never throw into a race loop or count against anything.
 */

/** Far below the 60 s race clock, and far above two races landing together. */
export const PATH_REPORT_MIN_GAP_MS = 5_000

export interface PathReporterDeps {
  /** Send it. Rejects on anything but a clean acceptance. */
  readonly post: (report: PathReport) => Promise<void>
  readonly now?: () => number
  readonly minGapMs?: number
  /** Optional, and deliberately quiet by default — see the docblock. */
  readonly log?: (message: string) => void
}

/**
 * What makes one race DIFFERENT from the one before it.
 *
 * Everything except the clock: the same candidates ending the same way under
 * the same permission is the same fact, however many minutes later it is
 * observed again.
 */
const signatureOf = (report: PathReport): string =>
  JSON.stringify([report.plane, report.permission, report.browser, report.attempts, report.probes ?? []])

/**
 * A reporter with its three guards, as a value.
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
  let lastSignature: string | null = null

  return async (report: PathReport): Promise<boolean> => {
    // FIRST, AND WITHOUT TOUCHING ANYTHING. A report with no rows describes no
    // race, and its only observable effect was to suppress the report that did.
    // A WebRTC row alone (a link knocked open or one that ended) is a fact.
    if (report.attempts.length === 0 && (report.probes?.length ?? 0) === 0) return false
    if (inFlight) return false
    const at = now()
    if (lastAt !== null && at - lastAt < gap) return false
    const signature = signatureOf(report)
    if (signature === lastSignature) return false
    inFlight = true
    lastAt = at
    try {
      await deps.post(report)
      // Remembered only once it landed, so a report the desktop never received
      // is offered again by the next race rather than deduplicated away.
      lastSignature = signature
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
    // No `cache: 'no-store'`: on the console it would cost a preflight each time (data-plane.ts · CROSS_ORIGIN_NO_COOKIE).
    headers: { ...deps.headers, 'content-type': 'application/json' },
    body: JSON.stringify(report)
  })
  if (!response.ok) throw new Error(`the desktop refused the path report: ${response.status}`)
}
