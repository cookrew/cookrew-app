// Pure directory-list transforms for the multi-directory workspace model.
// Kept out of the store so the guards (last-dir, in-use, membership) are
// unit-testable without touching real ~/.cookrew data. All return a NEW
// ordered list (primary first) or throw a user-facing error.

import { normalizeDirs } from './model'

/** Append a directory; throws on empty input. Deduped, order preserved. */
export function addDir(dirs: string[], dir: string): string[] {
  const trimmed = dir.trim()
  if (trimmed.length === 0) throw new Error('Directory path must not be empty')
  return normalizeDirs({ dirs: [...dirs, trimmed] })
}

/**
 * Remove a directory. Throws if it isn't in the set, if it's the last one, or
 * if it's currently used by a live terminal (`inUse`).
 */
export function removeDir(dirs: string[], dir: string, inUse: boolean): string[] {
  if (!dirs.includes(dir)) throw new Error(`'${dir}' is not a directory of this workspace`)
  if (dirs.length <= 1) throw new Error('Cannot remove the last directory')
  if (inUse) throw new Error('Cannot remove a directory a live terminal is using')
  return dirs.filter((d) => d !== dir)
}

/** Reorder so `dir` becomes primary (front). Throws if not a member. */
export function setPrimary(dirs: string[], dir: string): string[] {
  if (!dirs.includes(dir)) throw new Error(`'${dir}' is not a directory of this workspace`)
  return [dir, ...dirs.filter((d) => d !== dir)]
}
