/**
 * IDENTITY v2 — SEATS, as both halves of the app read them.
 *
 * A seat is a FACT AT cookrew.dev: this person may open that team's door.
 * The registry owns it (registry/src/v2-seats.ts); the door and the owner's
 * surface only ever quote it. So this file is types and SENTENCES — no
 * behaviour — and it is shared so the words a caller is refused with and the
 * words the owner reads in Seats & Teams cannot drift into two versions.
 *
 * THE GATE ORDER, stated once: 401 sign in → 403 no seat → 402 buy → open.
 * The 403 is the one that needed a voice, because "no seat" is the only rung
 * a person can do something about without leaving the page.
 */

import type { AccountRefusal } from './account-v2'

/** How somebody came by a seat. `bought` settled money; `granted` did not. */
export type SeatSource = 'bought' | 'granted'

/** One seat, exactly as `seatFace` in registry/src/v2-seat-routes.ts writes it. */
export interface SeatFace {
  id: string
  /** `@owner/team` — the door this seat is for. */
  team: string
  /** The username holding it, with no `@`. */
  account: string
  source: SeatSource
  /** Who did it: the owner's handle for a grant, the rail for a purchase. */
  by?: string
  createdAt: number
  expiresAt?: number
  endedAt?: number
}

/** A team this desktop is serving, with the seats cookrew.dev holds for it. */
export interface ServingSeatsRow {
  serviceId: string
  slug: string
  /** The published `@owner/team`, or null when this door is not on the relay. */
  team: string | null
  /** The team's display name — the saved team's own name. */
  title: string
  access: 'account' | 'paid'
  priceUsd?: string
  /** Live seats at the registry. Empty when the team has no published name. */
  seats: readonly SeatFace[]
  /**
   * Why the seats could not be read, in the registry's own vocabulary. The
   * ROW STILL SHOWS: a team that is serving is a fact this desktop knows on
   * its own, and hiding it because cookrew.dev is down would tell the owner
   * they stopped serving. The renderer turns the reason into the sentence.
   */
  error?: AccountRefusal
}

/** A seat this account holds at somebody ELSE's door. */
export interface HeldSeatRow {
  seat: SeatFace
  /** Where OPEN goes: the team's page at cookrew.dev. */
  url: string
}

/** Everything the SEATS & TEAMS tab draws, in one answer. */
export interface SeatsSurface {
  /** Teams THIS desktop is serving, with their seats. */
  serving: readonly ServingSeatsRow[]
  /** Seats this account holds at OTHER people's doors. */
  held: readonly HeldSeatRow[]
}

/** One person the door has admitted right now — D7's avatars. */
export interface SeatedCaller {
  /** The username, no `@`. This is the person, not the device (P2). */
  username: string
  /** The door-side account id the session is filed under (`acct-<username>`). */
  accountId: string
  /** desktop / phone / browser, as far as the door was told. */
  deviceKind: string
  /** How they got in, when a seat admitted them. */
  source: SeatSource | null
  /** Epoch ms this session opened. */
  since: number
  sessionId: string
  /** The door's own card for this session — never shown a caller. */
  conductorId: string | null
}

/** The callers at one served door, addressed to the card that IS that door. */
export interface ServedCallersRow {
  serviceId: string
  slug: string
  /** The orch's NAME in the saved team — the card head these avatars ride on. */
  orchName: string | null
  callers: readonly SeatedCaller[]
}

/** How many avatars fit before the row becomes "+N". */
export const CALLER_AVATAR_LIMIT = 3

/**
 * THE 403, in the owner's voice.
 *
 * Word for word from the UI/UX note's copy table, and it names BOTH people:
 * the person refused (so they know which account they are signed in as, which
 * is the usual cause) and the person who can say yes.
 */
export function noSeatSentence(username: string, owner: string): string {
  return `You are @${username}. No seat here yet. Buy one, or ask @${owner}.`
}

/** The seat row's own line, for the tab and for a hover. */
export function seatSentence(seat: SeatFace): string {
  const when = new Date(seat.createdAt).toLocaleDateString()
  return seat.source === 'bought'
    ? `bought a seat ${when}`
    : `granted by @${seat.by ?? 'the owner'} ${when}`
}

/** D7's hover: who, on what, and how they got in. */
export function callerSentence(caller: SeatedCaller): string {
  const how =
    caller.source === 'bought'
      ? 'bought a seat'
      : caller.source === 'granted'
        ? 'granted by you'
        : 'signed in'
  return `@${caller.username} · ${caller.deviceKind} · ${how}`
}

/** Clicking an avatar offers this, and it says what END actually destroys. */
export function endSessionSentence(caller: SeatedCaller): string {
  return `End @${caller.username}'s session? Their crew and its sandbox go with it. The seat stays.`
}

/** The SERVING row's summary line: "paid $1 · 3 seats taken". */
export function servingSummary(row: ServingSeatsRow): string {
  const price = row.access === 'paid' ? `paid $${row.priceUsd ?? '0'}` : 'free'
  const taken = row.seats.length
  return `${price} · ${taken} ${taken === 1 ? 'seat' : 'seats'} taken`
}

/** Where a held seat's OPEN goes. `team` is `@owner/name`. */
export function teamPageUrl(origin: string, team: string): string {
  return `${origin.replace(/\/$/, '')}/${team}`
}
