import { v2Json, type Signed, type V2Context } from './v2-http'

/**
 * IDENTITY v3 — WHAT IS WAITING FOR AN ANSWER, AND WHAT HAPPENED.
 *
 * GET /v2/me/requests is a VIEW, and it holds nothing of its own: the rows are
 * the account's sign-ins waiting for a nod, read live from the pending
 * sign-ins (the approvals view), so a request answered at /v2/me/approvals
 * leaves this list by itself with no second store to keep in step.
 *
 * TWO OTHER KINDS ARE GONE (0.6.0), each with the page that raised it. A
 * browser of the account could ask one Mac for its keyboard on Wi-Fi (the
 * relay's page), and a signed-in guest could ask a team's owner for a seat
 * (the team's page). Neither page exists now, so nothing here opens, holds or
 * answers such a request, and no request is answered on this path at all: a
 * sign-in is answered at /v2/me/approvals, where the number-matching rung
 * lives. A seat is bought at the door or granted by the owner by username
 * (v2-seat-routes.ts); neither was ever a request.
 */

/** One row of GET /v2/me/requests: a device waiting to sign in. */
export interface RequestRow {
  id: string
  kind: 'join'
  device?: string
  address: string
  at: number
  expiresAt: number
  state: string
}

/** GET /v2/me/requests — the sign-ins waiting on this account, newest first. */
export function listRequests(ctx: V2Context, signed: Signed): void {
  const rows: RequestRow[] = ctx.v2.factors.pending
    .approvalsFor(signed.account.username)
    .map((a) => ({
      id: a.id,
      kind: 'join' as const,
      device: a.deviceName,
      address: a.address,
      at: a.at,
      expiresAt: a.expiresAt,
      state: 'pending'
    }))
    .sort((a, b) => b.at - a.at)
  v2Json(ctx.response, 200, rows)
}

/** GET /v2/me/events?since= — the poll every device catches up on. */
export function listEvents(ctx: V2Context, signed: Signed, since: number): void {
  const feed = ctx.v2.events.since(signed.account.username, since)
  v2Json(ctx.response, 200, feed)
}
