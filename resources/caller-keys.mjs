// THE KEYS A DEVICE HOLDS FOR ONE DOOR: one sign-in walk, shared by the app
// (src/main/served-admission.ts) and the card (orch-line.mjs), which read and
// write one folder for one account. How a key is read, written privately and
// filed is each side's own; WHICH key is tried, kept, made or let go is here,
// held to six invariants:
//
//  1. At most ONE pending key per home (`<home>.pending-<12 hex>`). While one
//     exists none is minted: it is offered as the sign-up key instead (an
//     unbound one enrolls as well as a fresh one, and if the name is someone
//     else's a fresh key would be refused too).
//  2. The challenge is fetched BEFORE a key is minted, so a door that will not
//     hand one out costs no key and no file.
//  3. A pending key is deleted only after a DIFFERENT key has signed in at this
//     home: only then can it never be the key the door bound. Nothing ages out.
//  4. An existing home key is never replaced: a key is filed under the door by
//     a no-clobber link, and where one is filed already both are kept, said.
//  5. One sign-in per home at a time, across processes: `<home>.lock`, made
//     O_EXCL, holding the pid and when; taken over once its holder is dead or
//     it is older than LOCK_STALE_MS.
//  6. At most MAX_PENDING_FILES pending keys in the folder, whatever doors
//     they are for, so doors naming random serviceIds cannot grow it.

import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from 'node:fs'
import path from 'node:path'

export const MAX_PENDING_FILES = 32
export const LOCK_STALE_MS = 2 * 60_000
export const LOCK_WAIT_MS = 60_000
const LOCK_POLL_MS = 100

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const PENDING_ANY = /\.pending-[0-9a-f]{12}$/

/** `<home>.pending-<12 hex>`, exactly, for this home and no other. */
export function pendingPattern(home) {
  return new RegExp(`^${escape(path.basename(home))}\\.pending-[0-9a-f]{12}$`)
}

/** A fresh pending name for this home. */
export function newPendingName(home) {
  return `${home}.pending-${randomBytes(6).toString('hex')}`
}

/** The pending keys of this home, oldest name first. */
export function pendingKeys(home) {
  const pattern = pendingPattern(home)
  try {
    return readdirSync(path.dirname(home)).filter((name) => pattern.test(name)).sort().map((name) => path.join(path.dirname(home), name))
  } catch {
    return []
  }
}

/** Every pending key in the folder, whatever door it is for. */
export function pendingCount(dir) {
  try {
    return readdirSync(dir).filter((name) => PENDING_ANY.test(name)).length
  } catch {
    return 0
  }
}

