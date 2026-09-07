/**
 * WHAT THE PHONE TELLS THE MAC ABOUT A RACE IT LOST.
 *
 * THE INCIDENT. The owner's phone, on the relay page at cookrew.dev, showed
 * four LAN candidates in the "why this path" panel with the same three words
 * under every one of them and a 13,328 ms relay round trip above them. The
 * only way anyone could look at that was for the owner to photograph a phone
 * screen and send the picture — and a screenshot cannot be diffed, cannot be
 * asked a follow-up question, and stops existing the moment the panel is
 * closed.
 *
 * So the phone posts what it found to the Mac it was trying to reach, and the
 * Mac keeps the last few. `curl /api/path/reports` on the desktop then answers
 * the question the photograph was standing in for.
 *
 * THE SHAPE IS DELIBERATELY SMALL, and every field earns its place:
 *
 *   at, plane        — when, and what the session settled on.
 *   permission       — what the browser says about the local network. Half of
 *                      the diagnosis on its own.
 *   browser          — a family and a major version, never a user-agent
 *                      string. See browser-family.ts.
 *   attempts         — one row per candidate, exactly as the panel drew it.
 *
 * AND WHAT IS NOT IN IT MATTERS AS MUCH. No token: the credential is in the
 * Authorization header where every other companion route puts it, and a body
 * that echoed it would put a bearer token in a diagnostic buffer, a log line
 * and a curl output. No URL: `name` is the ADDRESS the trusted label spells,
 * which is what a reader can act on, and a `detail` is scrubbed of anything
 * address-shaped before it leaves the phone.
 *
 * Shared rather than declared twice because the two sides of a wire that drift
 * apart are how a diagnostic starts lying about the thing it exists to
 * diagnose.
 */

/** POST — one report per race. */
export const PATH_REPORT_ROUTE = '/api/path/report'

/** GET — the last few, per device, for the owner or an agent with the token. */
export const PATH_REPORTS_ROUTE = '/api/path/reports'

/** How many reports the Mac keeps per admitted device. */
export const PATH_REPORTS_KEPT = 20

/**
 * How many devices the Mac keeps reports for.
 *
 * The store is in memory and fed by an authenticated route, so it is bounded
 * on both axes: a phone reinstalled a hundred times must not be a hundred
 * buckets held for the life of the process.
 */
export const PATH_REPORT_DEVICES_KEPT = 8

/** As many candidates as a race can plausibly have raced. */
export const PATH_REPORT_MAX_ATTEMPTS = 12

/** The longest a name or a detail may be before it is cut. */
export const PATH_REPORT_TEXT_MAX = 120

/** Everything one candidate did, as the panel drew it. */
export interface PathReportAttempt {
  /** The address form — `192.168.1.24:8643`, never the trusted label. */
  readonly name: string
  readonly outcome: string
  /** Present only for an 'http' outcome. */
  readonly status?: number
  readonly ms: number | null
  /** The browser's own words, already scrubbed of anything address-shaped. */
  readonly detail?: string
}

export interface PathReport {
  readonly at: number
  readonly plane: 'LAN' | 'TAILNET' | 'RELAY'
  /** A LocalNetworkState: 'granted' | 'denied' | 'prompt' | 'unsupported'. */
  readonly permission: string
  /** `Chrome 142`, `Safari 17`, `other`. */
  readonly browser: string
  readonly attempts: readonly PathReportAttempt[]
}

/** A report as the Mac keeps it: what arrived, plus who it arrived from and when. */
export interface StoredPathReport extends PathReport {
  readonly receivedAt: number
  /** The name the relay gave the device, or null on a direct plane. */
  readonly device: string | null
}
