import {
  PATH_REPORTS_KEPT,
  PATH_REPORT_DEVICES_KEPT,
  PATH_REPORT_MAX_ATTEMPTS,
  PATH_REPORT_TEXT_MAX,
  type PathReport,
  type PathReportAttempt,
  type StoredPathReport
} from '../shared/path-report'

/**
 * WHAT THE PHONES SAY ABOUT REACHING THIS MAC, KEPT WHERE IT CAN BE READ.
 *
 * THE INCIDENT. The owner's phone showed the "why this path" panel with four
 * LAN candidates, the same three words under every one of them, and a
 * 13,328 ms relay round trip. Establishing anything at all about it required
 * the owner to photograph a phone screen and send the picture — a diagnosis by
 * screenshot, for a fact the phone already knew precisely.
 *
 * So the phone posts each race here and the Mac keeps the last few. The owner,
 * or an agent with the token, reads `/api/path/reports` and gets what the panel
 * drew, per device, with no phone involved.
 *
 * IN MEMORY AND BOUNDED ON BOTH AXES. Twenty reports per device and eight
 * devices: this is a diagnostic buffer, not a log. A file would be a retention
 * question, a permissions question and a thing to sweep; a process restart
 * losing it costs one race, which is sixty seconds.
 *
 * NOTHING TRUSTED THAT ARRIVED IN THE BODY. The route is authenticated, and an
 * authenticated caller is still a caller: every string is cut to printable
 * ASCII and to a length before it is stored, because these are drawn in a
 * terminal (an escape sequence in a "detail" is a terminal that gets driven)
 * and served back as JSON.
 *
 * THE LOG LINE HAS NO ADDRESSES IN IT. One line per report — who, which plane,
 * how many candidates, and a count per outcome. The addresses are in the
 * report and the report is behind the token; a line in a console that may be
 * shared over a shoulder does not need somebody's LAN inventory in it.
 */

/** Who the report came from, as far as this Mac is entitled to say. */
export interface PathReportDevice {
  /** The bridge's device id, or null on a direct plane where nothing names one. */
  readonly deviceId: string | null
  readonly name?: string
}

export interface PathReportStore {
  /** Take one report. Null means the body was not a report and nothing was kept. */
  readonly record: (device: PathReportDevice, body: unknown) => StoredPathReport | null
  /** Every report held, newest first, across devices. */
  readonly list: () => readonly StoredPathReport[]
  /** Test seam, and the one way to empty it. */
  readonly reset: () => void
}

const PLANES: ReadonlySet<string> = new Set(['LAN', 'TAILNET', 'RELAY'])
const PERMISSIONS: ReadonlySet<string> = new Set(['granted', 'denied', 'prompt', 'unsupported'])

/** The bucket a report with no named device goes in, and the name it is logged as. */
const UNNAMED_KEY = ''
const UNNAMED_DEVICE = 'an unnamed phone'

/**
 * Printable ASCII, collapsed and cut — the same rule the admitted-devices
 * ledger applies to a name the relay carries, and for the same reason: this is
 * drawn in a terminal and an escape sequence is not text.
 */
