import { readJsonBody } from './http'
import { noContent, refuse, v2Json, type Signed, type V2Context } from './v2-http'
import { teamAddress } from './v2-seats'
import type { DoorRecord } from './doors'
import { isSealedToDevice, type SealedToDevice } from './v2-device-seal'
import { newRequestId } from './v2-events'

/**
 * IDENTITY v3 — THE ONE QUEUE (R1 seat, R2 reach).
 *
 * The model unifies three shapes a person answers into one requests[] list:
 * a sign-in waiting for a nod (today's approvals), a guest asking for a seat,
 * and a device asking to reach a Mac on Wi-Fi. GET /v2/me/requests is the VIEW
 * over all three — this store owns the two that are new, and the join rows are
 * read live from the pending sign-ins so nothing is stored twice.
 *
 * IN MEMORY, LIKE A PENDING SIGN-IN. A request is a fact about a conversation
 * between devices, not a fact the account is defined by. A seat request lives
 * seven days because a person may take that long to answer; a reach request
 * lives ten minutes because a Mac either says ALLOW while the phone is in a
 * hand or the moment has passed. A restart drops them, and the asker asks
 * again — which is the same thing a dropped pending sign-in already does.
 *
 * TWO RULES THE REVOCATION TABLE FIXES (account-e2e §06):
 *   · revoking a device VOIDS its pending requests — the ones it made and the
 *     reach requests aimed at it, because neither can be answered any more.
 *   · "not me" EMPTIES the queue — every request the account is party to, in
 *     any role, goes with the alarm.
 *
 * THE PAIRING URL IS NEVER IN THE CLEAR HERE. A reach request carries the
 * asking device's PUBLIC key to the Mac; the Mac seals the pairing URL to it
 * (v2-device-seal, the relay's own construction) and hands back ciphertext.
 * This store holds only that ciphertext, hands it to the asking device's own
 * poll once, and forgets it. The registry cannot read what it relays — the
 * same promise the door relay makes, kept the same way.
 */

const SEAT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const REACH_TTL_MS = 10 * 60 * 1000
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

/** A device asking to reach one Mac on Wi-Fi. Answered by that Mac (ALLOW). */
export interface ReachRequest {
  id: string
  kind: 'reach'
  /** The account both devices belong to — reach is same-account only. */
  account: string
  /** The Mac being asked. The request lands in its queue and no other. */
  desktopDeviceId: string
  /** The device asking, so the Mac knows who to seal for and the poll is scoped. */
  askingDeviceId: string
  askingDeviceName: string
  /** The asking device's PUBLIC key, so the Mac can seal without a round trip. */
  askKey: Record<string, string>
  address: string
  at: number
  expiresAt: number
  /** pending → the Mac has not answered; allowed → sealed URL waiting for the
   *  asker's poll; delivered → handed over and forgotten; declined → refused. */
  state: 'pending' | 'allowed' | 'delivered' | 'declined'
  /** The pairing URL, sealed to the asking device. Present only while `allowed`. */
  sealed?: SealedToDevice
}

export type AnyRequest = SeatRequest | ReachRequest

export class V2Requests {
  private readonly now: () => number
  private seats = new Map<string, SeatRequest>()
  private reaches = new Map<string, ReachRequest>()

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  private live<T extends { expiresAt: number }>(r: T): boolean {
    return r.expiresAt > this.now()
  }

