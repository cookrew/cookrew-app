import { readJsonBody } from './http'
import { noContent, refuse, signedIn, v2Json, type Signed, type V2Context } from './v2-http'
import { teamAddress, type V2Seat } from './v2-seats'
import type { DoorRecord } from './doors'

/**
 * IDENTITY v2 — THE SEAT ROUTES.
 *
 * The gate order, from the architecture note: 401 sign in → 403 no seat →
 * 402 buy → open. This file answers the first two and RECORDS what the third
 * produced; it never takes money. The door still runs its own checkout at the
 * owner's app with the owner's keys, because the money is between those two
 * people and a registry in the middle of it would be a second thing to trust.
 *
 * WHO MAY ASK WHAT, in one place so it cannot drift:
 *   · the OWNER of the team: everything, including the list of seats.
 *   · a SEATED guest: their own seat, who else is seated, a call token.
 *   · anyone signed in: the team's terms and whether they hold a seat.
 *   · nobody signed out: a 401 carrying the reason a seat is worth an account.
 *
 * A seated guest sees the other seated USERNAMES and nothing else — never the
 * owner's devices, never a receipt, never another person's session.
 */

/** Bodies here are a username and, at most, a receipt line. */
const SEAT_BODY = 4 * 1024

/** `@Mira` and `mira ` are the same person typed by two different hands. */
const asUsername = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase().replace(/^@/, '') : ''

/** What a caller may be told about a seat. A receipt is the owner's business. */
const seatFace = (seat: V2Seat): Record<string, unknown> => ({
  id: seat.id,
  team: seat.team,
  account: seat.account,
  source: seat.source,
  by: seat.by,
  createdAt: seat.createdAt,
  ...(seat.expiresAt === undefined ? {} : { expiresAt: seat.expiresAt }),
  ...(seat.endedAt === undefined ? {} : { endedAt: seat.endedAt })
})

/** The team's own terms, as the page and the app both read them. */
const teamFace = (door: DoorRecord): Record<string, unknown> => ({
  name: teamAddress(door.handle, door.name),
  title: door.title,
  access: door.access,
  ...(door.priceUsd === undefined ? {} : { priceUsd: door.priceUsd }),
  rails: [...door.rails],
  door: door.door
})

interface Asked {
  door: DoorRecord
  team: string
  /** The signed-in caller, or null. */
  signed: Signed | null
  owner: boolean
}

/**
 * Answers true when it claimed the request. `rest` is the path after `/v2`,
 * so a seat route reads `teams/@owner/name/…`.
 */
export function handleSeatRoute(ctx: V2Context, rest: string[]): boolean {
  if (rest[0] === 'teams') {
    if (rest.length < 4) {
      refuse(ctx.response, 404, 'not_found')
      return true
    }
    team(ctx, rest[1], rest[2], rest.slice(3))
    return true
  }
  return false
}

/** GET /v2/me/seats — everything this person holds, anywhere. Mounted by /v2/me. */
export function mySeats(ctx: V2Context, signed: Signed): void {
  v2Json(ctx.response, 200, { seats: ctx.v2.seats.heldBy(signed.account.username).map(seatFace) })
}

function team(ctx: V2Context, rawHandle: string, rawName: string, tail: string[]): void {
  const { method, response } = ctx
  const handle = (ctx.decode(rawHandle) ?? '').replace(/^@/, '').toLowerCase()
  const name = (ctx.decode(rawName) ?? '').toLowerCase()
  const door = ctx.doors?.get(handle, name) ?? null
  if (door === null) {
    refuse(response, 404, 'not_found')
    return
  }
  const address = teamAddress(door.handle, door.name)
  const signed = signedIn(ctx.request, ctx.v2)
  if (signed === null) {
    // 401 FIRST, ALWAYS. A stranger must not be able to tell a team with an
    // empty room from one they were refused at, and the realm is what lets a
    // client show the door's own sentence beside the sign-in sheet.
    refuse(response, 401, 'unauthenticated', address, { 'www-authenticate': `Cookrew realm="${address}"` })
    return
  }
  const asked: Asked = { door, team: address, signed, owner: signed.account.username === door.handle }

  if (tail.length === 1 && tail[0] === 'seat' && method === 'GET') return mySeat(ctx, asked)
  if (tail.length === 1 && tail[0] === 'seated' && method === 'GET') return seated(ctx, asked)
  if (tail.length === 1 && tail[0] === 'call-token' && method === 'POST') return callToken(ctx, asked)
  if (tail.length === 1 && tail[0] === 'seats' && method === 'GET') return listSeats(ctx, asked)
  if (tail.length === 1 && tail[0] === 'seats' && method === 'POST') {
    void grantSeat(ctx, asked)
    return
  }
  if (tail.length === 2 && tail[0] === 'seats' && tail[1] === 'settle' && method === 'POST') {
    void settleSeat(ctx, asked)
    return
  }
  if (tail.length === 2 && tail[0] === 'seats' && method === 'DELETE') {
    endSeat(ctx, asked, ctx.decode(tail[1]) ?? '')
    return
  }
  refuse(response, 404, 'not_found')
}

/** Owner-only, refused in a sentence that names the person who could say yes. */
function ownerOnly(ctx: V2Context, asked: Asked): boolean {
  if (asked.owner) return true
  refuse(ctx.response, 403, 'not_owner', asked.door.handle)
  return false
}

