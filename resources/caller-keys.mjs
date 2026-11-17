// THE KEYS A DEVICE HOLDS FOR ONE DOOR: one sign-in walk, shared by the app
// (src/main/served-admission.ts) and the card (orch-line.mjs), which read and
// write one folder for one account. How a key is read, written privately and
// filed is each side's own; WHICH key is tried, kept, made or set aside is
// here, and holds even when a door lies about its serviceId (which names the
// home file, so any door can claim another's):
//
//  1. NO KEY FILE IS EVER UNLINKED. A key that would have been let go moves
//     to <keyDir>/retired/, keeps its name, and is still offered (last) on
//     every sign-in at its home, so recovering from any mistake is a retry.
//  2. At most ONE pending key per home (`<home>.pending-<origin tag>-<12 hex>`).
//     While one exists none is minted: it is offered as the sign-up key.
//  3. The challenge is fetched BEFORE a key is minted, so a door that hands
//     out none costs no key and no file.
//  4. A filed key is never replaced: keys are filed by a no-clobber link, and
//     where one is filed already both are kept, said.
//  5. A QUOTA PER DOOR ORIGIN (its URL origin; a relayed door, its name),
//     carried in the pending name's origin tag: PENDING_PER_ORIGIN pending and
//     RETIRED_PER_ORIGIN retired. At the pending quota the origin's oldest
//     pending is retired; at the retired quota new keys are refused for THAT
//     origin only. A folder-wide cap stays only as a backstop.
//  6. One sign-in per home at a time, across processes: `<home>.lock`, made
//     O_EXCL, holding the pid and when; taken over (by a move that is checked)
//     once its holder is dead or it is LOCK_STALE_MS old; and a walk gives up
//     at WALK_DEADLINE_MS, before anyone may take its lock over.

