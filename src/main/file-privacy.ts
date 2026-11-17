import { randomBytes } from 'node:crypto'
import { closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import path from 'node:path'
import {
  createWindowsPrivateFile,
  parseDescriptor,
  privacyProblem,
  readWindowsFolderSecurity,
  readWindowsSecurity,
  type WindowsSecurity
} from './windows-acl'

/**
 * IS A SECRET'S FILE PRIVATE TO THIS USER? Asked before a key is trusted, and
 * after one is written, before it is kept.
 *
 * POSIX: the group and other permission bits are clear (and, for a file this
 * process writes, it owns it).
 *
 * WINDOWS: there are no such bits (stat reports 0o666 for every writable
 * file). The file's owner and access list are read (windows-acl.ts): the owner
 * and every grant must be this user, SYSTEM or Administrators. A descriptor
 * that cannot be read, or holds anything the parser cannot account for, is
 * OPEN: privacy that is not proven is refused, never assumed.
 *
 * NEVER ON THE MAIN THREAD'S CLOCK. Reading a Windows list starts PowerShell,
 * so it is async. The sync question (filePrivacy) answers from a cache keyed
 * by the file's identity and times, and on a miss answers PENDING, which every
 * caller treats as refused, while the check runs. A refusal is remembered with
 * a growing back-off, so a file that will not prove itself costs one check per
 * back-off, not one per request.
 */
export type FilePrivacy =
  | { readonly open: false }
  | { readonly open: true; readonly why: string; readonly fix: string; readonly pending?: true }

/** What a file's status says, as far as privacy and the cache go. */
export interface FileFacts {
  readonly mode: number
  readonly uid: number
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
}

/** How Windows is asked; the real thing by default, injected in tests on other OSes. */
export interface WindowsAcl {
  read(file: string): Promise<WindowsSecurity>
  readFolder(dir: string): Promise<WindowsSecurity>
  /** Create `file` private from its first instant, `data` written through that same handle. */
  createPrivate(file: string, data: Buffer): Promise<WindowsSecurity>
}

export interface FilePrivacyDeps {
  readonly platform?: NodeJS.Platform
  /** A path's status; statSync by default. Throws as stat does (ENOENT included). */
  readonly stat?: (file: string) => FileFacts
  /** An open file's status; fstatSync by default. */
  readonly fstat?: (fd: number) => FileFacts
  /** This process's user id on POSIX; process.getuid by default. */
  readonly uid?: () => number | undefined
  readonly windows?: WindowsAcl
  readonly cache?: PrivacyCache
  readonly now?: () => number
  /** writeSync by default: how many bytes it took. */
  readonly write?: (fd: number, buffer: Buffer, offset: number, length: number) => number
  /** rmSync by default: how a temp or a refused file is removed. */
  readonly remove?: (file: string) => void
  /** The first wait before a removal that failed is tried again. */
  readonly removeRetryMs?: number
}

/**
 * A verdict that may be trusted this long before it is asked again, and is
 * answered for as long again while the new question runs.
 *
 * THE STALENESS BOUND. A remembered "private" is keyed on the file's identity,
 * size, mtime and ctime, so a change that moves any of them is noticed on the
 * next read. If NTFS does NOT move ChangeTime when only the DACL changes (the
 * Windows test records which, in the CI log), a list loosened after a proof is
 * still answered "private" for up to 2 × PROVEN_FOR_MS = 120 s. That is the
 * real bound, and it applies only to readers that do not keep the key in
 * memory anyway (the signing key, once loaded, is never read again).
 */
export const PROVEN_FOR_MS = 60_000
/** The first wait before a refused file is asked again; it doubles, to MAX_RETRY_MS. */
export const FIRST_RETRY_MS = 5_000
export const MAX_RETRY_MS = 300_000

const POSIX_FIX = 'chmod 600 it'
const WINDOWS_FIX = 'make your own account its owner and leave only you, SYSTEM and Administrators in its Security settings'
const PENDING: FilePrivacy = {
  open: true,
  pending: true,
  why: 'its owner and access list are still being checked',
  fix: 'try again in a moment'
}
const REAL_WINDOWS: WindowsAcl = {
  read: readWindowsSecurity,
  readFolder: readWindowsFolderSecurity,
  createPrivate: createWindowsPrivateFile
}

interface Entry {
  readonly stamp: string
  verdict: FilePrivacy | null
  at: number
  failures: number
  retryAt: number
  inflight: Promise<FilePrivacy> | null
}

/** Remembered Windows verdicts, by path. One per process by default. */
export class PrivacyCache {
  readonly entries = new Map<string, Entry>()
}

const SHARED_CACHE = new PrivacyCache()

const factsOf = (s: { mode: number; uid: number; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): FileFacts => ({
  mode: s.mode,
  uid: s.uid,
  dev: s.dev,
  ino: s.ino,
  size: s.size,
  mtimeMs: s.mtimeMs,
  ctimeMs: s.ctimeMs
})
const statOf = (deps: FilePrivacyDeps): ((file: string) => FileFacts) => deps.stat ?? ((file) => factsOf(statSync(file)))
const isWindows = (deps: FilePrivacyDeps): boolean => (deps.platform ?? process.platform) === 'win32'
const windowsOf = (deps: FilePrivacyDeps): WindowsAcl => deps.windows ?? REAL_WINDOWS
const cacheOf = (deps: FilePrivacyDeps): PrivacyCache => deps.cache ?? SHARED_CACHE
const nowOf = (deps: FilePrivacyDeps): number => (deps.now ?? Date.now)()
/** A file that changed in any way is a file not yet proven. */
const stampOf = (f: FileFacts): string => `${f.dev}:${f.ino}:${f.size}:${f.mtimeMs}:${f.ctimeMs}`

function posixVerdict(facts: FileFacts): FilePrivacy {
  return (facts.mode & 0o077) === 0
    ? { open: false }
    : { open: true, why: `it is readable by others (mode ${(facts.mode & 0o777).toString(8)})`, fix: POSIX_FIX }
}

/** The verdict on what Windows reported. Unreadable or unaccountable is open. */
async function windowsVerdict(report: () => Promise<WindowsSecurity>, container = false): Promise<FilePrivacy> {
  let why: string | null
  try {
    const { userSid, descriptor } = await report()
    why = privacyProblem(parseDescriptor(descriptor), userSid, { container })
  } catch (error) {
    why = `its owner and access list could not be proven (${error instanceof Error ? error.message : String(error)})`
  }
  return why === null ? { open: false } : { open: true, why, fix: WINDOWS_FIX }
}

/** Ask Windows about `file` now (joining a check already running) and remember the answer. Never rejects. */
function refresh(file: string, stamp: string, deps: FilePrivacyDeps): Promise<FilePrivacy> {
  const cache = cacheOf(deps)
  const known = cache.entries.get(file)
  if (known?.inflight && known.stamp === stamp) return known.inflight
  const entry: Entry =
    known?.stamp === stamp ? known : { stamp, verdict: null, at: 0, failures: 0, retryAt: 0, inflight: null }
  const inflight = windowsVerdict(() => windowsOf(deps).read(file)).then((verdict) => {
    const now = nowOf(deps)
    entry.verdict = verdict
    entry.at = now
    entry.failures = verdict.open ? entry.failures + 1 : 0
    entry.retryAt = verdict.open ? now + Math.min(FIRST_RETRY_MS * 2 ** (entry.failures - 1), MAX_RETRY_MS) : 0
    entry.inflight = null
    return verdict
  })
  entry.inflight = inflight
  cache.entries.set(file, entry)
  return inflight
}

/** A remembered verdict still good for this exact file, or null. Never asks. */
function remembered(file: string, stamp: string, deps: FilePrivacyDeps, staleOk: boolean): FilePrivacy | null {
  const entry = cacheOf(deps).entries.get(file)
  if (!entry || entry.stamp !== stamp || entry.verdict === null) return null
  const now = nowOf(deps)
  if (entry.verdict.open) return now < entry.retryAt ? entry.verdict : null
  const age = now - entry.at
  return age < PROVEN_FOR_MS || (staleOk && age < 2 * PROVEN_FOR_MS) ? entry.verdict : null
}

/**
 * Whether `file` is open to anyone but its user, and why, WITHOUT WAITING. On
 * Windows an unremembered file answers PENDING (refused) and is checked in the
 * background. Throws only what reading the file's status throws (a missing
 * file stays ENOENT for callers).
 */
export function filePrivacy(file: string, deps: FilePrivacyDeps = {}): FilePrivacy {
  const facts = statOf(deps)(file)
  if (!isWindows(deps)) return posixVerdict(facts)
  const stamp = stampOf(facts)
  const known = remembered(file, stamp, deps, true)
  if (known !== null) {
    // Past its time but within twice it: still answered, and checked again.
    if (!known.open && remembered(file, stamp, deps, false) === null) void refresh(file, stamp, deps)
    return known
  }
  void refresh(file, stamp, deps)
  return PENDING
}

/** The same question, waiting for Windows' answer when none is remembered. Rejects only as stat does. */
export async function checkFilePrivacy(file: string, deps: FilePrivacyDeps = {}): Promise<FilePrivacy> {
  const facts = statOf(deps)(file)
  if (!isWindows(deps)) return posixVerdict(facts)
  const stamp = stampOf(facts)
  return remembered(file, stamp, deps, false) ?? refresh(file, stamp, deps)
}

/** Ask afresh, whatever is remembered: after a write or a move. */
async function proveNow(file: string, deps: FilePrivacyDeps): Promise<FilePrivacy> {
  const facts = statOf(deps)(file)
  if (!isWindows(deps)) return posixVerdict(facts)
  const stamp = stampOf(facts)
  const known = cacheOf(deps).entries.get(file)
  if (known?.inflight && known.stamp === stamp) await known.inflight
  return refresh(file, stamp, deps)
}

const refused = (file: string, privacy: Exclude<FilePrivacy, { open: false }>): Error =>
  new Error(`${file} was not written: ${privacy.why} — ${privacy.fix}`)

const tempBeside = (file: string): string =>
  path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)

/** What tempBeside names, and nothing else. */
const TEMP_NAME = /^\..+\.\d+\.[0-9a-f]{12}\.tmp$/
/** A temp this old belongs to a write that will never finish. */
export const STALE_TEMP_MS = 10 * 60_000
const REMOVE_RETRIES = 3

/**
 * Remove a temp or a refused file WITHOUT replacing the error that brought us
 * here. On Windows a killed PowerShell may hold the file a moment longer, so a
 * removal that fails is tried again later, off this call.
 */
function removeQuietly(file: string, deps: FilePrivacyDeps, attempt = 0): void {
  try {
    ;(deps.remove ?? ((at: string) => rmSync(at, { force: true })))(file)
  } catch {
    if (attempt + 1 >= REMOVE_RETRIES) return
    const wait = (deps.removeRetryMs ?? 1_000) * 5 ** attempt
    setTimeout(() => removeQuietly(file, deps, attempt + 1), wait).unref?.()
  }
}

/**
 * Remove temps beside credential files that a crashed or killed write left
 * behind: the app calls it where it keeps keys, before it writes one. Only
 * names a write makes, and only ones too old to belong to a write in flight.
 */
export function sweepStaleTemps(dir: string, now: number = Date.now()): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!TEMP_NAME.test(name)) continue
    const at = path.join(dir, name)
    try {
      const facts = lstatSync(at)
      if (facts.isFile() && now - facts.mtimeMs > STALE_TEMP_MS) rmSync(at, { force: true })
    } catch {
      // Gone already, or not ours to touch: the next sweep looks again.
    }
  }
}

