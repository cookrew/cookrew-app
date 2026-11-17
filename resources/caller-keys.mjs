// THE KEYS A DEVICE HOLDS FOR ONE DOOR: one sign-in walk, shared by the app
// (src/main/served-admission.ts) and the card (orch-line.mjs), which read and
// write one folder for one account. How a key is read, written privately and
// filed is each side's own; WHICH key is tried, kept, made or set aside is
// here, and holds even when a door lies about its serviceId (which names the
// home file, so any door can claim another's):
//
//  1. NO KEY FILE IS EVER UNLINKED. A key that would have been let go moves
//     to <keyDir>/retired/ and is still offered (last) on every sign-in at its
//     home, so recovering from any mistake is a retry. Only a second NAME of
//     the very same file (a crash between link and unlink) is ever dropped.
//  2. At most ONE pending key per home (`<home>.pending-<origin tag>-<12 hex>`).
//     While one exists none is minted: it is offered as the sign-up key.
//  3. The challenge is fetched BEFORE a key is minted, so a door that hands
//     out none costs no key and no file.
//  4. A filed key is never replaced: keys are filed by a no-clobber link, from
//     the same folder or its retired/ only, and where one is filed already
//     both are kept, said.
//  5. BOUNDS PER DOOR ORIGIN (its URL origin; a relayed door, its name). The
//     origin tag is keyed by a secret of this device, so no door can choose an
//     origin that shares another's: PENDING_PER_ORIGIN pending (the oldest is
//     retired past it), RETIRED_PER_ORIGIN retired (then no new key for that
//     origin; a retirement after a sign-in may pass it by one), and
//     HOMES_PER_ORIGIN doors it may make keys for. A folder-wide cap stays
//     only as a backstop.
//  6. One sign-in per home at a time, across processes: `<home>.lock`, made
//     O_EXCL and stamped when made, holding the pid; taken over (by a checked
//     move) once its holder is dead or it is LOCK_STALE_MS old; a walk gives
//     up at WALK_DEADLINE_MS, before anyone may take its lock over.

