import type { AccountResult } from '../shared/account-v2'
import type { Accounts } from './account-v2'
import {
  teamPageUrl,
  type HeldSeatRow,
  type SeatFace,
  type SeatSource,
  type SeatedCaller,
  type SeatsSurface,
  type ServingSeatsRow
} from '../shared/seats'
import type { V2Seated } from './served-endpoints'

/**
 * SEATS, FROM THE DOOR'S SIDE — the owner's half of the registry contract.
 *
 * Everything here is spoken with the OWNER'S session token, because every
 * route it touches is owner-only at cookrew.dev (registry/src/v2-seat-routes:
 * listSeats, grantSeat, settleSeat, endSeat) — except `/v2/me/seats`, which is
 * this account's own seats at OTHER people's doors and is what the SEAT rows
 * in Seats & Teams are made of.
 *
 * WHY A CLIENT AND NOT FETCHES AT THE CALL SITES. There are five routes and
 * four surfaces that want them (the tab, the IPC, the settle queue, the caller
 * avatars). Five inlined fetches is five places to forget the session check,
 * five spellings of the team address, and five different answers to "what does
 * a registry that is down look like". This is one seam over `Accounts.authed`,
 * so a dead session is `session-expired` everywhere and a dead registry is
 * `offline` everywhere.
 *
 * NO MONEY CROSSES THIS FILE. `settle` REPORTS a purchase the door already
 * took at its own checkout; the registry records who paid and never handles a
 * cent (the seat routes' own note says the same thing from the other side).
 */

/** The narrow HTTP seam. Injected so a test needs neither a socket nor a home. */
export interface SeatsApi {
  get<T>(pathname: string): Promise<AccountResult<T>>
  post<T>(pathname: string, body: unknown): Promise<AccountResult<T>>
  del(pathname: string): Promise<AccountResult<void>>
}

/** The seam over the owner's account. The session token stays inside Accounts. */
export function seatsApiOverAccounts(accounts: Accounts): SeatsApi {
  return {
    get: (pathname) => accounts.authed(pathname),
    post: (pathname, body) =>
      accounts.authed(pathname, { method: 'POST', body: JSON.stringify(body) }),
    del: (pathname) => accounts.authed(pathname, { method: 'DELETE', parse: false })
  }
}

/**
 * `@owner/team` → the path under /v2/teams, encoded a segment at a time.
 *
 * The `@` is kept (the registry strips it itself) and the two halves are
 * encoded separately: a team name is owner-typed, and a slash smuggled into
 * one would otherwise address a different route entirely.
 */
export function teamPath(team: string): string {
  const [handle = '', name = ''] = team.replace(/^@/, '').split('/')
  return `/v2/teams/${encodeURIComponent(`@${handle}`)}/${encodeURIComponent(name)}`
}

export class DoorSeats {
  private readonly api: SeatsApi

  constructor(api: SeatsApi) {
    this.api = api
  }

  /** Every seat at one of the owner's teams — the SERVING row's count. */
  async forTeam(team: string): Promise<AccountResult<readonly SeatFace[]>> {
    const result = await this.api.get<{ seats?: readonly SeatFace[] }>(`${teamPath(team)}/seats`)
    if (!result.ok) return result
    return { ok: true, value: result.value.seats ?? [] }
  }

  /** Every seat this account holds ANYWHERE — the SEAT rows. */
  async mine(): Promise<AccountResult<readonly SeatFace[]>> {
    const result = await this.api.get<{ seats?: readonly SeatFace[] }>('/v2/me/seats')
    if (!result.ok) return result
    return { ok: true, value: result.value.seats ?? [] }
  }