/** Make a rename, link or unlink in `dir` durable where the OS allows (POSIX); a no-op elsewhere. */
export function fsyncDir(dir) {
  let fd = null
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    // Windows cannot open a folder this way; NTFS journals the name change itself.
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Run `run` holding `<home>.lock`. Waits while a live, fresh holder has it;
 * takes over a lock whose holder is dead or that is older than staleMs; gives
 * up after waitMs. Released only if it is still this run's own lock.
 */
export async function withHomeLock(home, run, options = {}) {
  const lock = `${home}.lock`
  const now = options.now ?? Date.now
  const waitMs = options.waitMs ?? LOCK_WAIT_MS
  const staleMs = options.staleMs ?? LOCK_STALE_MS
  const pollMs = options.pollMs ?? LOCK_POLL_MS
  const mine = JSON.stringify({ pid: process.pid, at: now(), nonce: randomBytes(8).toString('hex') })
  const deadline = now() + waitMs
  for (;;) {
    try {
      const fd = openSync(lock, 'wx', 0o600)
      try {
        writeSync(fd, mine)
      } finally {
        closeSync(fd)
      }
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    let seen = null
    let holder = null
    try {
      seen = readFileSync(lock, 'utf8')
      holder = JSON.parse(seen)
    } catch {
      holder = null
    }
    const age = holder && typeof holder.at === 'number' ? now() - holder.at : (() => {
      try {
        return now() - lstatSync(lock).mtimeMs
      } catch {
        return 0
      }
    })()
    const stale = age > staleMs || (holder && typeof holder.pid === 'number' && !alive(holder.pid))
    if (stale) {
      // Taken over only if it is still the lock that was judged stale.
      try {
        if (seen === null || readFileSync(lock, 'utf8') === seen) unlinkSync(lock)
      } catch {
        // Gone already: the next try takes it.
      }
      continue
    }
    if (now() >= deadline) throw new Error('another sign-in to this door is still running; try again in a moment')
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  try {
    return await run()
  } finally {
    try {
      if (readFileSync(lock, 'utf8') === mine) unlinkSync(lock)
    } catch {
      // Taken over as stale, or removed: not ours to remove now.
    }
  }
}

/**
 * Sign in at one door with the keys this device holds for it, under the home
 * lock. `deps` are each side's own I/O (see caller-keys.d.mts). Resolves the
 * door's token; rejects, having deleted no key a door may hold, otherwise.
 */
export async function signInAtHome(deps) {
  return withHomeLock(deps.home, () => walk(deps), deps.lock)
}

async function walk(deps) {
  const { home } = deps
  const signIn = async (key) => deps.assert(key, await deps.challenge())

  /** File `from` under the door without replacing anything (4); a failure is said, never thrown. */
  const file = async (from) => {
    try {
      await deps.promote(from, home)
    } catch (error) {
      deps.report(
        error?.code === 'EEXIST'
          ? `this door turned down the key filed for it and took ${path.basename(from)}: the filed key is left untouched and both are kept`
          : `filing the account key under its door failed (${error?.message ?? error}); it stays at ${path.basename(from)}`
      )
    }
  }
  /** A DIFFERENT key signed in here, so no other waiting key can be this account (3). */
  const dropPendingsBut = (kept) => {
    for (const pending of pendingKeys(home)) if (pending !== kept) deps.remove(pending)
  }

  // The filed key, then any filed under an old scheme.
  for (const candidate of [home, ...(deps.others ?? [])]) {
    const found = await deps.readKey(candidate)
    if (!found) continue
    const token = await signIn(found.key)
    if (token === null) continue
    if (candidate !== home) {
      // An old-scheme key, filed under the door only where nothing is filed yet.
      if (await deps.readKey(home).catch(() => null)) {
        deps.report(`the key under ${path.basename(candidate)} signed in, but another is filed under this door: both are kept`)
      } else {
        const copy = newPendingName(home)
        try {
          await deps.savePending(copy, found.raw)
          await file(copy)
        } catch (error) {
          deps.report(`filing the account key under its door failed (${error?.message ?? error}); it stays at ${path.basename(candidate)}`)
        }
      }
    }
    dropPendingsBut(null)
    return token
  }

  // A key that waited: the sign-up key, whether or not the door bound it (1).
  let waiting = false
  for (const pending of pendingKeys(home)) {
    const found = await deps.readKey(pending)
    if (!found) continue
    waiting = true
    const token = await signIn(found.key)
    if (token === null) continue
    await file(pending)
    dropPendingsBut(pending)
    return token
  }
  if (waiting) {
    throw new Error('sign-in refused — the door turned down the key this device keeps for it (kept for the next try); if this name already belongs to another key at this door, a new key would be refused too')
  }

  // Nothing held: a new key, but only within the cap (6) and only once the
  // door has handed out a challenge (2), and saved before the door sees it.
  if (pendingCount(path.dirname(home)) >= MAX_PENDING_FILES) {
    throw new Error(`too many sign-ups are waiting in ${path.dirname(home)} (${MAX_PENDING_FILES}); no new key is made until some are settled`)
  }
  const challenge = await deps.challenge()
  const minted = deps.mint()
  const pending = newPendingName(home)
  await deps.savePending(pending, minted.raw)
  const token = await deps.assert(minted.key, challenge)
  if (token === null) {
    // KEPT (3): a 401 is any failure at the door, so this key may yet be the one.
    throw new Error('sign-in refused — this name already belongs to another key at this door (the key is kept for the next try)')
  }
  await file(pending)
  dropPendingsBut(pending)
  return token
}
