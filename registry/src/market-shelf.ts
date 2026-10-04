import type { ListedDoor } from './site'
import { standingOf, type Standing } from './site-standing'
import type { V2Seat } from './v2-seats'
import { teamAddress } from './v2-seats'

/**
 * THE MARKET, AS ONE ACCOUNT SEES IT.
 *
 * A shop has one question per item: can I use this, and if not, what does it
 * take. The answer here is decided by the USERNAME the reader signed in with
 * and nothing else — the same name a seat is bought under, the same name the
 * app signs in with, the same name a star is recorded under. There is no
 * second credential to enrol and no handle to type: a person who is signed
 * in is already everything the market needs to know.
 *
 * Every card gets ONE standing (site-standing.ts, the same rule the team page
 * renders from) and that standing decides the one primary button:
 *
 *   owner     YOURS — you serve it            → Open
 *   seated    SEATED — bought or granted      → Open
 *   admitted  FREE — signing in is the gate   → Open
 *   unseated  the price, a seat, once         → Buy a seat
 *   stranger  the price or FREE               → Sign in
 *
 * The things a reader already holds go on a SHELF above the catalogue, so
 * the first screen of the market is what is theirs, then what is for sale.
 * Pure, so every state can be checked without a server.
 */

export type { Standing }

export interface CardFace {
  /** The chip in the card's head: what this team is to the reader. */
  chip: { label: string; tone: 'amber' | 'violet' | 'hp' | 'plain' }
  /** The one primary action. `signin` opens the account sheet; `href` goes somewhere. */
  primary: { label: string; href?: string; signin?: true }
  /** One sentence under the buttons, when the standing has something to say. */
  note?: string
}

export interface Shelf {
  /** What the reader already holds: the teams they serve, then their seats, newest first. */
  yours: readonly ListedDoor[]
  /** Every other listing, in the order it was given. */
  rest: readonly ListedDoor[]
  /** The reader's standing at every door given. */
  standing: ReadonlyMap<string, Standing>
}

const key = (door: ListedDoor): string => `${door.handle}/${door.name}`

/** The reader's active seat at a door, out of the seats they hold. */
export function seatAt(door: ListedDoor, seats: readonly V2Seat[], now: number = Date.now()): V2Seat | null {
  const team = teamAddress(door.handle, door.name)
  return (
    seats.find(
      (seat) => seat.team === team && seat.endedAt === undefined && (seat.expiresAt === undefined || seat.expiresAt > now)
    ) ?? null
  )
}

/** What the reader is at this door. */
export function standingAt(door: ListedDoor, account: string | null, seats: readonly V2Seat[], now?: number): Standing {
  return standingOf({ account, seat: account === null ? null : seatAt(door, seats, now) }, door)
}

/** Day-month-year, the site's one date format, without importing the shell. */
const day = (at: number): string => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

/** The one chip and the one button a card wears for this reader. */
export function cardFace(standing: Standing, door: ListedDoor, seat: V2Seat | null = null): CardFace {
  const at = `/${door.handle}/${door.name}`
  const priced = door.access === 'paid' && door.priceUsd !== undefined && door.priceUsd !== ''
  const price = door.priceUsd ?? ''
  switch (standing.kind) {
    case 'owner':
      return {
        chip: { label: 'Yours · you serve it', tone: 'hp' },
        primary: { label: 'Open', href: at },
        note: 'No seat and no charge at your own door.'
      }
    case 'seated': {
      const how = seat === null ? 'seated' : seat.source === 'bought' ? 'bought' : `granted by @${seat.by}`
      return {
        chip: { label: `Seated · ${how}`, tone: 'amber' },
        primary: { label: 'Open', href: at },
        note: `Your seat since ${day(standing.since)} — it follows you to any device.`
      }
    }
    case 'admitted':
      return {
        chip: { label: 'Free · yours to open', tone: 'plain' },
        primary: { label: 'Open', href: at }
      }
    case 'unseated':
      return {
        chip: { label: `${price} USD · a seat, once`, tone: 'violet' },
        primary: { label: `Buy a seat · $${price}`, href: `${at}?buy=1` },
        note: `Or ask @${door.handle} for one on the team's page.`
      }
    case 'stranger':
      return {
        chip: priced ? { label: `${price} USD · a seat, once`, tone: 'violet' } : { label: 'Free · account needed', tone: 'plain' },
        primary: { label: priced ? `Sign in to buy · $${price}` : 'Sign in to open', signin: true }
      }
  }
}

/**
 * The shelf and the catalogue. The shelf is empty for a stranger and for a
 * reader who holds nothing yet; then the catalogue is the whole market.
 */
export function shelfOf(doors: readonly ListedDoor[], account: string | null, seats: readonly V2Seat[], now?: number): Shelf {
  const standing = new Map<string, Standing>()
  for (const door of doors) standing.set(key(door), standingAt(door, account, seats, now))
  const owned = doors.filter((d) => standing.get(key(d))?.kind === 'owner')
  const seated = doors
    .filter((d) => standing.get(key(d))?.kind === 'seated')
    .sort((a, b) => (seatAt(b, seats, now)?.createdAt ?? 0) - (seatAt(a, seats, now)?.createdAt ?? 0))
  const yours = [...owned, ...seated]
  const held = new Set(yours.map(key))
  return { yours, rest: doors.filter((d) => !held.has(key(d))), standing }
}

/** "@lin · 2 seats · 1 team served · 3 starred" — the reader, in one line. */
export function readerLine(account: string, shelf: Shelf, starred: number): string {
  const served = shelf.yours.filter((d) => shelf.standing.get(key(d))?.kind === 'owner').length
  const seats = shelf.yours.length - served
  const parts = [`@${account}`]
  parts.push(`${seats} seat${seats === 1 ? '' : 's'}`)
  if (served > 0) parts.push(`${served} team${served === 1 ? '' : 's'} served`)
  parts.push(`${starred} starred`)
  return parts.join(' · ')
}
