import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, statSync, writeSync } from 'node:fs'
import path from 'node:path'
import { checkFilePrivacy, writePrivateFile, type FilePrivacyDeps } from '../file-privacy'

/**
 * THE SHARE-KEYS AUDIT (Relay's ruling (a), 2026-11-19): ShareKeys may clear a key's intent with no
 * owner click once Magpie lists no key of its name, and must leave a record that it did. The record
 * is this file under ~/.cookrew: appended and synced, private to this user. It carries key names and
 * Magpie's ids only, never a key or its tail. Stderr is not enough: a packaged app started from
 * Finder drops it.
 *
 * PRIVATE ON WINDOWS TOO. Stat says 0666 for every file there, so 0600 means nothing. The log is
 * created through the private path (file-privacy.ts · writePrivateFile) with its first entry, and
 * before every later entry its owner and access list are proven (checkFilePrivacy). A log that is
 * not proven gets nothing written to it: the entry is refused, and the caller says so elsewhere.
 */

export const SHARE_AUDIT_FILE = 'share-audit.log'

const isWindows = (privacy: FilePrivacyDeps): boolean => (privacy.platform ?? process.platform) === 'win32'

/** POSIX: one append, 0600, synced; a new file's folder synced too. */
function appendPosix(file: string, entry: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const created = !existsSync(file)
  const fd = openSync(file, 'a', 0o600)
  try {
    // A file made before this one (or by hand) may be wider open than 0600.
    chmodSync(file, 0o600)
    writeSync(fd, entry)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  // A new file's name is in its folder: synced too, or a power cut can lose the first entry.
  if (created) {
    const dir = openSync(path.dirname(file), 'r')
    try {
      fsyncSync(dir)
    } finally {
      closeSync(dir)
    }
  }
}

/**
 * WINDOWS: a new log is made private from its first instant, the first entry in it. An existing one
 * is appended to only once proven private, opened WITHOUT creating (a log removed meanwhile is not
 * made again under its folder's list), and only if what was opened is the file that was proven.
 */
async function appendWindows(file: string, entry: string, privacy: FilePrivacyDeps): Promise<void> {
  if (!existsSync(file)) {
    await writePrivateFile(file, entry, privacy)
    return
  }
  const stat = privacy.stat ?? statSync
  const proven = stat(file)
  const verdict = await checkFilePrivacy(file, privacy)
  if (verdict.open) throw new Error(`${file} was not appended to: it is not private: ${verdict.why} — ${verdict.fix}`)
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND)
  try {
    const opened = (privacy.fstat ?? fstatSync)(fd)
    if (opened.dev !== proven.dev || opened.ino !== proven.ino) {
      throw new Error(`${file} was not appended to: it is not the file that was just proven private`)
    }
    writeSync(fd, entry)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * An append-only audit writer. Each call resolves once its line is written durably, and rejects when
 * it could not be (or, on Windows, when the log is not proven private). Entries are written in the
 * order they were asked for; one refused does not hold up the next.
 */
export function fileAuditLog(
  file: string,
  now: () => Date = () => new Date(),
  privacy: FilePrivacyDeps = {}
): (line: string) => Promise<void> {
  let tail: Promise<void> = Promise.resolve()
  return (line) => {
    // One entry, one line: a newline inside it must not read as an entry of its own.
    const entry = `${now().toISOString()} ${line.replace(/[\r\n]+/g, ' ')}\n`
    if (!isWindows(privacy)) {
      // Synchronous, as before: on POSIX the line is on disk when this returns.
      try {
        appendPosix(file, entry)
        return Promise.resolve()
      } catch (error) {
        return Promise.reject(error)
      }
    }
    const written = tail.then(() => appendWindows(file, entry, privacy))
    tail = written.catch(() => undefined)
    return written
  }
}
