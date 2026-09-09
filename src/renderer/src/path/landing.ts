import type { PathReport } from '../../../shared/path-report'
import { addressFromTrustedName, parseAddress } from '../../../shared/reach-names'

/**
 * WHAT THE PAGE THAT ARRIVED SAYS ABOUT THE TRIP.
 *
 * The OPEN ON WI-FI button (DirectOfferRow.tsx) is a top-level navigation from
 * cookrew.dev to the Mac's trusted name, and on the owner's iPhone on
 * 2026-09-09 it went blank for some twenty seconds before the canvas came up —
 * long enough to photograph and give up on. Nothing on the Mac could say where
 * those seconds went: the relay page had already unloaded, and the landed page
 * knew only that it had landed.
 *
 * It knows more than that. The browser keeps the navigation's own timeline —
 * name lookup, connect, TLS, first byte — and a page that arrived with
 * `from=relay` on its query string is exactly the page whose timeline answers
 * "was it DNS, the certificate, or the Mac". So it posts one row, shaped like
 * a race the panel already knows how to draw: `landed`, the whole trip in
 * `ms`, and the split in `detail`.
 *
 * THE URL IS READ AND NEVER REPEATED. The navigation entry's name is the
 * address the page was opened with, token and all; only two facts leave this
 * module — that `from=relay` was on it, and the host's address form — and the
 * test pins that the credential is in neither.
 */

/** The slice of PerformanceNavigationTiming this reads, so a test needs no browser. */
export interface LandingTiming {
  readonly name: string
  readonly startTime: number
  readonly domainLookupStart: number
  readonly domainLookupEnd: number
  readonly connectStart: number
  readonly secureConnectionStart: number
  readonly connectEnd: number
  readonly requestStart: number
  readonly responseStart: number
}

export interface LandingFacts {
  readonly timing: LandingTiming | null
  /** `location.host` — the trusted name or the bare address, with its port. */
  readonly host: string
  readonly plane: PathReport['plane']
  readonly browser: string
  readonly permission: string
  readonly now: number
}

export const LANDED = 'landed'

/** True when the page was opened by the relay page's button, not typed or bookmarked. */
export const arrivedFromRelay = (href: string): boolean => {
  try {
    return new URL(href).searchParams.get('from') === 'relay'
  } catch {
    return false
  }
}

const span = (from: number, to: number): number | null =>
  Number.isFinite(from) && Number.isFinite(to) && to >= from && from >= 0 ? Math.round(to - from) : null

/** A phase the browser measured: its start is a real timestamp, not the zero it writes for "did not happen". */
const phase = (from: number, to: number): number | null => (from > 0 ? span(from, to) : null)

/**
 * The trip, split the way a reader diagnoses it.
 *
 * A phase the browser did not measure — a reused connection has no lookup, a
 * plain-HTTP page has no TLS — is left out rather than written as zero, so a
 * zero that IS reported means the phase happened and was instant.
 */
export const landingDetail = (timing: LandingTiming): string => {
  const phases: readonly (readonly [string, number | null])[] = [
    ['dns', phase(timing.domainLookupStart, timing.domainLookupEnd)],
    ['connect', phase(timing.connectStart, timing.connectEnd)],
    ['tls', phase(timing.secureConnectionStart, timing.connectEnd)],
    ['wait', phase(timing.requestStart, timing.responseStart)]
  ]
  return phases
    .filter((phase): phase is readonly [string, number] => phase[1] !== null)
    .map(([name, ms]) => `${name} ${ms} ms`)
    .join(' · ')
}

/** `192.168.2.40:8643` from either the trusted name or the bare address the page is on. */
export const landedAddress = (host: string): string | null => {
  const at = host.lastIndexOf(':')
  const port = at > 0 && /^\d+$/.test(host.slice(at + 1)) ? host.slice(at + 1) : null
  const bare = port === null ? host : host.slice(0, at)
  const unbracketed = bare.replace(/^\[|\]$/g, '')
  const address = parseAddress(unbracketed) ? unbracketed : addressFromTrustedName(unbracketed)
  if (!address) return null
  return port === null ? address : `${address}:${port}`
}

/**
 * The one report a landed page makes, or null when there is nothing to say:
 * a page not opened by the button, or a browser with no navigation timing.
 */
export const landingReport = (facts: LandingFacts): PathReport | null => {
  if (!facts.timing || !arrivedFromRelay(facts.timing.name)) return null
  const name = landedAddress(facts.host)
  if (!name) return null
  const ms = span(facts.timing.startTime, facts.timing.responseStart)
  return {
    at: facts.now,
    plane: facts.plane,
    permission: facts.permission,
    browser: facts.browser,
    attempts: [{ name, outcome: LANDED, ms, detail: landingDetail(facts.timing) }]
  }
}

/** The browser's own navigation entry, or null where it keeps none. */
export const navigationTiming = (): LandingTiming | null => {
  try {
    const entries = performance.getEntriesByType('navigation')
    const entry = entries[0] as (PerformanceEntry & Partial<LandingTiming>) | undefined
    if (!entry || typeof entry.responseStart !== 'number') return null
    return {
      name: entry.name,
      startTime: entry.startTime,
      domainLookupStart: entry.domainLookupStart ?? 0,
      domainLookupEnd: entry.domainLookupEnd ?? 0,
      connectStart: entry.connectStart ?? 0,
      secureConnectionStart: entry.secureConnectionStart ?? 0,
      connectEnd: entry.connectEnd ?? 0,
      requestStart: entry.requestStart ?? 0,
      responseStart: entry.responseStart
    }
  } catch {
    return null
  }
}