import { createHash, randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import path from 'node:path'

export const PENDING_PER_ORIGIN = 4
export const RETIRED_PER_ORIGIN = 16
/** A backstop only: well above any one door's quota. */
export const MAX_PENDING_FILES = 256
export const LOCK_STALE_MS = 2 * 60_000
/** A walk gives up before its lock could be taken over as stale. */
export const WALK_DEADLINE_MS = 90_000
/** A waiter waits longer than a walk may take. */
export const LOCK_WAIT_MS = 100_000
const LOCK_POLL_MS = 100

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const TAGGED = /\.pending-([0-9a-f]{8})-[0-9a-f]{12}$/

/** The short, stable tag a door's origin is known by in pending names. */
export function originTag(origin) {
  return createHash('sha256').update(String(origin)).digest('hex').slice(0, 8)
}

/** `<home>.pending-<tag>-<12 hex>`, exactly, for this home and no other. */
export function pendingPattern(home) {
  return new RegExp(`^${escape(path.basename(home))}\\.pending-[0-9a-f]{8}-[0-9a-f]{12}$`)
}

/** A fresh pending name for this home, tagged with the door's origin. */
export function newPendingName(home, origin) {
  return `${home}.pending-${originTag(origin)}-${randomBytes(6).toString('hex')}`
}

const retiredDir = (home) => path.join(path.dirname(home), 'retired')

const listed = (dir, keep) => {
  try {
    return readdirSync(dir).filter(keep).sort().map((name) => path.join(dir, name))
  } catch {
    return []
  }
}

/** The pending keys of this home, oldest name first. */
export function pendingKeys(home) {
  const pattern = pendingPattern(home)
  return listed(path.dirname(home), (name) => pattern.test(name))
}

/** The retired keys of this home. */
export function retiredKeys(home) {
  const pattern = pendingPattern(home)
  return listed(retiredDir(home), (name) => pattern.test(name))
}

const taggedIn = (dir, tag) => listed(dir, (name) => TAGGED.exec(name)?.[1] === tag)

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

/** Move `file` to `to`'s name WITHOUT replacing anything there (link, then drop the old name). */
function moveNoClobber(file, to) {
  linkSync(file, to)
  unlinkSync(file)
  fsyncDir(path.dirname(to))
  fsyncDir(path.dirname(file))
}

/** Set a key aside in retired/: never deleted, still offered (1). */
function retire(file) {
  const dir = path.join(path.dirname(file), 'retired')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    moveNoClobber(file, path.join(dir, path.basename(file)))
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
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
 * Take a lock file over only if it still holds `expected`: moved aside under a
 * unique name first, so no other taker can be holding it as we look; one that
 * turns out to hold something else is put back where it was.
 */
function takeIf(lock, expected) {
  const aside = `${lock}.${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    renameSync(lock, aside)
  } catch {
    return false
  }
  let held = null
  try {
    held = readFileSync(aside, 'utf8')
  } catch {
    held = null
  }
  if (held === expected) {
    unlinkSync(aside)
    return true
  }
  try {
    linkSync(aside, lock)
  } catch {
    // A newer lock is there already; the one moved aside was superseded anyway.
  }
  try {
    unlinkSync(aside)
  } catch {
    // Already gone.
  }
  return false
}

/**
 * Run `run` holding `<home>.lock`. Waits while a live, fresh holder has it;
 * takes over (checked) a lock whose holder is dead or that is older than
 * staleMs; gives up after waitMs. Released only if it is still this run's own.
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
    const age =
      holder && typeof holder.at === 'number'
        ? now() - holder.at
        : (() => {
            try {
              return now() - lstatSync(lock).mtimeMs
            } catch {
              return 0
            }
          })()
    const stale = seen !== null && (age > staleMs || (holder && typeof holder.pid === 'number' && !alive(holder.pid)))
    if (stale) {
      options.onStale?.()
      if (takeIf(lock, seen)) continue
    }
    if (now() >= deadline) throw new Error('another sign-in to this door is still running; try again in a moment')
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  try {
    return await run()
  } finally {
    takeIf(lock, mine)
  }
}

/**
 * Sign in at one door with the keys this device holds for it, under the home
 * lock and the walk deadline. `deps` are each side's own I/O (see
 * caller-keys.d.mts). Resolves the door's token; rejects, having let go of no
 * key, otherwise.
 */
export async function signInAtHome(deps) {
  return withHomeLock(deps.home, () => walk(deps), deps.lock)
}

async function walk(deps) {
  const { home, origin } = deps
  const until = Date.now() + (deps.lock?.deadlineMs ?? WALK_DEADLINE_MS)
  /** One step of the walk, abandoned once the walk is out of time. */
  const step = (work) => {
    const left = until - Date.now()
    if (left <= 0) return Promise.reject(new Error('this sign-in took too long; try again'))
    let timer
    return Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('this sign-in took too long; try again')), left)
      })
    ]).finally(() => clearTimeout(timer))
  }
  const signIn = async (key) => {
    const challenge = await step(() => deps.challenge())
    return step(() => deps.assert(key, challenge))
  }
  const read = (file) => step(() => deps.readKey(file))

  /** File `from` under the door without replacing anything (4); a failure is said, never thrown. */
  const file = async (from) => {
    try {
      await step(() => deps.promote(from, home))
    } catch (error) {
      deps.report(
        error?.code === 'EEXIST'
          ? `this door turned down the key filed for it and took ${path.basename(from)}: the filed key is left untouched and both are kept`
          : error?.filed
            ? `the account key is filed under its door, but ${error?.message ?? error}`
            : `filing the account key under its door failed (${error?.message ?? error}); it is kept at ${path.basename(from)}`
      )
    }
  }
  /** A DIFFERENT key signed in here: the waiting ones are set aside, never deleted (1). */
  const retirePendingsBut = (kept) => {
    for (const pending of pendingKeys(home)) if (pending !== kept) retire(pending)
  }

  // The filed key, then any filed under an old scheme.
  for (const candidate of [home, ...(deps.others ?? [])]) {
    const found = await read(candidate)
    if (!found) continue
    const token = await signIn(found.key)
    if (token === null) continue
    if (candidate !== home) {
      // An old-scheme key, filed under the door only where nothing is filed yet.
      if (await read(home).catch(() => null)) {
        deps.report(`the key under ${path.basename(candidate)} signed in, but another is filed under this door: both are kept`)
      } else {
        try {
          const copy = newPendingName(home, origin)
          await step(() => deps.savePending(copy, found.raw))
          await file(copy)
        } catch (error) {
          deps.report(`filing the account key under its door failed (${error?.message ?? error}); it stays at ${path.basename(candidate)}`)
        }
      }
    }
    retirePendingsBut(null)
    return token
  }

  // A key that waited: the sign-up key, whether or not the door bound it (2).
  let waiting = false
  for (const pending of pendingKeys(home)) {
    const found = await read(pending)
    if (!found) continue
    waiting = true
    const token = await signIn(found.key)
    if (token === null) continue
    await file(pending)
    retirePendingsBut(pending)
    return token
  }

  // A key set aside earlier: offered last, so recovery is a retry (1).
  for (const retired of retiredKeys(home)) {
    const found = await read(retired)
    if (!found) continue
    const token = await signIn(found.key)
    if (token === null) continue
    await file(retired)
    retirePendingsBut(null)
    return token
  }

  if (waiting) {
    throw new Error('sign-in refused — the door turned down the key this device keeps for it (kept for the next try); if this name already belongs to another key at this door, a new key would be refused too')
  }

  // Nothing held: a new key, within this door's quota (5) and only once the
  // door has handed out a challenge (3), and saved before the door sees it.
  makeRoom(home, origin)
  const challenge = await step(() => deps.challenge())
  const minted = deps.mint()
  const pending = newPendingName(home, origin)
  await step(() => deps.savePending(pending, minted.raw))
  const token = await step(() => deps.assert(minted.key, challenge))
  if (token === null) {
    // KEPT: a 401 is any failure at the door, so this key may yet be the one.
    throw new Error('sign-in refused — this name already belongs to another key at this door (the key is kept for the next try)')
  }
  await file(pending)
  retirePendingsBut(pending)
  return token
}

/** Room for one more pending key from this origin, or a refusal for THIS origin only (5). */
function makeRoom(home, origin) {
  const dir = path.dirname(home)
  const tag = originTag(origin)
  if (listed(dir, (name) => TAGGED.test(name)).length >= MAX_PENDING_FILES) {
    throw new Error(`too many sign-ups are waiting in ${dir} (${MAX_PENDING_FILES}); no new key is made until some are settled`)
  }
  const waiting = taggedIn(dir, tag)
  if (waiting.length < PENDING_PER_ORIGIN) return
  if (taggedIn(retiredDir(home), tag).length >= RETIRED_PER_ORIGIN) {
    throw new Error(`too many sign-ups at ${origin} never completed; no new key is made for it`)
  }
  const oldest = waiting
    .map((file) => {
      try {
        return { file, at: lstatSync(file).mtimeMs }
      } catch {
        return { file, at: Number.POSITIVE_INFINITY }
      }
    })
    .sort((a, b) => a.at - b.at || a.file.localeCompare(b.file))[0]
  retire(oldest.file)
}
