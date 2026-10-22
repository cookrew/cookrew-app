// Last-known fleet for an instant first paint: the registry rows and each
// machine's last snapshot, in this origin's localStorage. Everything read from
// here is drawn as STALE until that machine's stream is live again. No tokens
// are ever written here — they stay under cr_token:<id>, owned by pairing.
import type { FleetMachine, LevelsSnapshot } from '../../shared/strata'
import { isFleetMachine, isLevelsSnapshot } from './guards'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  /** For clear(); a storage without them clears nothing. */
  readonly length?: number
  key?(index: number): string | null
}

export const CACHE_PREFIX = 'strata:fleet:'
const LIST_KEY = `${CACHE_PREFIX}list`
const levelsKey = (machineId: string) => `${CACHE_PREFIX}levels:${machineId}`
/** A live machine rewrites its entry at most this often; the last write wins on hide. */
export const CACHE_WRITE_MS = 5_000

export interface CachedLevels {
  levels: LevelsSnapshot
  savedAt: number
}

const read = (storage: StorageLike, key: string): unknown => {
  try {
    const raw = storage.getItem(key)
    return raw === null ? null : JSON.parse(raw)
  } catch {
    return null
  }
}

/** Storage can be full or refused; a cache that fails to write is just a colder next paint. */
const write = (storage: StorageLike, key: string, value: unknown): boolean => {
  try {
    storage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export interface FleetCache {
  list(): FleetMachine[] | null
  saveList(rows: FleetMachine[]): void
  levels(machineId: string): CachedLevels | null
  /** Throttled per machine unless `force`. */
  saveLevels(machineId: string, levels: LevelsSnapshot, force?: boolean): void
  forget(machineId: string): void
  clear(): void
}

export const createFleetCache = (storage: StorageLike | null, now: () => number): FleetCache => {
  const lastWrite = new Map<string, number>()
  if (!storage) {
    return { list: () => null, saveList: () => {}, levels: () => null, saveLevels: () => {}, forget: () => {}, clear: () => {} }
  }
  return {
    list: () => {
      const rows = read(storage, LIST_KEY)
      return Array.isArray(rows) && rows.every(isFleetMachine) ? (rows as FleetMachine[]) : null
    },
    saveList: (rows) => {
      write(storage, LIST_KEY, rows)
    },
    levels: (machineId) => {
      const entry = read(storage, levelsKey(machineId))
      if (typeof entry !== 'object' || entry === null) return null
      const { levels, savedAt } = entry as Partial<CachedLevels>
      return isLevelsSnapshot(levels) && typeof savedAt === 'number' ? { levels, savedAt } : null
    },
    saveLevels: (machineId, levels, force = false) => {
      const at = now()
      const last = lastWrite.get(machineId)
      if (!force && last !== undefined && at - last < CACHE_WRITE_MS) return
      if (write(storage, levelsKey(machineId), { levels, savedAt: at })) lastWrite.set(machineId, at)
    },
    forget: (machineId) => {
      lastWrite.delete(machineId)
      try {
        storage.removeItem(levelsKey(machineId))
      } catch {
        // nothing to forget
      }
    },
    clear: () => {
      lastWrite.clear()
      try {
        const keys = Array.from({ length: storage.length ?? 0 }, (_, i) => storage.key?.(i) ?? null)
        for (const key of keys) if (key?.startsWith(CACHE_PREFIX)) storage.removeItem(key)
      } catch {
        // a refused storage holds nothing of ours
      }
    }
  }
}