function posixProblem(facts: FileFacts, uid: number | undefined): string | null {
  if (uid !== undefined && facts.uid !== uid) return `it is owned by uid ${facts.uid}, not this user`
  return (facts.mode & 0o077) === 0 ? null : `it is readable by others (mode ${(facts.mode & 0o777).toString(8)})`
}

/**
 * POSIX: the temp is created 0600 with O_EXCL and written THROUGH THAT SAME
 * DESCRIPTOR, after its owner and mode are checked on the descriptor itself.
 * Once renamed over `file`, the name must hold that very file (device and
 * inode), still this user's and still private.
 */
export function writePrivateFileSync(file: string, data: string, deps: FilePrivacyDeps = {}): void {
  if (isWindows(deps)) throw new Error('writePrivateFileSync is POSIX only: Windows proves a file private asynchronously')
  const uid = (deps.uid ?? (() => process.getuid?.()))()
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = tempBeside(file)
  let made: FileFacts
  try {
    const fd = openSync(temp, 'wx', 0o600)
    try {
      fchmodSync(fd, 0o600)
      made = (deps.fstat ?? ((at: number) => factsOf(fstatSync(at))))(fd)
      const problem = posixProblem(made, uid)
      if (problem !== null) throw refused(file, { open: true, why: problem, fix: POSIX_FIX })
      // Every byte, or nothing: a write may take fewer than it was given,
      // and a key cut short is a key that never verifies again.
      const bytes = Buffer.from(data, 'utf8')
      const write = deps.write ?? ((at: number, buffer: Buffer, offset: number, length: number) => writeSync(at, buffer, offset, length))
      for (let done = 0; done < bytes.length; ) {
        const took = write(fd, bytes, done, bytes.length - done)
        if (took <= 0) throw new Error(`${file} was not written: the disk took ${done} of ${bytes.length} bytes`)
        done += took
      }
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, file)
  } catch (error) {
    removeQuietly(temp, deps)
    throw error
  }
  const placed = (deps.stat ?? ((at: string) => factsOf(lstatSync(at))))(file)
  if (placed.dev !== made.dev || placed.ino !== made.ino) {
    throw new Error(`${file} is not the file that was just written there; it was left alone`)
  }
  const problem = posixProblem(placed, uid)
  if (problem !== null) {
    removeQuietly(file, deps)
    throw refused(file, { open: true, why: problem, fix: POSIX_FIX })
  }
}

