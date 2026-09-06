import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/** What a directory (or a single file) weighs, and when it was last written. */
export interface TreeMeasure {
  bytes: number
  files: number
  /** The newest mtime over the entry itself and everything beneath it. */
  newestMtimeMs: number
}

/**
 * Measure an entry without following symlinks.
 *
 * The directory's own mtime counts: a directory whose files were all removed
 * a minute ago has a fresh mtime and no fresh files, and "somebody touched
 * this recently" is the fact a grace period is asked about. Symlinks are
 * skipped rather than followed, because a link out of a sandbox would make
 * the sandbox look as big — and as recent — as whatever it points at.
 */
export function measureTree(entry: string): TreeMeasure {
  const self = statSync(entry)
  if (!self.isDirectory()) return { bytes: self.size, files: 1, newestMtimeMs: self.mtimeMs }
  let bytes = 0
  let files = 0
  let newest = self.mtimeMs
  for (const child of readdirSync(entry, { withFileTypes: true })) {
    if (child.isSymbolicLink()) continue
    const full = path.join(entry, child.name)
    let measured: TreeMeasure
    try {
      measured = measureTree(full)
    } catch {
      // Removed between readdir and stat — the store is live. Skip it.
      continue
    }
    bytes += measured.bytes
    files += measured.files
    if (measured.newestMtimeMs > newest) newest = measured.newestMtimeMs
  }
  return { bytes, files, newestMtimeMs: newest }
}
