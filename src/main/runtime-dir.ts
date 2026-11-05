import { lstatSync } from 'node:fs'
import path from 'node:path'

/**
 * WHERE THE SOCKET AND THE CLI LIVE. Fixed, not per process, so a session's baked
 * paths stay valid across restarts.
 *
 * On macOS the temp dir is the user's own. On Linux it is /tmp, shared: a second
 * user hit EACCES on the first's dir and got a black screen (round 2, bug 13). So
 * Linux gets a dir per user, except for the user who already owns the old one:
 * their panes have that path baked in. In a shared tmp a name can be planted, so
 * a per-user dir somebody else holds is a stop, not a dir to use.
 */

export interface RuntimeDirFacts {
  tmp: string
  platform: string
  /** Null where the platform has no uid. */
  uid: number | null
  /** Who owns this path; null when it does not exist. */
  ownerOf: (dir: string) => number | null
}

export function runtimeDirFor({ tmp, platform, uid, ownerOf }: RuntimeDirFacts): string {
  const shared = path.join(tmp, 'cookrew-runtime')
  if (platform !== 'linux' || uid === null || ownerOf(shared) === uid) return shared
  const own = `${shared}-${uid}`
  const owner = ownerOf(own)
  if (owner !== null && owner !== uid) throw Object.assign(new Error(`${own} belongs to another user`), { code: 'EACCES', path: own })
  return own
}

/** Who owns a path, a link as itself: a planted link must not borrow its target's owner. Null when absent. */
export function ownerOf(dir: string): number | null {
  try {
    return lstatSync(dir).uid
  } catch {
    return null
  }
}