/**
 * WINDOWS: a secret is written only into a folder proven private, counting the
 * entries a new file would inherit, so nothing can be opened there by anyone
 * else at any moment. The temp is CREATED with its own exact, protected list
 * (windows-acl.ts · CREATE_PRIVATE_SCRIPT), the secret written through the
 * creating handle, then renamed over `file`, which must be that same file and
 * is proven private again. Any doubt removes what was written and throws.
 */
async function writePrivateFileWindows(file: string, data: string, deps: FilePrivacyDeps): Promise<void> {
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true })
  const folder = await windowsVerdict(() => windowsOf(deps).readFolder(dir), true)
  if (folder.open) {
    throw new Error(`${file} was not written: its folder is not private: ${folder.why} — ${folder.fix}`)
  }
  const temp = tempBeside(file)
  try {
    const made = await windowsVerdict(() => windowsOf(deps).createPrivate(temp, Buffer.from(data, 'utf8')))
    if (made.open) throw refused(file, made)
    const created = statOf(deps)(temp)
    renameSync(temp, file)
    const placed = statOf(deps)(file)
    if (placed.dev !== created.dev || placed.ino !== created.ino) {
      throw new Error(`${file} is not the file that was just written there; it was left alone`)
    }
  } catch (error) {
    // The ORIGINAL error is what the caller hears; a temp PowerShell still
    // holds is removed once it lets go (removeQuietly), or swept at startup.
    removeQuietly(temp, deps)
    throw error
  }
  const after = await proveNow(file, deps)
  if (after.open) {
    removeQuietly(file, deps)
    throw refused(file, after)
  }
}

/**
 * Write a secret so that it is kept only once its file is PROVEN private.
 * Resolves once it is; rejects, having removed what it wrote, otherwise. A
 * caller that keeps a key only after this resolves never keeps one whose file
 * failed.
 */
export async function writePrivateFile(file: string, data: string, deps: FilePrivacyDeps = {}): Promise<void> {
  if (isWindows(deps)) return writePrivateFileWindows(file, data, deps)
  writePrivateFileSync(file, data, deps)
}

/**
 * Move a proven secret to its final name in the same folder, and prove it
 * there. A move that does not prove private REJECTS but leaves the file where
 * it landed: it is refused on every read until fixed, and never deleted, since
 * it may be the only key an account has.
 */
export async function movePrivateFile(from: string, to: string, deps: FilePrivacyDeps = {}): Promise<void> {
  if (path.dirname(path.resolve(from)) !== path.dirname(path.resolve(to))) {
    throw new Error('a private file moves only within its own folder')
  }
  renameSync(from, to)
  const after = await proveNow(to, deps)
  if (after.open) throw new Error(`${to} is not private after the move: ${after.why} — ${after.fix}`)
}
