import { readJsonBody } from './http'
import { noContent, refuse, v2Json, type Signed, type V2Context } from './v2-http'
import { teamAddress } from './v2-seats'
import type { DoorRecord } from './doors'
import { newRequestId } from './v2-events'

/**
 * IDENTITY v3 — THE ONE QUEUE (R1 seat).
 *
 * The model unifies the shapes a person answers into one requests[] list: a
 * sign-in waiting for a nod (today's approvals) and a guest asking for a
 * seat. GET /v2/me/requests is the VIEW over both: this store owns the seat
 * requests, and the join rows are read live from the pending sign-ins so
 * nothing is stored twice.
 *
 * A THIRD KIND IS GONE (0.6.0). A browser of the account could ask one Mac
 * for its keyboard on Wi-Fi, and the Mac answered with a pairing link sealed
 * to that browser. The page that asked was the relay's, and the relay carries
 * no page now: a machine of an account is entered from the console, with the
 * account. So nothing here opens, holds or answers such a request.
 *
 * IN MEMORY, LIKE A PENDING SIGN-IN. A request is a fact about a conversation
 * between people, not a fact the account is defined by. A seat request lives
 * seven days because a person may take that long to answer. A restart drops
 * them, and the asker asks again, which is the same thing a dropped pending
 * sign-in already does.
 *
 * ONE RULE THE REVOCATION TABLE FIXES (account-e2e §06): "not me" EMPTIES the
 * queue. Every request the account is party to, in either role, goes with the
 * alarm.
 */

export const SEAT_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** More than a busy owner answers at once; a flood cannot grow past it. */
const PER_ACCOUNT = 50

/** A guest asking to be seated at a team. Answered by the team's owner. */
export interface SeatRequest {
  id: string
  kind: 'seat'
  /** `@owner/team`. */
  team: string
  /** The owner who can say yes — the account this lands in the queue of. */
  owner: string
  /** The guest asking. Their own devices poll GET …/seat for the answer. */
  account: string
  address: string
  at: number
  expiresAt: number
  state: 'pending' | 'approved' | 'declined'
}

export class V2Requests {
  private readonly now: () => number
  private seats = new Map<string, SeatRequest>()

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  private live<T extends { expiresAt: number }>(r: T): boolean {
    return r.expiresAt > this.now()
  }

  private sweep(): void {
    for (const [id, r] of this.seats) if (!this.live(r)) this.seats.delete(id)
  }

  // ── seat requests (R1) ───────────────────────────────────────────────────

  /**
   * A guest asks for a seat. ONE LIVE PER (team, account): asking twice does
   * not stack two rows on the owner's prompt, it returns the one already
   * waiting — so a guest refreshing the page cannot bury the owner's queue.
   *
   * `opened` SAYS WHETHER ANYTHING HAPPENED, and it is the whole point of the
   * return shape (H5). The caller announces an arrival on the owner's
   * account:changed feed, and that feed's tail is bounded — so a repeat ask
   * that opened no row must not be announced as one. A request that did not
   * open a row is not a thing that happened.
   */
  openSeat(input: {
    team: string
    owner: string
    account: string
    address: string
  }): { request: SeatRequest; opened: boolean } {
    this.sweep()
    const existing = [...this.seats.values()].find(
      (r) => r.team === input.team && r.account === input.account && r.state === 'pending'
    )
    if (existing) return { request: existing, opened: false }
    const at = this.now()
    const request: SeatRequest = {
      id: newRequestId(),
      kind: 'seat',
      team: input.team,
      owner: input.owner,
      account: input.account,
      address: input.address,
      at,
      expiresAt: at + SEAT_TTL_MS,
      state: 'pending'
    }
    this.capFor(request.owner)
    this.seats.set(request.id, request)
    return { request, opened: true }
  }

  /** The pending seat requests an owner should be answering. */
  seatsForOwner(owner: string): SeatRequest[] {
    this.sweep()
    return [...this.seats.values()]
      .filter((r) => r.owner === owner && r.state === 'pending')
      .sort((a, b) => b.at - a.at)
  }

  get(id: string): SeatRequest | null {
    this.sweep()
    return this.seats.get(id) ?? null
  }

  /**
   * The owner answers a seat request. The grant itself is the caller's to do
   * (it holds the seats store); this only records what the request became.
   */
  decideSeat(id: string, owner: string, decision: 'approve' | 'decline'): SeatRequest | null {
    const r = this.seats.get(id)
    if (r === undefined || r.owner !== owner || r.state !== 'pending' || !this.live(r)) return null
    const answered: SeatRequest = { ...r, state: decision === 'approve' ? 'approved' : 'declined' }
    this.seats.set(id, answered)
    return answered
  }

  /**
   * "NOT ME" EMPTIES THE QUEUE. Every request the account is party to in
   * either role (a seat it is asking for, a seat it is being asked for) goes
   * with the alarm.
   */
  emptyFor(username: string): number {
    let dropped = 0
    for (const [id, r] of this.seats) {
      if (r.owner === username || r.account === username) {
        this.seats.delete(id)
        dropped += 1
      }
    }
    return dropped
  }

  /** Oldest-first eviction for one account, so a flood only crowds itself. */
  private capFor(username: string): void {
    const mine = [...this.seats.values()]
      .filter((r) => r.owner === username || r.account === username)
      .sort((a, b) => a.at - b.at)
    for (const spare of mine.slice(0, Math.max(0, mine.length - (PER_ACCOUNT - 1)))) {
      this.seats.delete(spare.id)
    }
  }
}

// ── the wire: one shape over two stores ───────────────────────────────────

