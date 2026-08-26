import path from 'node:path'
import { safeSegment, serviceRoot, sessionSegment } from './session-sandbox'

/**
 * WHO A SESSION IS, AND WHERE ITS LEDGER LIVES.
 *
 * Two things that look like bookkeeping and are not. The key decides whether a
 * returning caller finds their work or silently gets a new session; the ledger
 * path decides whether a stranger's turns land in the owner's history.
 */

/**
 * A session's identity — keyed by ACCOUNT, not credential-sub (R31).
 *
 * The distinction is correctness, not tidiness. A credential-sub is
 * per-enrolment: the same person arriving from a second device, or after a key
 * rotation, is a different `sub` — and would silently have been given a fresh
 * session and lost their work. An account survives both.
 *
 * THE ORDINAL IS REQUIRED, and the demo's own table is why: ana-1 on V1 and
 * ana-2 on V2 at the same time. So the question the instantiator asks is never
 * "does a session exist for this account" but "is there an OPEN one", and a
 * closed session's ordinal is never reused — a reused ordinal would resurrect a
 * dead session's sandbox path.
 */
export interface SessionIdentity {
  sessionId: string
  /** URL segment. Joins the workspace slug namespace, so it cannot shadow. */
  slug: string
  /** What the owner reads in the Sessions table. */
  workspaceName: string
}

export function sessionIdentity(
  serviceId: string,
  accountId: string,
  ordinal: number
): SessionIdentity {
  const account = safeSegment(accountId)
  const service = safeSegment(serviceId)
  const sessionId = `${service}-${account}-${ordinal}`
  return {
    sessionId,
    // The svc/ prefix keeps every served session in one namespace so it can
    // never collide with a workspace the owner named themselves — the owner's
    // own slugs are derived from names and never carry it.
    slug: `svc-${sessionId}`,
    workspaceName: `${accountId} · ${ordinal}`
  }
}

/**
 * The next ordinal for an account, given the ordinals already used.
 *
 * Highest + 1 over EVERY session ever minted for this account, open or closed —
 * not the count of open ones. Counting open sessions would hand a returning
 * caller the ordinal of one that has ended, and END destroys sandboxes: the new
 * session would be minted onto a path that was just deleted, or worse, onto one
 * whose deletion is still in flight.
 */
export function nextOrdinal(usedOrdinals: readonly number[]): number {
  let highest = 0
  for (const n of usedOrdinals) if (n > highest) highest = n
  return highest + 1
}

/**
 * WHERE A SESSION'S TURN LEDGER LIVES — the partition.
 *
 * `new TurnStore()` defaults to ~/.cookrew/turns, process-wide. A served
 * session using it would append a stranger's turns into the owner's history:
 * the owner's search would return them, their activity board would count them,
 * and a fold over the owner's ledger would be folding somebody else's
 * conversation.
 *
 * That is the ledger-write-choke family made cross-tenant. The lane's own
 * lesson was that a store which quietly serves a partial view as the whole
 * truth is the dangerous shape; a store that quietly accepts another tenant's
 * writes is the same defect pointed outward, and it is worse because the
 * mixing cannot be undone by re-deriving — the records are interleaved and both
 * tenants' are real.
 *
 * So the partition is a DIRECTORY, not a filter. A filter is a thing callers
 * can forget to apply and reviewers have to check at every call site; a
 * separate root cannot be forgotten because there is nothing to forget — the
 * session's TurnStore is constructed over its own directory and has no path to
 * the owner's.
 */
export function sessionTurnDir(base: string, serviceId: string, sessionId: string): string {
  return path.join(serviceRoot(base, serviceId), sessionSegment(serviceId, sessionId), '.cookrew', 'turns')
}

/**
 * The annotation sidecar for the same session.
 *
 * Beside the ledger and inside the sandbox for the same reason: Sous titles for
 * a caller's conversation are that conversation's, and an owner's annotation
 * store that silently gained a stranger's checkpoints would be the same mixing
 * one file over.
 */
export function sessionAnnotationDir(
  base: string,
  serviceId: string,
  sessionId: string
): string {
  return path.join(
    serviceRoot(base, serviceId),
    sessionSegment(serviceId, sessionId),
    '.cookrew',
    'checkpoint-annotations'
  )
}
