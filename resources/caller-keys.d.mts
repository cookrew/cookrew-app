/** The keys a device holds for one door: one sign-in walk for the app and the card (caller-keys.mjs). */

export const PENDING_PER_ORIGIN: number
export const RETIRED_PER_ORIGIN: number
export const MAX_PENDING_FILES: number
export const LOCK_STALE_MS: number
export const WALK_DEADLINE_MS: number
export const LOCK_WAIT_MS: number

/** The short, stable tag a door's origin is known by in pending names. */
export function originTag(origin: string): string
/** `<home>.pending-<tag>-<12 hex>`, exactly, for this home and no other. */
export function pendingPattern(home: string): RegExp
/** A fresh pending name for this home, tagged with the door's origin. */
export function newPendingName(home: string, origin: string): string
/** The pending keys of this home, oldest name first. */
export function pendingKeys(home: string): string[]
/** The retired keys of this home (never deleted; still offered, last). */
export function retiredKeys(home: string): string[]
/** Make a rename, link or unlink in `dir` durable where the OS allows. */
export function fsyncDir(dir: string): void

export interface LockOptions {
  waitMs?: number
  staleMs?: number
  pollMs?: number
  now?: () => number
  /** The whole walk's time; it gives up after this. */
  deadlineMs?: number
  /** Called after a lock is judged stale, before it is taken over (for tests). */
  onStale?: () => void
}
/** Run `run` holding `<home>.lock` (O_EXCL; taken over, checked, when its holder is dead or it is stale). */
export function withHomeLock<T>(home: string, run: () => Promise<T>, options?: LockOptions): Promise<T>

/** Each side's own I/O; which key is tried, kept, made or set aside is the walk's. */
export interface SignInDeps<K = unknown, R = unknown> {
  /** Where this door's key is filed. */
  home: string
  /** The door's origin (its URL origin; a relayed door, its name): the quota it is counted under. */
  origin: string
  /** Keys filed under an older scheme, tried after the home key. */
  others?: string[]
  /** A key and what is saved for it; null when absent or unusable. Rejects for a file not proven private. */
  readKey(file: string): Promise<{ key: K; raw: R } | null>
  /** A fresh challenge from the door; rejects when it hands out none. */
  challenge(): Promise<string>
  /** The door's token, null on a 401, rejecting on any other answer. */
  assert(key: K, challenge: string): Promise<string | null>
  mint(): { key: K; raw: R }
  /** Write a new file privately; rejects, leaving nothing, when it cannot. */
  savePending(file: string, raw: R): Promise<void>
  /** File `from` as `to` WITHOUT replacing `to` (rejects EEXIST if it exists). */
  promote(from: string, to: string): Promise<void>
  /** Something worth saying that is not a failure of the sign-in. */
  report(message: string): void
  lock?: LockOptions
}

/** Sign in at one door with the keys held for it, under the home lock and the walk deadline. */
export function signInAtHome<K, R>(deps: SignInDeps<K, R>): Promise<string>
