import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs'
import path from 'node:path'

/**
 * THE SHARE-KEYS AUDIT (Relay's ruling (a), 2026-11-19): ShareKeys may clear a key's intent with no
 * owner click once Magpie lists no key of its name, and must leave a record that it did. The record
 * is this file under ~/.cookrew: appended and synced, 0600. It carries key names and Magpie's ids
 * only, never a key or its tail. Stderr is not enough: a packaged app started from Finder drops it.
 */

export const SHARE_AUDIT_FILE = 'share-audit.log'

/** An append-only audit writer; each call throws when the line could not be written durably. */
export function fileAuditLog(file: string, now: () => Date = () => new Date()): (line: string) => void {
  return (line) => {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    // One entry, one line: a newline inside it must not read as an entry of its own.
    const entry = `${now().toISOString()} ${line.replace(/[\r\n]+/g, ' ')}\n`
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
    if (created && process.platform !== 'win32') {
      const dir = openSync(path.dirname(file), 'r')
      try {
        fsyncSync(dir)
      } finally {
        closeSync(dir)
      }
    }
  }
}
