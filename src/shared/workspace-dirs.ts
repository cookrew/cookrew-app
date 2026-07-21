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

export interface DirOwnerCandidate {
  id: string
  dirs: string[]
}

const stripTrailingSlash = (p: string): string =>
  p.length > 1 ? p.replace(/\/+$/, '') : p

/**
 * The workspace owning a directory: a dir is owned by a workspace whose dirs
 * list contains it or a parent of it; the LONGEST matching prefix across all
 * candidates wins (deepest-anchored workspace). Ties keep the earlier
 * candidate — callers order the orch home first. Null when nobody owns it.
 */
export function resolveDirOwner(candidates: DirOwnerCandidate[], dir: string): string | null {
  const target = stripTrailingSlash(dir.trim())
  let best: string | null = null
  let bestLen = -1
  for (const candidate of candidates) {
    for (const owned of candidate.dirs) {
      const prefix = stripTrailingSlash(owned)
      const matches = target === prefix || target.startsWith(`${prefix}/`)
      if (matches && prefix.length > bestLen) {
        best = candidate.id
        bestLen = prefix.length
      }
    }
  }
  return best
}

/**
 * Recruit --dir routing (cross-workspace-orch-fix-dec layer 2): route to the
 * workspace owning the dir; an unowned dir is auto-added to the orch HOME
 * workspace (never silently spawned with a cwd outside its workspace).
 */
export function planRecruitTarget(
  candidates: DirOwnerCandidate[],
  homeId: string,
  dir: string | null
): { workspaceId: string; autoAddDir: string | null } {
  if (!dir) return { workspaceId: homeId, autoAddDir: null }
  const owner = resolveDirOwner(candidates, dir)
  return owner !== null
    ? { workspaceId: owner, autoAddDir: null }
    : { workspaceId: homeId, autoAddDir: dir }
}
