// ATOMIC SMALL-FILE WRITES, AND A SINGLE WRITER FOR THEM.
//
// WHY (2026-09-06). The durable lineage record is the thing that must survive
// the crash, the kill and the second writer — it is the copy that exists so a
// checkpoint can never become unreachable. A plain writeFileSync fails all
// three: a process killed mid-write leaves a truncated file, and two writers
// that each read-then-write lose whichever update landed first.
//
//   write <file>.tmp (0600) → rename(<file>.tmp, <file>)
//
// rename(2) within one directory is atomic on APFS, HFS+ and ext4: a reader
// sees either the whole old file or the whole new one, never a mix. A crash
// before the rename leaves only the temp file, which is removed on the next
// attempt — the previous chain is still there and still parseable.
//
// The lock is an O_EXCL create, which is the one filesystem primitive that is
// atomic across processes without a daemon. It is a MUTUAL-EXCLUSION lock, not
// a correctness lock: the merge re-reads inside it, so even a broken (stale)
// lock degrades to "merge from a slightly older read", never to a lost id.

import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** File mode for everything written here — the owner's session ids. */
export const PRIVATE_FILE_MODE = 0o600
export const PRIVATE_DIR_MODE = 0o700

/** How long a lock is respected before it is assumed to be a corpse. */
export const LOCK_STALE_MS = 5_000
/** How long a writer waits for the lock before breaking it. */
const LOCK_POLL_MS = 5
const LOCK_ATTEMPTS = 200

export interface AtomicWriteDeps {
  /** Injected so the crash-between-temp-and-rename gate can simulate it. */
  rename?: (from: string, to: string) => void
  now?: () => number
}

/**
 * Write `text` to `file` so a reader never sees a partial file.
 *
 * Throws on failure with the temp file cleaned up: the caller decides what a
 * failed durable write means, and for the lineage it means "report it and keep
 * the previous chain", never "lose the id".
 */
export function writeFileAtomic(file: string, text: string, deps: AtomicWriteDeps = {}): void {
  const rename = deps.rename ?? renameSync
  const tmp = `${file}.tmp`
  mkdirSync(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE })
  try {
    writeFileSync(tmp, text, { mode: PRIVATE_FILE_MODE })
    rename(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error instanceof Error ? error : new Error(String(error))
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Run `fn` while holding `<file>.lock`, so two writers cannot interleave a
 * read-modify-write on the same record.
 *
 * A lock older than LOCK_STALE_MS is broken rather than waited on: this
 * process may be the successor of one that was killed holding it, and a
 * checkpoint record that can never be written again would be a worse failure
 * than the race the lock prevents.
 */
export function withFileLock<T>(file: string, fn: () => T, deps: AtomicWriteDeps = {}): T {
  const now = deps.now ?? Date.now
  const lock = `${file}.lock`
  mkdirSync(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE })
  const deadline = now() + LOCK_STALE_MS
  let held = false
  for (let attempt = 0; attempt < LOCK_ATTEMPTS && !held; attempt++) {
    try {
      closeSync(openSync(lock, 'wx', PRIVATE_FILE_MODE))
      held = true
    } catch {
      if (now() > deadline) {
        rmSync(lock, { force: true }) // a corpse's lock; see the docblock
        continue
      }
      sleepSync(LOCK_POLL_MS)
    }
  }
  try {
    return fn()
  } finally {
    if (held) rmSync(lock, { force: true })
  }
}
