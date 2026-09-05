import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { safeSegment } from './session-sandbox'

/**
 * SEATS — a caller's place at a door, across a restart.
 *
 * The instantiator's ordinal ledger and open-session table lived only in
 * memory, and the loss was not tidiness. Two things went wrong when the owner's
 * app restarted:
 *
 *   A RETURNING CALLER LOST THEIR WORK. `@mira`'s open session was forgotten,
 *   so her next call minted a NEW one — a new workspace, a new sandbox, an
 *   empty transcript — while the old workspace sat on the owner's canvas with
 *   nobody attached to it. At a paid door that is a second charge.
 *
 *   AN ORDINAL CAME BACK FROM THE DEAD. `nextOrdinal` counts from what has ever
 *   been minted; with the ledger gone it counted from nothing and handed out
 *   `1` again. END deletes a sandbox, so a re-minted `-1` is a session minted
 *   onto a path that was just removed, or one whose removal is still in flight.
 *
 * KEYED BY (serviceId, account). The account, not a credential — that is the
 * same rule session-identity.ts states, and the reason the file survives a key
 * rotation or a second device. The identity strings themselves are recomputed
 * with `sessionIdentity`, never stored, so a seat read back is byte-identical
 * to the one that was written and nothing here can rename an existing session.
 *
 * ONE FILE PER SERVICE, beside that service's sessions. A single global file
 * would make every door's restart a rewrite of every other door's seats.
 */

export interface PersistedSeatSession {
  sessionId: string
  workspaceId: string
  ordinal: number
  version: number
  pinAddress: string
}

export interface Seat {
  accountId: string
  /** EVERY ordinal ever minted for this account here, open or closed. */
  ordinals: readonly number[]
  /** The sessions that were open when this was last written. */
  open: readonly PersistedSeatSession[]
}

export interface SeatStore {
  read(serviceId: string): readonly Seat[]
  write(serviceId: string, seats: readonly Seat[]): void
}

interface SeatFile {
  version: 1
  seats: Seat[]
}

/** `~/.cookrew/sessions/<serviceId>/seats.json`. */
export function seatsFile(serviceId: string, baseDir?: string): string {
  const root = baseDir ?? path.join(homedir(), '.cookrew')
  return path.join(root, 'sessions', safeSegment(serviceId), 'seats.json')
}

/**
 * The seats on disk.
 *
 * A WRITE THAT FAILS IS LOGGED, NOT THROWN. This is called from the mint path;
 * an unwritable home directory must not turn a caller's first question into a
 * 503. The cost of the failure is exactly the behaviour we had before the file
 * existed, and it is bounded to this run.
 *
 * A READ THAT FAILS IS AN EMPTY LIST — but the file is left alone. Overwriting
 * an unreadable seats file would destroy the only record of which ordinals are
 * spent, which is the hazard this module exists to prevent.
 */
export function createSeatStore(baseDir?: string): SeatStore {
  return {
    read(serviceId) {
      const file = seatsFile(serviceId, baseDir)
      if (!existsSync(file)) return []
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SeatFile>
        if (!Array.isArray(parsed.seats)) return []
        return parsed.seats.filter(isSeat)
      } catch (error) {
        console.error(`seats: ${file} is unreadable, starting this run empty:`, error)
        return []
      }
    },
    write(serviceId, seats) {
      const file = seatsFile(serviceId, baseDir)
      const body: SeatFile = { version: 1, seats: [...seats] }
      try {
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
        // Whole or not at all: a seat file torn by a crash mid-write would
        // read as "no seats" and hand every returning caller a fresh session.
        const tmp = `${file}.tmp`
        writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 })
        chmodSync(tmp, 0o600)
        renameSync(tmp, file)
      } catch (error) {
        console.error(`seats: could not persist ${file}:`, error)
      }
    }
  }
}

/** A store that forgets — the default when no home directory is in play. */
export function memorySeatStore(): SeatStore {
  const byService = new Map<string, readonly Seat[]>()
  return {
    read: (serviceId) => byService.get(serviceId) ?? [],
    write: (serviceId, seats) => {
      byService.set(serviceId, [...seats])
    }
  }
}

function isSeat(value: unknown): value is Seat {
  if (typeof value !== 'object' || value === null) return false
  const seat = value as Partial<Seat>
  if (typeof seat.accountId !== 'string' || seat.accountId.length === 0) return false
  if (!Array.isArray(seat.ordinals) || !seat.ordinals.every((n) => Number.isInteger(n))) {
    return false
  }
  return Array.isArray(seat.open) && seat.open.every(isPersistedSession)
}

function isPersistedSession(value: unknown): value is PersistedSeatSession {
  if (typeof value !== 'object' || value === null) return false
  const session = value as Partial<PersistedSeatSession>
  return (
    typeof session.sessionId === 'string' &&
    typeof session.workspaceId === 'string' &&
    Number.isInteger(session.ordinal) &&
    typeof session.version === 'number' &&
    typeof session.pinAddress === 'string'
  )
}
