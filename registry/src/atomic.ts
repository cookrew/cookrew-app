import { renameSync, writeFileSync } from 'node:fs'

/**
 * WRITE IT WHOLE, OR NOT AT ALL — and never world-readable.
 *
 * Two failures this exists to stop, both of which read as data loss rather
 * than as a crash.
 *
 * A TORN FILE. `writeFileSync` truncates first and writes second, so a process
 * killed between the two leaves a half file. For the accounts store that is a
 * file whose every revocation has silently reverted; for the token key it is a
 * registry that can no longer verify anything it signed. Writing a sibling and
 * renaming makes the swap atomic on any POSIX filesystem: a reader sees the old
 * file or the new one, never half of either.
 *
 * THE MODE. These files hold a signing key and the public keys that decide who
 * may act for an account. The default 0644 puts both in front of every other
 * user on the host, which on a shared box is the whole registry.
 */
export function writeFileAtomic(file: string, data: string): void {
  const temporary = `${file}.tmp`
  writeFileSync(temporary, data, { mode: 0o600 })
  renameSync(temporary, file)
}