  /**
   * GRANT A SEAT, by username. The registry refuses a name nobody has claimed
   * (404) rather than parking an entitlement on whoever registers it next, so
   * a typo is a refusal here and not a seat somebody else inherits.
   */
  async grant(team: string, username: string): Promise<AccountResult<SeatFace>> {
    const result = await this.api.post<{ seat?: SeatFace }>(`${teamPath(team)}/seats`, {
      username: username.trim().toLowerCase().replace(/^@/, '')
    })
    if (!result.ok) return result
    return result.value.seat
      ? { ok: true, value: result.value.seat }
      : { ok: false, reason: 'unknown' }
  }

  /** END a seat. Call tokens stop being minted from it at once. */
  end(team: string, id: string): Promise<AccountResult<void>> {
    return this.api.del(`${teamPath(team)}/seats/${encodeURIComponent(id)}`)
  }

  /**
   * REPORT A PURCHASE. `source` is always 'bought' — the registry refuses any
   * other value on this route, because a granted seat has its own verb and
   * letting one route write both would let a settle forge a grant.
   */
  async settle(
    team: string,
    input: { username: string; by: 'stripe' | 'x402'; receipt: string }
  ): Promise<AccountResult<SeatFace>> {
    const result = await this.api.post<{ seat?: SeatFace }>(`${teamPath(team)}/seats/settle`, {
      username: input.username,
      source: 'bought',
      by: input.by,
      receipt: input.receipt
    })
    if (!result.ok) return result
    return result.value.seat
      ? { ok: true, value: result.value.seat }
      : { ok: false, reason: 'unknown' }
  }
}

/**
 * WHO IS AT THE DOOR RIGHT NOW — the memory behind D7's avatars.
 *
 * A v2 sign-in is the only moment the door ever learns a caller's USERNAME:
 * after it, every route works from `acct-<username>`, which is a path segment
 * and not a person. So the sign-in is recorded here, keyed by the sub the
 * session is filed under, and the avatars are the intersection of this and the
 * instantiator's live sessions — a name we remember for somebody who is not
 * connected is not a caller, and a session with no name we remember is a
 * key-based caller who has no username to show.
 *
 * IN MEMORY, deliberately. The record is about a LIVE session; a restart ends
 * every session, so a record that outlived one would only ever be wrong.
 */
export class DoorCallers {
  /** serviceId → sub → what the token said, and when it first said it. */
  private readonly byService = new Map<string, Map<string, V2Seated & { at: number }>>()
  private readonly clock: () => number

  constructor(now: () => number = Date.now) {
    this.clock = now
  }

  seated(entry: V2Seated): void {
    const service = this.byService.get(entry.serviceId) ?? new Map<string, V2Seated & { at: number }>()
    // The CLAIMS are replaced — the newest token is the current truth about
    // which device is here and which seat admitted them — but the ARRIVAL TIME
    // is kept. A caller whose ten-minute token was refreshed has not just
    // arrived, and re-stamping them would reshuffle the avatar row under the
    // owner every few minutes for no reason a person could see.
    const first = service.get(entry.sub)?.at
    service.set(entry.sub, { ...entry, at: first ?? this.clock() })
    this.byService.set(entry.serviceId, service)
  }

  /** What we know about one caller at one service, or null. */
  get(serviceId: string, sub: string): V2Seated | null {
    return this.byService.get(serviceId)?.get(sub) ?? null
  }

  /** When this caller first signed in here, or null. */
  since(serviceId: string, sub: string): number | null {
    return this.byService.get(serviceId)?.get(sub)?.at ?? null
  }

  forget(serviceId: string, sub: string): void {
    this.byService.get(serviceId)?.delete(sub)
  }
}

/** One live session at a served door, as the instantiator reports it. */
export interface LiveCallerSession {
  serviceId: string
  sessionId: string
  /** The instantiator's accountId — `acct-<username>` for a v2 caller. */
  caller: string
  conductorId: string | null
  openedAt: number
}

