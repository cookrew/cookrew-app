import { readdirSync, type Dirent } from 'node:fs'
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
 * The names that count as residue, at any depth. The same patterns
 * perf-eval-lib's `backups` bucket uses, so the two never disagree about
 * what residue is — and the sweep's other classes consult this too, so a
 * `turns/<id>.jsonl.bak-…` is never mistaken for a ledger and collected.
 */
export function isResidueName(name: string): boolean {
  return (
    /^[^/]+\.bak-[^/]+$/.test(name) ||
    /^lineage-(restore-backup|postwrite-snapshot)-/.test(name)
  )
}

/**
 * Directories the report does not look inside. Served sandboxes are a
 * stranger's HOME, and a `foo.bak-1` a caller's agent made there is theirs,
 * not the owner's residue; the sweep's served class handles that directory
 * as a unit anyway.
 */
const NOT_WALKED = new Set(['sessions'])

/**
 * Residue anywhere under `base`, measured, largest first. Recursive because
 * the copies are not only at the top: the live store holds
 * `turns/<id>.jsonl.bak-*` and `workspaces/<id>/workspace.json.bak-*` too,
 * and a report that missed them would let the sweep collect one as an
 * ordinary ledger while the boot log said backups are never removed. A
 * residue entry is measured whole and not descended into (a backup of a
 * backup is one thing). The walk is readdir + stat only — a quarter second
 * over the owner's 3,400 entries — and a directory that cannot be read
 * contributes nothing: a report has nothing to abort.
 */
export function scanResidue(base: string): ResidueEntry[] {
  const out: ResidueEntry[] = []
  const visit = (dir: string, top: boolean): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (isResidueName(entry.name)) {
        try {
          const { bytes, files, newestMtimeMs } = measureTree(full)
          out.push({ path: full, bytes, files, newestMtimeMs })
        } catch {
          // Removed or unreadable while we looked. Not reportable.
        }
        continue
      }
      if (entry.isDirectory() && !(top && NOT_WALKED.has(entry.name))) visit(full, false)
    }
  }
  visit(base, true)
  return out.sort((a, b) => b.bytes - a.bytes)
}