  private sweep(): void {
    for (const [id, r] of this.seats) if (!this.live(r)) this.seats.delete(id)
    for (const [id, r] of this.reaches) if (!this.live(r)) this.reaches.delete(id)
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

  // ── reach requests (R2) ───────────────────────────────────────────────────

  /**
   * A device asks to reach one Mac. Lands in that Mac's queue only.
   *
   * ONE LIVE PER (asking device, Mac), for the same two reasons the seat side
   * has one: a phone that asks twice means one thing and should appear once on
   * that Mac's prompt, and the arrival is announced on a bounded feed. A
   * DECLINED ask does not dedupe — the state is no longer pending — so asking
   * again after a NOT NOW is a new question, which is what it is.
   */
  openReach(input: {
    account: string
    desktopDeviceId: string
    askingDeviceId: string
    askingDeviceName: string
    askKey: Record<string, string>
    address: string
  }): { request: ReachRequest; opened: boolean } {
    this.sweep()
    const existing = [...this.reaches.values()].find(
      (r) =>
        r.askingDeviceId === input.askingDeviceId &&
        r.desktopDeviceId === input.desktopDeviceId &&
        r.state === 'pending'
    )
    if (existing) return { request: existing, opened: false }
    const at = this.now()
    const request: ReachRequest = {
      id: newRequestId(),
      kind: 'reach',
      account: input.account,
      desktopDeviceId: input.desktopDeviceId,
      askingDeviceId: input.askingDeviceId,
      askingDeviceName: input.askingDeviceName,
      askKey: input.askKey,
      address: input.address,
      at,
      expiresAt: at + REACH_TTL_MS,
      state: 'pending'
    }
    this.capFor(request.account)
    this.reaches.set(request.id, request)
    return { request, opened: true }
  }

  /** The pending reach requests one Mac should be answering — its own only. */
  reachesForDesktop(deviceId: string): ReachRequest[] {
    this.sweep()
    return [...this.reaches.values()]
      .filter((r) => r.desktopDeviceId === deviceId && r.state === 'pending')
      .sort((a, b) => b.at - a.at)
  }

  get(id: string): AnyRequest | null {
    this.sweep()
    return this.seats.get(id) ?? this.reaches.get(id) ?? null
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
   * The Mac says ALLOW, handing over the pairing URL ALREADY SEALED to the
   * asking device. This store never sees it in the clear — it holds the
   * ciphertext until the asker's poll and no longer.
   */
  allowReach(id: string, desktopDeviceId: string, sealed: SealedToDevice): ReachRequest | null {
    const r = this.reaches.get(id)
    if (r === undefined || r.desktopDeviceId !== desktopDeviceId || r.state !== 'pending' || !this.live(r)) {
      return null
    }
    const answered: ReachRequest = { ...r, state: 'allowed', sealed }
    this.reaches.set(id, answered)
    return answered
  }

  declineReach(id: string, desktopDeviceId: string): ReachRequest | null {
    const r = this.reaches.get(id)
    if (r === undefined || r.desktopDeviceId !== desktopDeviceId || r.state !== 'pending' || !this.live(r)) {
      return null
    }
    const answered: ReachRequest = { ...r, state: 'declined' }
    this.reaches.set(id, answered)
    return answered
  }

  /**
   * The asking device collects its sealed pairing URL — ONCE. Scoped to the
   * asker (a different device gets nothing, and could not open it anyway), and
   * forgotten the instant it is handed over: the registry keeps no copy of a
   * secret it was only ever relaying.
   */
  takeSealed(id: string, askingDeviceId: string): SealedToDevice | null {
    const r = this.reaches.get(id)
    if (r === undefined || r.askingDeviceId !== askingDeviceId || r.state !== 'allowed' || !this.live(r)) {
      return null
    }
    this.reaches.set(id, { ...r, state: 'delivered', sealed: undefined })
    return r.sealed ?? null
  }

  // ── the revocation table (§06) ─────────────────────────────────────────────

  /**
   * REVOKING A DEVICE VOIDS ITS PENDING REQUESTS. Both directions: a reach it
   * asked for (it is gone, so nothing should still be sealed to it) and a
   * reach aimed at it (nobody is left to answer). Returns how many, for the
   * event and the test.
   */
  voidDevice(deviceId: string): number {
    let voided = 0
    for (const [id, r] of this.reaches) {
      if (r.askingDeviceId === deviceId || r.desktopDeviceId === deviceId) {
        this.reaches.delete(id)
        voided += 1
      }
    }
    return voided
  }

  /**
   * "NOT ME" EMPTIES THE QUEUE. Every request the account is party to in any
   * role — a seat it is asking for, a seat it is being asked for, a reach
   * between its own devices — goes with the alarm.
   */
  emptyFor(username: string): number {
    let dropped = 0
    for (const [id, r] of this.seats) {
      if (r.owner === username || r.account === username) {
        this.seats.delete(id)
        dropped += 1
      }
    }
    for (const [id, r] of this.reaches) {
      if (r.account === username) {
        this.reaches.delete(id)
        dropped += 1
      }
    }
    return dropped
  }

  /** Oldest-first eviction for one account, so a flood only crowds itself. */
  private capFor(username: string): void {
    const mine = [
      ...[...this.seats.values()].filter((r) => r.owner === username || r.account === username),
      ...[...this.reaches.values()].filter((r) => r.account === username)
    ].sort((a, b) => a.at - b.at)
    for (const spare of mine.slice(0, Math.max(0, mine.length - (PER_ACCOUNT - 1)))) {
      this.seats.delete(spare.id)
      this.reaches.delete(spare.id)
    }
  }
}

// ── the wire: one shape over three stores ─────────────────────────────────

/** One row of GET /v2/me/requests. `account`, `team`, `device` per the kind. */
export interface RequestRow {
  id: string
  kind: 'join' | 'reach' | 'seat'
  device?: string
  account?: string
  team?: string
  address: string
  at: number
  expiresAt: number
  state: string
  /** reach only: the asking device's public key, for the Mac to seal to. */
  askKey?: Record<string, string>
}

const SMALL_BODY = 16 * 1024

/**
 * GET /v2/me/requests — the one queue.
 *
 * join rows are read LIVE from the pending sign-ins (the approvals view), so
 * a request answered at /v2/me/approvals leaves this list on its own with no
 * second store to keep in step. Seat rows are the ones this account owns;
 * reach rows are the ones aimed at THIS device — a Mac answers its own, and a
 * phone of the same account never sees another Mac's keyboard request.
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
  const reach: RequestRow[] = ctx.v2.requests.reachesForDesktop(signed.claims.dev).map((r) => ({
    id: r.id,
    kind: 'reach' as const,
    device: r.askingDeviceName,
    address: r.address,
    at: r.at,
    expiresAt: r.expiresAt,
    state: r.state,
    askKey: r.askKey
  }))
  // Newest first across all three, so the prompt shows what just arrived.
  const rows = [...join, ...seat, ...reach].sort((a, b) => b.at - a.at)
  v2Json(ctx.response, 200, rows)
}

/**
 * GET /v2/me/requests/:id — the asking device collecting its sealed answer.
 *
 * Only a reach request has anything to poll here: a seat answer is read at
 * GET …/seat as today, and a join answer at the sign-in poll. The sealed
 * pairing URL is handed to the ASKER once and forgotten; anyone else — even
 * another device of the same account — is told it is still pending, because
 * whether a request was allowed is the asker's business.
 */
export function getRequest(ctx: V2Context, signed: Signed, id: string): void {
  const r = ctx.v2.requests.get(id)
  if (r === null || r.kind !== 'reach' || r.askingDeviceId !== signed.claims.dev) {
    // 404, not 403: a device asking about a request that is not its own must
    // not learn that it exists.
    refuse(ctx.response, 404, 'not_found')
    return
  }
  if (r.state === 'allowed') {
    const sealed = ctx.v2.requests.takeSealed(id, signed.claims.dev)
    if (sealed !== null) {
      v2Json(ctx.response, 200, { id, kind: 'reach', state: 'allowed', sealed })
      return
    }
  }
  if (r.state === 'declined') {
    v2Json(ctx.response, 200, { id, kind: 'reach', state: 'declined' })
    return
  }
  // pending, or already delivered (the seal is gone and does not come back).
  v2Json(ctx.response, 200, { id, kind: 'reach', state: r.state === 'delivered' ? 'delivered' : 'pending' })
}

/**
 * POST /v2/me/requests/:id {decision} — the owner or the Mac answers.
 *
 * A SEAT request is the team owner's to grant or decline; approving grants the
 * seat here, so the guest's own GET …/seat sees it next poll. A REACH request
 * is the target Mac's to allow (with the pairing URL already sealed to the
 * asking device) or decline. A join id is not answered here — it keeps its own
 * route at /v2/me/approvals, where the number-matching rung lives.
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
  if (r === null) {
    refuse(ctx.response, 404, 'not_found')
    return
  }

  if (r.kind === 'seat') {
    // Only the team's owner answers a seat request.
    if (r.owner !== username) {
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
    return
  }

  // A reach request: answered by the Mac it named, and by no other device.
  if (r.desktopDeviceId !== signed.claims.dev) {
    refuse(ctx.response, 404, 'not_found')
    return
  }
  if (decision === 'decline') {
    if (ctx.v2.requests.declineReach(id, signed.claims.dev) === null) {
      refuse(ctx.response, 404, 'not_found')
      return
    }
    noContent(ctx.response)
    return
  }
  // ALLOW carries the pairing URL ALREADY SEALED to the asking device. The
  // registry validates the shape and never the contents — it cannot read them.
  if (!isSealedToDevice(body.value.sealed)) {
    refuse(ctx.response, 400, 'malformed')
    return
  }
  if (ctx.v2.requests.allowReach(id, signed.claims.dev, body.value.sealed) === null) {
    refuse(ctx.response, 404, 'not_found')
    return
  }
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

/**
 * POST /v2/me/desktops/:id/reach-requests (R2) — a device of the account asks
 * to reach one Mac on Wi-Fi. It lands in that Mac's queue and carries the
 * asking device's public key, so the Mac can seal the pairing URL to it with
 * no round trip and the registry never sees a token.
 */
export function openReachRequest(ctx: V2Context, signed: Signed, targetDeviceId: string): void {
  const target = signed.account.desktops.find((d) => d.deviceId === targetDeviceId)
  if (target === undefined) {
    refuse(ctx.response, 404, 'not_found')
    return
  }
  // Asking to reach the very device you are on is a no-op the queue should not
  // carry — you already have that Mac's keyboard.
  if (targetDeviceId === signed.claims.dev) {
    refuse(ctx.response, 400, 'malformed')
    return
  }
  // The same bucket as a seat ask, under its own key. This route only takes a
  // device of the account, so the threat is narrower — but a route that writes
  // to a bounded feed is a route with a limiter, and consistency here is what
  // stops the next one being written without one.
  if (!ctx.v2.limits.requests.take(`reach-request|${signed.claims.dev}`)) {
    refuse(ctx.response, 429, 'rate_limited', undefined, { 'retry-after': '3600' })
    return
  }
  const { request, opened } = ctx.v2.requests.openReach({
    account: signed.account.username,
    desktopDeviceId: targetDeviceId,
    askingDeviceId: signed.claims.dev,
    askingDeviceName: signed.device.name,
    askKey: signed.device.jwk,
    address: signed.device.name
  })
  if (opened) ctx.v2.events.append(signed.account.username, { kind: 'request', device: target.name })
  v2Json(ctx.response, 201, {
    id: request.id,
    kind: 'reach',
    state: request.state,
    expiresAt: request.expiresAt
  })
}

/** GET /v2/me/events?since= — the poll every device catches up on. */
export function listEvents(ctx: V2Context, signed: Signed, since: number): void {
  const feed = ctx.v2.events.since(signed.account.username, since)
  v2Json(ctx.response, 200, feed)
}