import { createHmac, randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import path from 'node:path'

export const PENDING_PER_ORIGIN = 4
export const RETIRED_PER_ORIGIN = 16
export const HOMES_PER_ORIGIN = 64
/** A backstop only: well above any one door's quota. */
export const MAX_PENDING_FILES = 256
export const LOCK_STALE_MS = 2 * 60_000
/** A walk gives up before its lock could be taken over as stale. */
export const WALK_DEADLINE_MS = 90_000
/** A waiter waits longer than a walk may take. */
export const LOCK_WAIT_MS = 100_000
const LOCK_POLL_MS = 100

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A pending or retired name; a retired one may carry a unique suffix (see retire). */
const TAGGED = /\.pending-([0-9a-f]{16})-[0-9a-f]{12}(?:\.[0-9a-f]{8})?$/
const SECRET_FILE = '.origin-key'

const secrets = new Map()

/**
 * This device's secret for origin tags, in the key folder: 32 random bytes,
 * made O_EXCL 0600 through a temp name and linked into place, so two makers at
 * once both end up reading the one that won.
 */
function deviceSecret(dir) {
  const known = secrets.get(dir)
  if (known) return known
  const file = path.join(dir, SECRET_FILE)
  const read = () => {
    const text = readFileSync(file, 'utf8').trim()
    if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${file} is not a device secret`)
    return text
  }
  let secret
  try {
    secret = read()
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temp = path.join(dir, `${SECRET_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
    const fd = openSync(temp, 'wx', 0o600)
    try {
      writeSync(fd, randomBytes(32).toString('hex'))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      linkSync(temp, file)
    } catch (linkError) {
      if (linkError?.code !== 'EEXIST') throw linkError
    }
    unlinkSync(temp)
    fsyncDir(dir)
    secret = read()
  }
  secrets.set(dir, secret)
  return secret
}

/**
 * The tag a door's origin is known by in pending names, in this key folder:
 * HMAC-SHA256 under this device's secret, 64 bits. A door cannot compute it,
 * so it cannot grind an origin whose tag is another door's.
 */
export function originTag(origin, dir) {
  return createHmac('sha256', deviceSecret(dir)).update(String(origin)).digest('hex').slice(0, 16)
}

/** `<home>.pending-<tag>-<12 hex>`, exactly, for this home and no other (a retired one may carry a suffix). */
export function pendingPattern(home) {
  return new RegExp(`^${escape(path.basename(home))}\\.pending-[0-9a-f]{16}-[0-9a-f]{12}(?:\\.[0-9a-f]{8})?$`)
}

/** A fresh pending name for this home, tagged with the door's origin. */
export function newPendingName(home, origin) {
  return `${home}.pending-${originTag(origin, path.dirname(home))}-${randomBytes(6).toString('hex')}`
}

const retiredDir = (home) => path.join(path.dirname(home), 'retired')

const listed = (dir, keep) => {
  try {
    return readdirSync(dir).filter(keep).sort().map((name) => path.join(dir, name))
  } catch {
    return []
  }
}

/** The pending keys of this home, by name (origin tag, then random). */
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

/**
 * May a key at `from` be filed as `to`? Only from `to`'s own folder or that
 * folder's retired/, and only on the same filesystem (a link cannot cross one).
 * The one rule both the app and the card file by.
 */
export function mayFile(from, to) {
  const toDir = path.dirname(path.resolve(to))
  const fromDir = path.dirname(path.resolve(from))
  if (fromDir !== toDir && fromDir !== path.join(toDir, 'retired')) return false
  try {
    return lstatSync(fromDir).dev === lstatSync(toDir).dev
  } catch {
    return false
  }
}

const sameFile = (a, b) => {
  try {
    const x = lstatSync(a, { bigint: true })
    const y = lstatSync(b, { bigint: true })
    return x.dev === y.dev && x.ino === y.ino
  } catch {
    return false
  }
}

/**
 * Set a key aside in retired/: never deleted, still offered (1). Where its
 * name is taken there already: by this very file (a crash between link and
 * unlink), its stray name in the main folder is dropped; by another file,
 * this one goes under a unique suffix beside it.
 */
function retire(file) {
  const dir = path.join(path.dirname(file), 'retired')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  let to = path.join(dir, path.basename(file))
  for (let tries = 0; ; tries += 1) {
    try {
      linkSync(file, to)
      break
    } catch (error) {
      if (error?.code === 'ENOENT') return
      if (error?.code !== 'EEXIST' || tries >= 3) throw error
      if (sameFile(file, to)) break
      to = path.join(dir, `${path.basename(file)}.${randomBytes(4).toString('hex')}`)
    }
  }
  unlinkSync(file)
  fsyncDir(dir)
  fsyncDir(path.dirname(file))
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
 * unique name first, so no other taker can be holding it as we look. One that
 * turns out to hold something else is linked back where it was; if that name
 * has been taken meanwhile, the moved file is LEFT ASIDE and nothing at all is
 * unlinked, so no live holder's lock is ever removed.
 */
function takeIf(lock, expected, onAside) {
  const aside = `${lock}.${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    renameSync(lock, aside)
  } catch {
    return false
  }
  onAside?.()
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
    // Its name is someone's lock again: leave this one aside, untouched.
    return false
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
 * staleMs; gives up after waitMs. Stamped when it is made, so time spent
 * waiting for it never counts against it. Released only if it is still ours.
 */
export async function withHomeLock(home, run, options = {}) {
  const lock = `${home}.lock`
  const now = options.now ?? Date.now
  const waitMs = options.waitMs ?? LOCK_WAIT_MS
  const staleMs = options.staleMs ?? LOCK_STALE_MS
  const pollMs = options.pollMs ?? LOCK_POLL_MS
  const deadline = now() + waitMs
  let mine = null
  for (;;) {
    const stamp = JSON.stringify({ pid: process.pid, at: now(), nonce: randomBytes(8).toString('hex') })
    try {
      const fd = openSync(lock, 'wx', 0o600)
      try {
        writeSync(fd, stamp)
      } finally {
        closeSync(fd)
      }
      mine = stamp
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
      if (takeIf(lock, seen, options.onAside)) continue
    }
    if (now() >= deadline) throw new Error('another sign-in to this door is still running; try again in a moment')
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  try {
    return await run()
  } finally {
    takeIf(lock, mine, options.onAside)
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
  /**
   * A DIFFERENT key signed in here: the waiting ones are set aside, never
   * deleted (1). The door has already said yes, so a failure is said, not thrown.
   */
  const retirePendingsBut = (kept) => {
    for (const pending of pendingKeys(home)) {
      if (pending === kept) continue
      try {
        retire(pending)
      } catch (error) {
        deps.report(`${path.basename(pending)} could not be set aside (${error?.message ?? error}); it stays where it is`)
      }
    }
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

  // Nothing held: a new key, only once the door has handed out a challenge
  // (3), within this door's bounds (5), and saved before the door sees it.
  const challenge = await step(() => deps.challenge())
  makeRoom(home, origin)
  const minted = deps.mint()
  const pending = newPendingName(home, origin)
  await step(() => deps.savePending(pending, minted.raw))
  markHome(home, origin)
  const token = await step(() => deps.assert(minted.key, challenge))
  if (token === null) {
    // KEPT: a 401 is any failure at the door, so this key may yet be the one.
    throw new Error('sign-in refused — this name already belongs to another key at this door (the key is kept for the next try)')
  }
  await file(pending)
  retirePendingsBut(pending)
  return token
}

/** Where the doors an origin made keys for are noted, one empty file each (5). */
const homesDir = (home, origin) => path.join(path.dirname(home), 'origins', originTag(origin, path.dirname(home)))

/** Note that `origin` made a key for this home: counted against HOMES_PER_ORIGIN. */
function markHome(home, origin) {
  const dir = homesDir(home, origin)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    closeSync(openSync(path.join(dir, path.basename(home)), 'wx', 0o600))
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
}

/** Room for one more key from this origin, or a refusal for THIS origin only (5). */
function makeRoom(home, origin) {
  const dir = path.dirname(home)
  if (listed(dir, (name) => TAGGED.test(name)).length >= MAX_PENDING_FILES) {
    throw new Error(`too many sign-ups are waiting in ${dir} (${MAX_PENDING_FILES}); no new key is made until some are settled`)
  }
  const tag = originTag(origin, dir)
  const homes = listed(homesDir(home, origin), () => true)
  if (!homes.some((file) => path.basename(file) === path.basename(home)) && homes.length >= HOMES_PER_ORIGIN) {
    throw new Error(`too many teams at ${origin} (${HOMES_PER_ORIGIN}); no new key is made for another one`)
  }
  if (taggedIn(retiredDir(home), tag).length >= RETIRED_PER_ORIGIN) {
    throw new Error(`too many sign-ups at ${origin} never completed; no new key is made for it`)
  }
  const waiting = taggedIn(dir, tag)
  if (waiting.length < PENDING_PER_ORIGIN) return
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