/** One row of GET /v2/me/requests. `account`, `team`, `device` per the kind. */
export interface RequestRow {
  id: string
  kind: 'join' | 'seat'
  device?: string
  account?: string
  team?: string
  address: string
  at: number
  expiresAt: number
  state: string
}

const SMALL_BODY = 16 * 1024

/**
 * GET /v2/me/requests — the one queue.
 *
 * join rows are read LIVE from the pending sign-ins (the approvals view), so
 * a request answered at /v2/me/approvals leaves this list on its own with no
 * second store to keep in step. Seat rows are the ones this account owns.
 */
export function listRequests(ctx: V2Context, signed: Signed): void {
  const username = signed.account.username
  const join: RequestRow[] = ctx.v2.factors.pending.approvalsFor(username).map((a) => ({
    id: a.id,
    kind: 'join' as const,
    device: a.deviceName,
    address: a.address,
    at: a.at,
    expiresAt: a.expiresAt,
    state: 'pending'
  }))
  const seat: RequestRow[] = ctx.v2.requests.seatsForOwner(username).map((r) => ({
    id: r.id,
    kind: 'seat' as const,
    account: r.account,
    team: r.team,
    address: r.address,
    at: r.at,
    expiresAt: r.expiresAt,
    state: r.state
  }))
  // Newest first across both, so the prompt shows what just arrived.
  const rows = [...join, ...seat].sort((a, b) => b.at - a.at)
  v2Json(ctx.response, 200, rows)
}

/**
 * POST /v2/me/requests/:id {decision} — the owner answers.
 *
 * A SEAT request is the team owner's to grant or decline; approving grants the
 * seat here, so the guest's own GET …/seat sees it next poll. A join id is not
 * answered here: it keeps its own route at /v2/me/approvals, where the
 * number-matching rung lives.
 */
export async function decideRequest(ctx: V2Context, signed: Signed, id: string): Promise<void> {
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok) {
    refuse(ctx.response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const decision = body.value.decision
  if (decision !== 'approve' && decision !== 'decline') {
    refuse(ctx.response, 400, 'malformed')
    return
  }
  const username = signed.account.username
  const r = ctx.v2.requests.get(id)
  // Only the team's owner answers a seat request.
  if (r === null || r.owner !== username) {
    refuse(ctx.response, 404, 'not_found')
    return
  }
  const answered = ctx.v2.requests.decideSeat(id, username, decision)
  if (answered === null) {
    refuse(ctx.response, 404, 'not_found')
    return
  }
  if (decision === 'approve') {
    // The grant is the point of the approval. `already_seated` is not a
    // failure of the answer — the guest ended up seated, which is what the
    // owner said yes to — so it reads as done.
    const out = ctx.v2.seats.grant({ team: r.team, account: r.account, by: username })
    if (!out.ok && out.reason !== 'already_seated') {
      refuse(ctx.response, 400, out.reason)
      return
    }
  }
  ctx.v2.events.append(r.account, { kind: 'request', address: r.team })
  noContent(ctx.response)
}

/**
 * POST /v2/teams/@o/t/seat-requests (R1) — a signed-in guest asks for a seat.
 *
 * The owner learns through their queue and an account:changed of kind
 * `request`; the guest waits on GET …/seat as before. Mounted from the seat
 * routes, which have already resolved the door and the signed-in caller.
 *
 * LIMITED, LIKE EVERY SIBLING THAT WRITES (H5). A guest who never gets a seat
 * could otherwise ask without bound, and each ask reached the owner's feed. An
 * hour's window rather than a minute's, for the same reason minting a join
 * code has one: asking for a seat is a deliberate act a person does a handful
 * of times, and the window that catches somebody doing it in a loop is a long
 * one rather than a fast one. A REPEAT ASK COUNTS against the bucket even
 * though it opens no row — the route did the work either way, and a client
 * hammering a no-op is a client that should be told to stop. It loses nothing
 * by being refused: it already has its pending request, and the answer it is
 * waiting for arrives on GET …/seat.
 */
export function openSeatRequest(
  ctx: V2Context,
  signed: Signed,
  door: DoorRecord
): void {
  const team = teamAddress(door.handle, door.name)
  const owner = door.handle.replace(/^@/, '').toLowerCase()
  // Keyed by the ASKER, not by their address: the route already demands a
  // signed-in account, so the account is the thing doing the asking, and one
  // that moved between networks would otherwise earn a fresh bucket for free.
  if (!ctx.v2.limits.requests.take(`seat-request|${signed.account.username}`)) {
    refuse(ctx.response, 429, 'rate_limited', undefined, { 'retry-after': '3600' })
    return
  }
  const { request, opened } = ctx.v2.requests.openSeat({
    team,
    owner,
    account: signed.account.username,
    address: signed.account.username
  })
  // ONLY AN ARRIVAL IS ANNOUNCED. The queue has held one row per (team,
  // account) from the start; announcing every ask meant a stranger who never
  // got a seat could still push the owner's revokes and joins off the end of a
  // bounded feed — the one channel this design has for telling them.
  if (opened) ctx.v2.events.append(owner, { kind: 'request', address: team })
  v2Json(ctx.response, 201, {
    id: request.id,
    kind: 'seat',
    team,
    state: request.state,
    expiresAt: request.expiresAt
  })
}

/** GET /v2/me/events?since= — the poll every device catches up on. */
export function listEvents(ctx: V2Context, signed: Signed, since: number): void {
  const feed = ctx.v2.events.since(signed.account.username, since)
  v2Json(ctx.response, 200, feed)
}