const safeText = (raw: unknown, max = PATH_REPORT_TEXT_MAX): string => {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** A round trip, or null. Never NaN, never negative, never a fraction. */
const safeMs = (raw: unknown): number | null =>
  typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : null

const readAttempt = (raw: unknown): PathReportAttempt | null => {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const name = safeText(row.name)
  const outcome = safeText(row.outcome, 24)
  if (name.length === 0 || outcome.length === 0) return null
  const status = safeMs(row.status)
  const detail = safeText(row.detail)
  return {
    name,
    outcome,
    ms: safeMs(row.ms),
    ...(status !== null ? { status } : {}),
    ...(detail.length > 0 ? { detail } : {})
  }
}

/**
 * A body, read as a report, or refused.
 *
 * Strict about the two fields whose vocabulary is a contract — the plane and
 * the shape of `attempts` — and forgiving about the rest: an unknown
 * permission word is stored as 'unsupported' rather than costing the whole
 * report, because a browser that grows a fifth state must not silently stop
 * being diagnosable by this Mac.
 */
export const readPathReport = (body: unknown, receivedAt: number): PathReport | null => {
  if (!body || typeof body !== 'object') return null
  const raw = body as Record<string, unknown>
  const plane = typeof raw.plane === 'string' ? raw.plane : ''
  if (!PLANES.has(plane)) return null
  if (!Array.isArray(raw.attempts)) return null
  const attempts = raw.attempts
    .slice(0, PATH_REPORT_MAX_ATTEMPTS)
    .map(readAttempt)
    .filter((attempt): attempt is PathReportAttempt => attempt !== null)
  const permission = typeof raw.permission === 'string' ? raw.permission : ''
  return {
    at: safeMs(raw.at) ?? receivedAt,
    plane: plane as PathReport['plane'],
    permission: PERMISSIONS.has(permission) ? permission : 'unsupported',
    browser: safeText(raw.browser, 40) || 'other',
    attempts
  }
}

/**
 * "3 blocked, 1 timeout" — the counts, in the order they first appear.
 *
 * A summary rather than a list because the list is the report: the line exists
 * so somebody watching a console knows a report arrived and roughly what it
 * says, and can then go and read it.
 */
export const outcomeSummary = (attempts: readonly PathReportAttempt[]): string => {
  const counts = attempts.reduce<readonly (readonly [string, number])[]>((so, attempt) => {
    const seen = so.find(([outcome]) => outcome === attempt.outcome)
    return seen
      ? so.map((one) => (one[0] === attempt.outcome ? ([one[0], one[1] + 1] as const) : one))
      : [...so, [attempt.outcome, 1] as const]
  }, [])
  return counts.length === 0
    ? 'nothing tried'
    : counts.map(([outcome, count]) => `${count} ${outcome}`).join(', ')
}

/** The one line a report writes to the console. No addresses, no tokens. */
export const pathReportLine = (report: StoredPathReport): string =>
  `[cookrew] path report from ${report.device ?? UNNAMED_DEVICE}: ${report.plane} · ` +
  `${report.attempts.length} candidate${report.attempts.length === 1 ? '' : 's'} · ` +
  outcomeSummary(report.attempts)

export interface PathReportStoreDeps {
  readonly now?: () => number
  /** The desktop's logger. console.error is where every other [cookrew] line goes. */
  readonly log?: (message: string) => void
}

/** One device's bucket, newest report first. */
interface Bucket {
  readonly key: string
  readonly at: number
  readonly reports: readonly StoredPathReport[]
}

export const createPathReportStore = (deps: PathReportStoreDeps = {}): PathReportStore => {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((message: string): void => console.error(message))
  // Rebuilt as a value on every write. A bucket list of at most eight entries
  // is not worth a mutable structure, and a diagnostic that a reader is
  // iterating while a phone reports must not be able to change underneath it.
  let buckets: readonly Bucket[] = []

  return {
    record: (device, body) => {
      const receivedAt = now()
      const read = readPathReport(body, receivedAt)
      if (!read) return null
      const key = device.deviceId ?? UNNAMED_KEY
      const stored: StoredPathReport = {
        ...read,
        receivedAt,
        device: safeText(device.name, 64) || null
      }
      const existing = buckets.find((bucket) => bucket.key === key)
      const kept: Bucket = {
        key,
        at: receivedAt,
        reports: [stored, ...(existing?.reports ?? [])].slice(0, PATH_REPORTS_KEPT)
      }
      buckets = [kept, ...buckets.filter((bucket) => bucket.key !== key)]
        // Oldest device out first, so a phone reinstalled many times cannot
        // push the phone that is actually in use out of the buffer.
        .sort((a, b) => b.at - a.at)
        .slice(0, PATH_REPORT_DEVICES_KEPT)
      try {
        log(pathReportLine(stored))
      } catch {
        // A console that will not take a line is not a reason to lose a report.
      }
      return stored
    },
    list: () =>
      buckets
        .flatMap((bucket) => bucket.reports)
        .slice()
        .sort((a, b) => b.receivedAt - a.receivedAt),
    reset: () => void (buckets = [])
  }
}

/**
 * The process's own store.
 *
 * A module singleton rather than another field threaded through the server's
 * dependency object: it holds no handles, survives nothing, and the two routes
 * that use it are the only readers there will ever be. Tests build their own
 * with createPathReportStore.
 */
let shared: PathReportStore | null = null
export const pathReports = (): PathReportStore => (shared ??= createPathReportStore())