/**
 * The avatars for one service: live sessions, named by what the sign-in said,
 * with the seat's SOURCE resolved against the team's real seat list.
 *
 * Pure, so the whole of D7's data is one testable function. A session whose
 * caller never signed in with a v2 token is left out entirely — a key-based
 * caller has no username, and drawing 'acct-…' or a raw key digest on the
 * owner's canvas would be a face with the wrong name on it.
 */
export function seatedCallersFor(
  serviceId: string,
  sessions: readonly LiveCallerSession[],
  callers: DoorCallers,
  seats: readonly SeatFace[] = []
): readonly SeatedCaller[] {
  const sourceOf = (seat: string | null): SeatSource | null =>
    seat === null ? null : (seats.find((s) => s.id === seat)?.source ?? null)
  return sessions
    .filter((session) => session.serviceId === serviceId)
    .flatMap((session) => {
      const known = callers.get(serviceId, session.caller)
      if (known === null) return []
      const caller: SeatedCaller = {
        username: known.username,
        accountId: session.caller,
        // THE DEVICE KIND IS NOT IN THE TOKEN. `dev` is an opaque device id and
        // the registry does not hand a door the device directory, so the hover
        // says 'device' until the reach cards of phase 3 make a kind knowable
        // here. A guessed kind would be a fact on the canvas that is not one.
        deviceKind: 'device',
        source: sourceOf(known.seat),
        since: session.openedAt,
        sessionId: session.sessionId,
        conductorId: session.conductorId
      }
      return [caller]
    })
    .sort((a, b) => a.since - b.since || a.username.localeCompare(b.username))
}

/** A team this desktop is serving, as the Seats tab needs to name it. */
export interface ServedTeamRef {
  serviceId: string
  slug: string
  /** The published `@owner/team`, or null when this door is not on the relay. */
  team: string | null
  /** The saved team's own name. */
  title: string
  access: 'account' | 'paid'
  priceUsd?: string
}

export interface SeatsSurfaceDeps {
  /** Null on a desktop with no account: there is nothing to ask cookrew.dev. */
  seats: DoorSeats | null
  serving: () => readonly ServedTeamRef[]
  /** Where a held seat's OPEN goes. */
  origin: string
}

/**
 * THE TAB'S WHOLE VIEW — SERVING rows from this desktop, SEAT rows from
 * cookrew.dev, in one round trip per team plus one for /v2/me/seats.
 *
 * A TEAM THAT IS SERVING IS SHOWN WHATEVER THE REGISTRY SAYS. Its seats may
 * fail to load — the account may be gone, the session expired, cookrew.dev
 * down — and the row carries the reason instead of vanishing. The alternative
 * reads to the owner as "you stopped serving", which is the one thing this
 * surface must never imply while a door is still answering.
 *
 * A team with no published name has no seats by construction (a seat names a
 * door, and an unpublished door has no name), so it is not asked about.
 */
export async function seatsSurface(deps: SeatsSurfaceDeps): Promise<SeatsSurface> {
  const teams = deps.serving()
  const serving = await Promise.all(
    teams.map(async (team): Promise<ServingSeatsRow> => {
      const row: ServingSeatsRow = { ...team, seats: [] }
      if (deps.seats === null || team.team === null) return row
      const result = await deps.seats.forTeam(team.team)
      return result.ok ? { ...row, seats: result.value } : { ...row, error: result.reason }
    })
  )
  const mine = deps.seats === null ? null : await deps.seats.mine()
  const held: readonly HeldSeatRow[] =
    mine === null || !mine.ok
      ? []
      : mine.value
          // A seat the owner ENDED is history, not a row with an OPEN button.
          .filter((seat) => seat.endedAt === undefined)
          .map((seat) => ({ seat, url: teamPageUrl(deps.origin, seat.team) }))
  return { serving, held }
}

/** The team a served slug publishes as, or null. Used by every seat IPC. */
export function teamForSlug(
  serving: readonly ServedTeamRef[],
  slug: string
): string | null {
  return serving.find((team) => team.slug === slug)?.team ?? null
}
