// What one answer to GET <base>api/levels says about the link. The relay and
// the desktop both speak here, and they mean different things by the same
// status: a relay 401 is the ACCOUNT cookie gone, a desktop 401 is the PAIRING
// token refused; a relay 503 `no_link` is a Mac not holding its line, a relay
// 503 `too_many_exchanges` is this browser over the desktop's budget.
// (registry/src/v2-canvas-relay.ts · src/main/mobile-api.ts)
import type { MachineLink } from '../../shared/strata'

/** Why a link is where it is: for retry copy and the debug panel, never shown raw. */
export type LinkDetail =
  | 'signed-out'
  | 'refused'
  | 'no-token'
  | 'no-link'
  | 'busy'
  | 'capped'
  | 'timeout'
  | 'unreachable'
  | 'no-levels'
  | 'stream-dropped'
  | 'silent'
  | 'gap'
  | 'server'

export type Retry = 'backoff' | 'outdated' | 'never'

export interface LinkOutcome {
  link: MachineLink
  detail: LinkDetail
  retry: Retry
}

const errorOf = (body: unknown): string | null =>
  typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
    ? (body as { error: string }).error
    : null

/** A non-200 answer, or a 200 that is not a snapshot this version reads (`body` undefined = not JSON). */
export const outcomeOf = (status: number, body: unknown): LinkOutcome => {
  const error = errorOf(body)
  if (status === 200) return { link: 'outdated', detail: 'no-levels', retry: 'outdated' }
  if (status === 401 && error === 'unauthenticated') return { link: 'error', detail: 'signed-out', retry: 'never' }
  if (status === 401 || status === 403) return { link: 'unpaired', detail: 'refused', retry: 'never' }
  if (status === 404 || status === 405 || status === 501) return { link: 'outdated', detail: 'no-levels', retry: 'outdated' }
  if (status === 429) return { link: 'offline', detail: 'capped', retry: 'backoff' }
  if (status === 503 && (error === 'too_many_exchanges' || error === 'busy')) return { link: 'connecting', detail: 'busy', retry: 'backoff' }
  if (status === 504) return { link: 'offline', detail: 'timeout', retry: 'backoff' }
  if (status === 502 || status === 503) return { link: 'offline', detail: 'no-link', retry: 'backoff' }
  return { link: 'error', detail: 'server', retry: 'backoff' }
}

/** fetch() itself threw: no answer at all, or our own timeout fired. */
export const outcomeOfThrow = (timedOut: boolean): LinkOutcome => ({
  link: 'offline',
  detail: timedOut ? 'timeout' : 'unreachable',
  retry: 'backoff'
})
