import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * IDENTITY v2 — SEATS.
 *
 * A seat is the smallest fact that answers "may this person open that door":
 * {team, account, where it came from, who gave it, when}. It lives at the
 * registry rather than at the door because it belongs to the PERSON — a seat
 * is yours, not a browser's, and it has to follow you to a phone you signed
 * into an hour ago (P2, and the 2026-09-06 ruling).
 *
 * WHAT A SEAT IS NOT. It is not money and it is not a session. The door still
 * runs its own checkout with its owner's keys and still mints its own session;
 * this file records the RESULT so that the next device, at the next door, does
 * not have to buy it again. Nothing here holds a card number, a wallet or a
 * charge — a receipt is an opaque line the door reported, kept only so an
 * owner can match a seat to their own books.
 *
 * ONE ACTIVE SEAT PER (TEAM, ACCOUNT). Two would mean a person could be
 * charged twice for the same room and revoked once — so a second is refused
 * rather than stacked, and a seat that ended stays on the record with its
 * ending instead of being deleted.
 */

export const SEATS_FILE = 'seats-v2.json'

/** `@handle/team` — the one way a team is written, everywhere. */
const TEAM = /^@[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
/** A door reports a checkout id, not a document: enough to look one up. */
const RECEIPT_MAX = 512
const SEATS_MAX = 20_000

export type SeatSource = 'bought' | 'granted'
/** The two rails a door can settle a purchase on, and report back here. */
export type SeatRail = 'stripe' | 'x402'

export interface V2Seat {
  id: string
  /** `@owner/team`. */
  team: string
  /** The username the seat belongs to. */
  account: string
  source: SeatSource
  /** A username for a granted seat; the rail that settled a bought one. */
  by: string
  createdAt: number
  expiresAt?: number
  endedAt?: number
  /** Opaque, from the door that took the money. Never parsed here. */
  receipt?: string
}

interface Persisted {
  version: 2
  seats: V2Seat[]
}

export type SeatRefusal = 'already_seated' | 'bad_seat' | 'not_found'
export type SeatResult = { ok: true; seat: V2Seat } | { ok: false; reason: SeatRefusal }

/** The address of a team, from the two halves the directory stores. */
export const teamAddress = (handle: string, name: string): string =>
  `@${handle.replace(/^@/, '').toLowerCase()}/${name.toLowerCase()}`

const asTeam = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const team = (value.startsWith('@') ? value : `@${value}`).trim().toLowerCase()
  return TEAM.test(team) ? team : null
}

const asUsername = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const name = value.trim().toLowerCase().replace(/^@/, '')
  return USERNAME.test(name) ? name : null
}

export class V2Seats {
  private readonly file: string
  private readonly now: () => number
  private seats: readonly V2Seat[] = []

  constructor(base: string, now: () => number = Date.now) {
    mkdirSync(base, { recursive: true })
    this.now = now
    this.file = path.join(base, SEATS_FILE)
    if (existsSync(this.file)) this.load()
  }

