import { readdirSync } from 'node:fs'
import path from 'node:path'
import { measureTree } from './storage-gc-tree'

/**
 * BACKUP RESIDUE — reported, never removed.
 *
 * `turns.bak-20260807-011637`, `checkpoint-annotations.bak-*`, `certs.bak-*`,
 * `lineage-restore-backup-*`, `lineage-postwrite-snapshot-*`: copies made by
 * hand or by a recovery script at the top of ~/.cookrew, 34 MB on the owner's
 * machine on 2026-09-06. The app never made them, so the app has no standing
 * to delete them — a backup is exactly the thing whose owner must be the one
 * to decide it is no longer needed. What the sweep CAN do is stop them being
 * invisible: name them, with sizes, in the result the boot log prints and the
 * perf eval reads.
 */

export interface ResidueEntry {
  path: string
  bytes: number
  files: number
  newestMtimeMs: number
}

/**
 * The names that count as residue. The same patterns perf-eval-lib's
 * `backups` bucket uses, so the two never disagree about what residue is.
 */
export function isResidueName(name: string): boolean {
  return (
    /^[^/]+\.bak-[^/]+$/.test(name) ||
    /^lineage-(restore-backup|postwrite-snapshot)-/.test(name)
  )
}

/**
 * Residue directly under `base`, measured. Top level only: that is where
 * every hand-made copy has been found, and a deeper walk would read every
 * store on the machine to answer a question about a handful of names. A
 * missing or unreadable base answers empty — a report has nothing to abort.
 */
export function scanResidue(base: string): ResidueEntry[] {
  let entries
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    return []
  }
  const out: ResidueEntry[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !isResidueName(entry.name)) continue
    const full = path.join(base, entry.name)
    try {
      const { bytes, files, newestMtimeMs } = measureTree(full)
      out.push({ path: full, bytes, files, newestMtimeMs })
    } catch {
      // Removed while we looked. Not residue any more.
    }
  }
  return out.sort((a, b) => b.bytes - a.bytes)
}