// ── what one person holds ────────────────────────────────────────────────

function mySeat(ctx: V2Context, asked: Asked): void {
  const seat = ctx.v2.seats.activeFor(asked.team, asked.signed?.account.username ?? '')
  v2Json(ctx.response, 200, { seat: seat === null ? null : seatFace(seat), team: teamFace(asked.door) })
}

/**
 * WHO ELSE IS IN THE ROOM — usernames, to the people who are in it.
 *
 * The ruling is that a seated guest sees the other seated usernames, like a
 * room rather than a queue. Everyone else is told they have no seat, in the
 * same words as every other refusal, without learning who does.
 */
function seated(ctx: V2Context, asked: Asked): void {
  if (!asked.owner && ctx.v2.seats.activeFor(asked.team, asked.signed?.account.username ?? '') === null) {
    refuse(ctx.response, 403, 'no_seat', asked.door.handle)
    return
  }
  v2Json(ctx.response, 200, { usernames: ctx.v2.seats.seatedAt(asked.team) })
}

/**
 * THE WORD THE DOOR VERIFIES. Ten minutes, one audience, and the seat that
 * admitted this person — so the door can say what it let in, and so a seat the
 * owner ends stops producing tokens at once rather than at the next refresh.
 *
 * A team whose access is `account` charges nothing and needs no seat, but it
 * still needs an account: one must register to use a served agent (P7 and the
 * architecture note's second user rule). Signing in IS the gate there.
 */
function callToken(ctx: V2Context, asked: Asked): void {
  const signed = asked.signed
  if (signed === null) return
  const seat = ctx.v2.seats.activeFor(asked.team, signed.account.username)
  const admitted = asked.owner || asked.door.access !== 'paid' || seat !== null
  if (!admitted) {
    refuse(ctx.response, 403, 'no_seat', asked.door.handle)
    return
  }
  const minted = ctx.v2.tokens.mintCallToken(
    signed.account.username,
    signed.claims.dev,
    asked.team,
    seat?.id
  )
  // `account` so the caller's own UI can name who it is about to open the
  // line as, without a second round trip to /v2/me for a fact it just proved.
  v2Json(ctx.response, 201, {
    token: minted.token,
    exp: minted.exp,
    seat: seat?.id ?? null,
    aud: asked.team,
    account: signed.account.username
  })
}

// ── what the owner does ──────────────────────────────────────────────────

function listSeats(ctx: V2Context, asked: Asked): void {
  if (!ownerOnly(ctx, asked)) return
  v2Json(ctx.response, 200, { seats: ctx.v2.seats.forTeam(asked.team).map(seatFace) })
}

async function grantSeat(ctx: V2Context, asked: Asked): Promise<void> {
  if (!ownerOnly(ctx, asked)) return
  const body = await readJsonBody(ctx.request, SEAT_BODY)
  if (!body.ok) {
    refuse(ctx.response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const username = asUsername(body.value.username)
  // A SEAT IS GIVEN TO A PERSON, so the person has to exist. Granting to a
  // name nobody has claimed would park an entitlement on whoever registers it
  // next, which is not what the owner typed it for.
  if (!ctx.v2.accounts.has(username)) {
    refuse(ctx.response, 404, 'not_found')
    return
  }
  const out = ctx.v2.seats.grant({ team: asked.team, account: username, by: asked.door.handle })
  if (!out.ok) {
    refuse(ctx.response, out.reason === 'already_seated' ? 409 : 400, out.reason, username)
    return
  }
  v2Json(ctx.response, 201, { seat: seatFace(out.seat) })
}

/**
 * THE DOOR REPORTS A PURCHASE. The owner's app took the money at its own door,
 * on its own Stripe or x402 keys, and tells the registry who ended up paying.
 * It is the owner's session that says so — a caller cannot report their own
 * purchase, or a seat would cost a POST instead of a dollar.
 */
async function settleSeat(ctx: V2Context, asked: Asked): Promise<void> {
  if (!ownerOnly(ctx, asked)) return
  const body = await readJsonBody(ctx.request, SEAT_BODY)
  if (!body.ok) {
    refuse(ctx.response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const username = asUsername(body.value.username)
  if (body.value.source !== undefined && body.value.source !== 'bought') {
    refuse(ctx.response, 400, 'bad_seat')
    return
  }
  if (!ctx.v2.accounts.has(username)) {
    refuse(ctx.response, 404, 'not_found')
    return
  }
  const out = ctx.v2.seats.settle({
    team: asked.team,
    account: username,
    by: body.value.by,
    receipt: body.value.receipt,
    ...(body.value.expiresAt === undefined ? {} : { expiresAt: body.value.expiresAt })
  })
  if (!out.ok) {
    refuse(ctx.response, out.reason === 'already_seated' ? 409 : 400, out.reason, username)
    return
  }
  v2Json(ctx.response, 201, { seat: seatFace(out.seat) })
}

/** End a seat. The holder's call tokens stop being minted from this moment. */
function endSeat(ctx: V2Context, asked: Asked, id: string): void {
  if (!ownerOnly(ctx, asked)) return
  const out = ctx.v2.seats.end(asked.team, id)
  if (!out.ok) {
    refuse(ctx.response, 404, 'not_found')
    return
  }
  noContent(ctx.response)
}
