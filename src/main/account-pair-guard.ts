import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './atomic-file'
import {
  ACCOUNT_PAIR_REST_MS,
  ACCOUNT_PAIR_STOP_AFTER,
  ACCOUNT_PAIR_STOP_MS,
  ACCOUNT_PAIR_TRIES
} from '../shared/account-pair'

/**
 * HOW MANY WRONG SECRETS, AND HOW LONG TO WAIT — the remote unlock's numbers.
 *
 * Per device: three wrong, then a minute. Per door: nine wrong in a row across
 * every device, then fifteen minutes, and the count starts over — it never
 * closes for good, because a headless machine has nobody to reopen it. The door
 * count survives a restart (a file), so restarting is not a way to be forgiven.
 *
 * Counted only for a secret that was CHECKED and was wrong. The door runs one
 * check at a time (account-pair.ts), so every check reads counts that already
 * include every check before it — parallel requests cannot all pass the rest
 * test before any of them is counted.
 */

export interface PairMisses {
  read(): { count: number; until: number }
  write(next: { count: number; until: number }): void
}

export type MissOutcome =
  | { readonly kind: 'wrong'; readonly triesLeft: number }
  | { readonly kind: 'resting'; readonly forMs: number }

export interface PairGuard {
  /** How long this device (or the whole door) must still wait, or 0. */
  restFor(deviceId: string, now: number): number
  missed(deviceId: string, now: number): MissOutcome
  cleared(deviceId: string): void
  /** Wrong secrets in a row across the door, for the log line. */
  inARow(): number
}

const readSafely = (misses: PairMisses | undefined): { count: number; until: number } => {
  try {
    const got = misses?.read() ?? { count: 0, until: 0 }
    return {
      count: Number.isInteger(got.count) && got.count > 0 ? got.count : 0,
      until: Number.isFinite(got.until) && got.until > 0 ? got.until : 0
    }
  } catch {
    return { count: 0, until: 0 }
  }
}

export function createPairGuard(misses?: PairMisses): PairGuard {
  const devices = new Map<string, { wrong: number; until: number }>()
  let door = readSafely(misses)
  let streak = door.count
  const keep = (): void => {
    try {
      misses?.write(door)
    } catch {
      // Held in memory for this run.
    }
  }
  return {
    restFor: (deviceId, now) => Math.max(0, (devices.get(deviceId)?.until ?? 0) - now, door.until - now),
    missed: (deviceId, now) => {
      const mine = devices.get(deviceId) ?? { wrong: 0, until: 0 }
      const wrong = mine.wrong + 1
      const restNow = wrong >= ACCOUNT_PAIR_TRIES
      devices.set(deviceId, restNow ? { wrong: 0, until: now + ACCOUNT_PAIR_REST_MS } : { wrong, until: 0 })
      streak += 1
      const count = door.count + 1
      // The stop resets the count as it starts: nine more are needed for the next one.
      door = count >= ACCOUNT_PAIR_STOP_AFTER ? { count: 0, until: now + ACCOUNT_PAIR_STOP_MS } : { count, until: door.until }
      keep()
      if (door.until > now) return { kind: 'resting', forMs: door.until - now }
      if (restNow) return { kind: 'resting', forMs: ACCOUNT_PAIR_REST_MS }
      return { kind: 'wrong', triesLeft: ACCOUNT_PAIR_TRIES - wrong }
    },
    cleared: (deviceId) => {
      devices.delete(deviceId)
      streak = 0
      door = { count: 0, until: door.until }
      keep()
    },
    inARow: () => streak
  }
}

/** The running count of wrong secrets, kept across restarts. A plain 0600 file. */
export function pairMissesFile(file: string): PairMisses {
  return {
    read: () => {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { count?: unknown; until?: unknown } | null
      return { count: Number(raw?.count ?? 0), until: Number(raw?.until ?? 0) }
    },
    write: (next) => {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      writeFileAtomic(file, JSON.stringify(next))
      chmodSync(file, 0o600)
    }
  }
}