  /**
   * A TORN FILE STOPS THE PROCESS, for the same reason the account file does:
   * a seat file read as empty says nobody is seated anywhere, which turns
   * every paying guest into a stranger and every grant into a thing the owner
   * has to do again. Nothing is repaired; a human is told where to look.
   */
  private load(): void {
    const complain = (why: string): never => {
      throw new Error(
        `refusing to start: ${this.file} could not be read as a seat file (${why}). ` +
          'Nothing has been changed — restore it from a backup, or move it aside to start with no seats.'
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (error) {
      complain(error instanceof Error ? error.message : 'it is not JSON')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) complain('it is not an object')
    const held = parsed as Partial<Persisted>
    if (!Array.isArray(held.seats)) complain('it has no list of seats')
    for (const seat of held.seats as V2Seat[]) {
      const shaped =
        typeof seat?.id === 'string' &&
        asTeam(seat?.team) !== null &&
        asUsername(seat?.account) !== null &&
        (seat?.source === 'bought' || seat?.source === 'granted') &&
        typeof seat?.createdAt === 'number'
      if (!shaped) complain('a seat in it has no team, no account or no source')
    }
    this.seats = held.seats as V2Seat[]
  }

  /** Temp file then rename: a reader never sees half a write, whatever happens. */
  private save(): void {
    const body: Persisted = { version: 2, seats: [...this.seats] }
    const temp = `${this.file}.${process.pid}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(body), { mode: 0o600 })
      renameSync(temp, this.file)
    } catch (error) {
      try {
        if (existsSync(temp)) unlinkSync(temp)
      } catch {
        // The rename is what matters; a stranded temp file is not worth a throw.
      }
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  // ── reading ────────────────────────────────────────────────────────────

  private live(seat: V2Seat): boolean {
    if (seat.endedAt !== undefined) return false
    return seat.expiresAt === undefined || seat.expiresAt > this.now()
  }

  /** The caller's seat at one team, or null. The question every door asks. */
  activeFor(team: string, account: string): V2Seat | null {
    const at = asTeam(team)
    const who = asUsername(account)
    if (at === null || who === null) return null
    return this.seats.find((seat) => seat.team === at && seat.account === who && this.live(seat)) ?? null
  }

  /** One account's seats, active first, newest first within each half. */
  heldBy(account: string): V2Seat[] {
    const who = asUsername(account)
    if (who === null) return []
    return this.sorted(this.seats.filter((seat) => seat.account === who))
  }

  /** Every seat a team ever had, active first. The owner's own list. */
  forTeam(team: string): V2Seat[] {
    const at = asTeam(team)
    if (at === null) return []
    return this.sorted(this.seats.filter((seat) => seat.team === at))
  }

  /** Who is in the room, by username — what a seated guest is allowed to see. */
  seatedAt(team: string): string[] {
    const room = this.forTeam(team).filter((seat) => this.live(seat))
    return [...new Set(room.map((seat) => seat.account))].sort()
  }

  private sorted(seats: readonly V2Seat[]): V2Seat[] {
    return [...seats].sort(
      (a, b) =>
        Number(this.live(b)) - Number(this.live(a)) ||
        b.createdAt - a.createdAt ||
        a.id.localeCompare(b.id)
    )
  }

  // ── writing ────────────────────────────────────────────────────────────

  /** An owner seats somebody by username. No queue, no request: a fact. */
  grant(input: { team: unknown; account: unknown; by: unknown; expiresAt?: unknown }): SeatResult {
    const by = asUsername(input.by)
    if (by === null) return { ok: false, reason: 'bad_seat' }
    return this.add(input.team, input.account, { source: 'granted', by, expiresAt: input.expiresAt })
  }

  /**
   * A DOOR REPORTS A PURCHASE. The money moved at the owner's app, on the
   * owner's rails; this writes down that it did, so the person who paid is
   * seated on every device they sign in from.
   */
  settle(input: {
    team: unknown
    account: unknown
    by: unknown
    receipt: unknown
    expiresAt?: unknown
  }): SeatResult {
    const rails: readonly SeatRail[] = ['stripe', 'x402']
    if (!rails.includes(input.by as SeatRail)) return { ok: false, reason: 'bad_seat' }
    const receipt = typeof input.receipt === 'string' ? input.receipt.trim() : ''
    if (receipt.length === 0 || receipt.length > RECEIPT_MAX) return { ok: false, reason: 'bad_seat' }
    return this.add(input.team, input.account, {
      source: 'bought',
      by: input.by as SeatRail,
      receipt,
      expiresAt: input.expiresAt
    })
  }

  private add(
    team: unknown,
    account: unknown,
    rest: { source: SeatSource; by: string; receipt?: string; expiresAt?: unknown }
  ): SeatResult {
    const at = asTeam(team)
    const who = asUsername(account)
    if (at === null || who === null) return { ok: false, reason: 'bad_seat' }
    const until = rest.expiresAt
    if (until !== undefined && (typeof until !== 'number' || !Number.isFinite(until))) {
      return { ok: false, reason: 'bad_seat' }
    }
    if (this.activeFor(at, who) !== null) return { ok: false, reason: 'already_seated' }
    const seat: V2Seat = {
      id: randomUUID(),
      team: at,
      account: who,
      source: rest.source,
      by: rest.by,
      createdAt: this.now(),
      ...(until === undefined ? {} : { expiresAt: until as number }),
      ...(rest.receipt === undefined ? {} : { receipt: rest.receipt })
    }
    // Bounded, oldest ENDED seats first: a room's history is worth keeping,
    // but never at the price of a file the registry cannot load.
    this.seats = [...this.seats, seat].slice(-SEATS_MAX)
    this.save()
    return { ok: true, seat }
  }

  /**
   * END A SEAT. The record keeps it with its ending rather than dropping it:
   * an owner asking "who did I revoke" deserves an answer, and the holder's
   * call tokens stop being minted the moment this returns.
   */
  end(team: string, id: string): SeatResult {
    const at = asTeam(team)
    if (at === null) return { ok: false, reason: 'not_found' }
    const found = this.seats.find((seat) => seat.id === id && seat.team === at && this.live(seat))
    if (found === undefined) return { ok: false, reason: 'not_found' }
    const ended: V2Seat = { ...found, endedAt: this.now() }
    this.seats = this.seats.map((seat) => (seat.id === ended.id ? ended : seat))
    this.save()
    return { ok: true, seat: ended }
  }
}
