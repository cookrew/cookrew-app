import type { TeamMeta } from '../../shared/model'
import type { HeldSeatRow, SeatsSurface } from '../../shared/seats'

/**
 * THE TWO SHELVES OF THE IMPORT SHEET — what a person can place without an
 * address in hand.
 *
 *   yours   teams saved on this machine (~/.cookrew/teams). Private: nothing
 *           about them has left the disk unless the owner pressed SERVE.
 *           Placing one is the dock's own move — a session workspace from the
 *           template — so the sheet and the dock cannot disagree about what
 *           a saved team becomes.
 *   held    seats this account holds at other people's doors, bought or
 *           granted. Placing one is the address flow with the address already
 *           known: the seat's `@owner/team` name IS an address the lookup
 *           accepts, and the gate's seat rung admits the holder without
 *           asking for money a second time.
 *
 * Pure, so the sentences and the availability rule are testable without a
 * bridge. The sheet only draws what comes back.
 */

export interface Shelves {
  yours: readonly TeamMeta[]
  held: readonly HeldSeatRow[]
}

export function shelvesOf(teams: readonly TeamMeta[] | null, seats: SeatsSurface | null): Shelves {
  const yours = [...(teams ?? [])].sort((a, b) => b.savedAt - a.savedAt)
  const held = [...(seats?.held ?? [])].sort((a, b) => b.seat.createdAt - a.seat.createdAt)
  return { yours, held }
}

/** One line under a saved team's name: what it holds, and that it is private. */
export function yoursLine(team: TeamMeta): string {
  const agents = `${team.terminalCount} agent${team.terminalCount === 1 ? '' : 's'}`
  const cards = `${team.nodeCount} card${team.nodeCount === 1 ? '' : 's'}`
  return `${agents} · ${cards} · saved here, only you see it`
}

/**
 * A seat that can still be sat in. A seat the owner ended, or one past its
 * expiry, is listed — the person paid for it and deserves to see what
 * happened — but cannot be placed, and the row says which.
 */
export function heldState(row: HeldSeatRow, now: number = Date.now()): 'open' | 'ended' | 'expired' {
  if (row.seat.endedAt !== undefined) return 'ended'
  if (row.seat.expiresAt !== undefined && row.seat.expiresAt <= now) return 'expired'
  return 'open'
}

/** One line under a held seat: how it was obtained, and its state when not open. */
export function heldLine(row: HeldSeatRow, now: number = Date.now()): string {
  const how = row.seat.source === 'bought' ? 'bought' : `granted${row.seat.by ? ` by @${row.seat.by}` : ''}`
  const state = heldState(row, now)
  return state === 'open' ? how : `${how} · ${state === 'ended' ? 'ended by the owner' : 'expired'}`
}
