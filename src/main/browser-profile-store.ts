import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'

/** Resolve one generated browser id under the profile root, never beside it. */
export function browserProfilePath(root: string, browserId: string): string {
  const resolvedRoot = path.resolve(root)
  if (!browserId || path.basename(browserId) !== browserId || browserId === '.' || browserId === '..') {
    throw new Error('Invalid browser profile id')
  }
  const target = path.resolve(resolvedRoot, browserId)
  if (path.dirname(target) !== resolvedRoot) throw new Error('Browser profile escaped its root')
  return target
}

/** Delete one retired node's profile. Symlinks and non-directories are never followed. */
export function removeBrowserProfile(root: string, browserId: string): boolean {
  const target = browserProfilePath(root, browserId)
  if (!existsSync(target)) return false
  const stat = lstatSync(target)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false
  rmSync(target, { recursive: true, force: true })
  return true
}

/**
 * Reap profiles that no workspace owns. The caller must supply a strict,
 * fail-closed ownership set; this function only removes direct child dirs.
 */
export function reapOrphanBrowserProfiles(
  root: string,
  ownedBrowserIds: Iterable<string>,
): string[] {
  if (!existsSync(root)) return []
  const owned = new Set(ownedBrowserIds)
  const removed: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || owned.has(entry.name)) continue
    if (removeBrowserProfile(root, entry.name)) removed.push(entry.name)
  }
  return removed
}
